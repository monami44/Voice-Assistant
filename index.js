// index.js

import dotenv from "dotenv";
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '.env') });

console.log("Environment variables loaded:");
// ... (Environment variable logs)

import fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";
import twilio from 'twilio';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import { google } from 'googleapis';
import * as chrono from 'chrono-node';

// Import database utilities
import {
    dbCreateOrGetUser,
    dbUpdateUserName,
    dbUpdateUserEmail,
    dbCreateConversation,
    dbUpdateConversation,
    dbFinalizeConversation,
    dbGetLastConversation,
    dbCreateBooking,
    dbUpdateBookingState,
    extractEmailFromSummary
} from './database-utils.js';

// Initialize Twilio client
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Initialize Google OAuth2 Client
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

// Set Refresh Token
oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

// Initialize Google Calendar API
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// Other constants and configurations
const PORT = process.env.PORT || 5050;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VOICE = process.env.VOICE || "shimmer";
const SYSTEM_MESSAGE = `You are an AI assistant designed as a Pokémon Master named Marcus. You have access to a vast knowledge base containing detailed information about all Pokémon, their abilities, types, evolutions, and related game mechanics.

Key Guidelines:
- For ANY question related to Pokémon, you MUST check the knowledge base first.
- Tell the user you're checking your Pokédex (which is your knowledge base) before answering.
- Provide accurate and detailed answers about Pokémon, their characteristics, and the Pokémon world.
- If you are unsure or need more information, tell the user "Let me check my Pokédex for that information." and use 'access_knowledge_base' to reference your knowledge base.
- Keep your responses clear, informative, and in the style of an enthusiastic Pokémon expert.
- Don't reveal any technical details about the knowledge base or how you're accessing the information.
- Be friendly and excited about sharing Pokémon knowledge!
- For scheduling training sessions:
  * When a user requests to schedule, first ask for their preferred time
  * When collecting email:
    - If they have a stored email, ask if they want to use it
    - If they confirm stored email, proceed with booking
    - If they decline stored email or don't have one, ask them to spell out their email address
  * Always verify email accuracy by spelling it back to them before proceeding
  * Only schedule after email confirmation
- Make the conversation natural and engaging while following these guidelines.`;

const LOG_EVENT_TYPES = [
    "response.content.done",
    "response.function_call_arguments.done",
    "input_audio_buffer.committed",
    "input_audio_buffer.speech_stopped",
    "input_audio_buffer.speech_started",
    "session.created",
    "response.audio_transcript.done"
];

// Initial User Messages
const INITIAL_USER_MESSAGE = "Respond with exactly this greeting: 'Hey trainer! My name is Marcus, it's nice to meet you. What is your name?' Do not add any other content to your response.";
const RETURNING_USER_MESSAGE_TEMPLATE = "Nice to see you again, {name}! Your last conversation was about {lastTopic}. Do you want to continue that topic or do you have another question?";

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase URL or Key is missing. Please check your .env file.');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize Fastify
const fastifyInstance = fastify({ logger: true });
fastifyInstance.register(fastifyWebsocket);

// Routes
fastifyInstance.get("/", async (_, reply) =>
    reply.send({ message: "AI Assistant With a Brain is Alive!" }),
);

fastifyInstance.all("/incoming-call", async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
            <Connect>
                <Stream url="wss://${request.headers.host}/media-stream" />
            </Connect>
        </Response>`;
    reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for media-stream
fastifyInstance.register(async (fastifyInstance) => {
    fastifyInstance.get("/media-stream", { websocket: true }, (connection, _) => {
        console.log("Client connected");
        const openAiWs = initializeOpenAiWebSocket();
        let streamSid = null;
        let callSid = null;  // To track the call SID

        // Send initial session update after connection is stable
        openAiWs.on("open", () => {
            console.log("Connected to OpenAI Realtime API");
            setTimeout(() => sendSessionUpdate(openAiWs), 250);
        });

        // OpenAI WebSocket message handler
        openAiWs.on("message", (data) =>
            handleOpenAiMessage(openAiWs, data, connection, streamSid),
        );

        // Handle incoming messages from Twilio WebSocket
        connection.on("message", (message) =>
            handleTwilioMessage(message, openAiWs, (sid) => { streamSid = sid; }, (cid) => { callSid = cid; })
        );

        // Clean up on connection close
        connection.on("close", () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log("Client disconnected.");
        });

        // Handle OpenAI WebSocket close and error events
        openAiWs.on("close", () =>
            console.log("Disconnected from OpenAI Realtime API"),
        );
        openAiWs.on("error", (error) =>
            console.error("OpenAI WebSocket error:", error),
        );
    });
});

// Retry configuration
const RETRY_OPTIONS = {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 5000
};

async function withRetry(operation, options = RETRY_OPTIONS) {
    let lastError;
    for (let i = 0; i < options.maxRetries; i++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            console.error(`Operation failed (attempt ${i + 1}/${options.maxRetries}):`, error);
            
            if (i < options.maxRetries - 1) {
                const delay = Math.min(
                    options.baseDelay * Math.pow(2, i),
                    options.maxDelay
                );
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}

// Retry-enabled versions of database functions
const createOrGetUserWithRetry = (phoneNumber) => withRetry(() => dbCreateOrGetUser(phoneNumber));
const updateUserNameWithRetry = (phoneNumber, name) => withRetry(() => dbUpdateUserName(phoneNumber, name));
const updateUserEmailWithRetry = (phoneNumber, email) => withRetry(() => dbUpdateUserEmail(phoneNumber, email));
const createConversationWithRetry = (phoneNumber, callSid) => withRetry(() => dbCreateConversation(phoneNumber, callSid)); // Updated
const updateConversationWithRetry = (conversationId, updates) => withRetry(() => dbUpdateConversation(conversationId, updates));
const finalizeConversationInDbWithRetry = (conversationId, fullDialogue, summary) => withRetry(() => dbFinalizeConversation(conversationId, fullDialogue, summary));
const getLastConversationWithRetry = (phoneNumber) => withRetry(() => dbGetLastConversation(phoneNumber));
const createBookingWithRetry = (phoneNumber, conversationId, eventId, time, email) => withRetry(() => dbCreateBooking(phoneNumber, conversationId, eventId, time, email));
const updateBookingStateWithRetry = (bookingId, state) => withRetry(() => dbUpdateBookingState(bookingId, state));

// Add error handling for WebSocket connections
function setupWebSocketErrorHandling(ws) {
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        try {
            if (ws.conversationId) {
                updateConversation(ws.conversationId, {
                    end_timestamp: new Date().toISOString(),
                    error_log: JSON.stringify(error)
                }).catch(console.error);
            }
        } catch (e) {
            console.error('Error handling WebSocket error:', e);
        }
    });

    ws.on('close', async () => {
        try {
            if (ws.conversationId) {
                await finalizeConversation(ws); // Corrected invocation
            }
        } catch (e) {
            console.error('Error handling WebSocket close:', e);
        }
    });

    return ws;
}

// Modified openAiWs initialization to include error handling
function initializeOpenAiWebSocket() {
    const ws = new WebSocket(
        process.env.AZURE_OPENAI_REALTIME_ENDPOINT,
        {
            headers: {
                "api-key": process.env.AZURE_OPENAI_REALTIME_API_KEY,
            },
        },
    );
    
    // Add base properties
    ws.fullDialogue = "";
    ws.awaitingName = true;
    ws.phoneNumber = null;
    ws.lastUserMessage = null;
    ws.conversationId = null;
    ws.sessionReady = false;
    ws.sendingFunctionCallOutput = false;
    ws.bookingState = 'idle';
    ws.preferred_time = null;
    ws.email = null;

    // Setup error handling
    return setupWebSocketErrorHandling(ws);
}

// Modified updateLastConversation function to use retry mechanism
async function updateLastConversation(ws, phoneNumber, question, answer) {
    if (!ws.conversationId) {
        console.error("No conversation ID available");
        return;
    }

    console.log(`Updating conversation for ${phoneNumber}`);
    console.log(`Question: ${question}`);
    console.log(`Answer: ${answer}`);
    
    await updateConversationWithRetry(ws.conversationId, {
        last_question: question || 'No question',
        last_answer: answer
    });
}

// Function to send session update to OpenAI WebSocket
function sendSessionUpdate(ws) {
    const sessionUpdate = {
        type: "session.update",
        session: {
            turn_detection: {
                type: "server_vad",
                threshold: 0.3,
                silence_duration_ms: 1000,
            },
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            voice: VOICE,
            instructions: SYSTEM_MESSAGE,
            tools: [
                {
                    type: "function",
                    name: "access_knowledge_base",
                    description: "Access the knowledge base to answer the user's question.",
                    parameters: {
                        type: "object",
                        properties: {
                            question: {
                                type: "string",
                                description: "The question to ask the knowledge base.",
                            },
                        },
                        required: ["question"],
                        additionalProperties: false,
                    },
                },
                {
                    type: "function",
                    name: "schedule_training_session",
                    description: "Schedule a training session for the user by collecting necessary details such as time and email.",
                    parameters: {
                        type: "object",
                        properties: {
                            preferred_time: {
                                type: "string",
                                description: "The preferred time for the training session in ISO 8601 format.",
                            },
                            email: {
                                type: "string",
                                description: "The user's email address to send meeting details.",
                            },
                        },
                        required: ["preferred_time", "email"],
                        additionalProperties: false,
                    },
                },
            ],
            modalities: ["text", "audio"],
            temperature: 0.7,
            input_audio_transcription: {
                model: "whisper-1",
            },
        },
    };
    console.log("Sending session update:", JSON.stringify(sessionUpdate));
    ws.send(JSON.stringify(sessionUpdate));
}

// Function to handle messages from OpenAI WebSocket
async function handleOpenAiMessage(openAiWs, data, connection, streamSid) {
    try {
        const response = JSON.parse(data);

        if (response.type === "session.created") {
            console.log("Session created:", response);
            sendSessionUpdate(openAiWs);
        }

        if (response.type === "session.updated") {
            console.log("Session updated successfully:", response);
            openAiWs.sessionReady = true;
            if (openAiWs.callSid) {
                await handleIncomingCall(openAiWs.callSid, openAiWs);
            } else {
                console.log("Call SID not set, waiting for incoming call");
            }
        }

        // Handle 'input_audio_buffer.speech_started' event to interrupt AI speech
        if (response.type === "input_audio_buffer.speech_started") {
            console.log("Speech Start:", response.type);
            // Clear any ongoing speech on Twilio side
            connection.send(
                JSON.stringify({
                    streamSid: streamSid,
                    event: "clear",
                }),
            );
            console.log("Cancelling AI speech from the server");

            // Send interrupt message to OpenAI to cancel ongoing response
            const interruptMessage = {
                type: "response.cancel",
            };
            openAiWs.send(JSON.stringify(interruptMessage));
        }

        if (LOG_EVENT_TYPES.includes(response.type)) {
            console.log(`Received event: ${response.type}`, response);
        }

        if (response.type === "response.function_call_arguments.done") {
            console.log("Function called successfully:", response);

            const functionName = response.name;

            if (functionName === "access_knowledge_base") {
                // Existing logic for accessing knowledge base
                const functionArgs = JSON.parse(response.arguments);
                const question = functionArgs.question;

                console.log("AI is accessing knowledge base for question:", question);

                // Inform the user that the assistant is checking the knowledge base
                const checkingMessage = "Give me a second, I'm checking my knowledge.";
                openAiWs.send(
                    JSON.stringify({
                        type: "conversation.item.create",
                        item: {
                            type: "assistant",
                            content: checkingMessage,
                            modalities: ["text", "audio"],
                        },
                    }),
                );

                // Append AI's intermediate message to fullDialogue
                openAiWs.fullDialogue += `AI: ${checkingMessage}\n`;

                // Call the Supabase assistant
                const answer = await askSupabaseAssistant(question);

                if (answer) {
                    console.log("Sending knowledge base answer to OpenAI:", answer);
                    openAiWs.send(
                        JSON.stringify({
                            type: "conversation.item.create",
                            item: {
                                type: "function_call_output",
                                output: answer,
                            },
                        }),
                    );

                    openAiWs.send(
                        JSON.stringify({
                            type: "response.create",
                            response: {
                                modalities: ["text", "audio"],
                                instructions: `Based on the knowledge base, provide a concise summary of the following information: ${answer}`,
                                voice: VOICE,
                                temperature: 0.7,
                                max_output_tokens: 150,
                            },
                        }),
                    );

                    console.log("Knowledge base answer provided to OpenAI");

                    // **Do NOT append function call outputs**
                    // openAiWs.fullDialogue += `AI: ${answer}\n`;

                    // Set flag to skip appending function call outputs
                    openAiWs.sendingFunctionCallOutput = true;
                } else {
                    console.log("No answer from knowledge base, AI will use its general knowledge.");
                    // Handle the case where the Supabase query failed
                    const fallbackMessage = "I'm sorry, I couldn't access the knowledge base at this time.";
                    openAiWs.send(
                        JSON.stringify({
                            type: "conversation.item.create",
                            item: {
                                type: "assistant",
                                content: fallbackMessage,
                                modalities: ["text", "audio"],
                            },
                        }),
                    );

                    // Append fallback message to fullDialogue
                    openAiWs.fullDialogue += `AI: ${fallbackMessage}\n`;
                }
            }

            if (functionName === "schedule_training_session") {
                // Handle scheduling logic
                const functionArgs = JSON.parse(response.arguments);
                const preferredTime = functionArgs.preferred_time;
                const email = functionArgs.email;

                console.log("Scheduling training session for:", preferredTime, email);

                // Proceed to schedule the session using Google Calendar API
                const bookingSuccess = await bookTrainingSession(openAiWs, preferredTime, email);

                if (bookingSuccess) {
                    const prompt = "Your training session has been booked successfully! I've sent the meeting details to your email. Looking forward to your training session!";
                    openAiWs.send(JSON.stringify({
                        type: "response.create",
                        response: {
                            modalities: ["text", "audio"],
                            instructions: prompt,
                            voice: VOICE,
                            temperature: 0.7,
                            max_output_tokens: 150,
                        },
                    }));
                    openAiWs.bookingState = 'idle';
                    await updateBookingStateWithRetry(openAiWs.phoneNumber, 'idle');
                } else {
                    const prompt = "I'm sorry, I encountered an issue while booking your training session. Please try again later.";
                    openAiWs.send(JSON.stringify({
                        type: "response.create",
                        response: {
                            modalities: ["text", "audio"],
                            instructions: prompt,
                            voice: VOICE,
                            temperature: 0.7,
                            max_output_tokens: 150,
                        },
                    }));
                    openAiWs.bookingState = 'idle';
                    await updateBookingStateWithRetry(openAiWs.phoneNumber, 'idle');
                }
            }
        }

        if (response.type === "response.audio.delta" && response.delta) {
            // Send audio delta as-is
            const audioDelta = {
                event: "media",
                streamSid: streamSid,
                media: {
                    payload: response.delta,
                },
            };
            connection.send(JSON.stringify(audioDelta));
        }

        if (response.type === "response.content.done") {
            if (!openAiWs.sendingFunctionCallOutput) {
                console.log("AI final response:", response.content);
                openAiWs.fullDialogue += `AI: ${response.content}\n`;

                // Update last conversation
                await updateLastConversation(openAiWs, openAiWs.phoneNumber, openAiWs.lastUserMessage, response.content);

                // Handle booking flow based on booking_state
                const bookingState = openAiWs.bookingState;
                if (bookingState === 'idle') {
                    if (response.content.toLowerCase().includes('training session') || response.content.toLowerCase().includes('book a training') || response.content.toLowerCase().includes('schedule a training')) {
                        await askForSuitableTime(openAiWs);
                    }
                } else if (bookingState === 'awaiting_time') {
                    // Handle time input
                    const parsedTime = parseUserTime(response.content);
                    if (parsedTime) {
                        openAiWs.preferred_time = parsedTime;
                        await updateBookingStateWithRetry(openAiWs.phoneNumber, 'awaiting_email');
                        await askForEmail(openAiWs);
                    } else {
                        const prompt = "I'm sorry, I couldn't understand the time you provided. Could you please specify a different time that suits you?";
                        openAiWs.send(JSON.stringify({
                            type: "response.create",
                            response: {
                                modalities: ["text", "audio"],
                                instructions: prompt,
                                voice: VOICE,
                                temperature: 0.7,
                                max_output_tokens: 150,
                            },
                        }));
                    }
                } else if (bookingState === 'confirm_email') {
                    // Handle email confirmation
                    const confirmation = response.content.trim().toLowerCase();
                    const email = openAiWs.email;
                    await handleEmailConfirmation(openAiWs, confirmation, email);
                }
            } else {
                console.log("Skipping appending AI function call output to fullDialogue");
                openAiWs.sendingFunctionCallOutput = false; // Reset the flag
            }
        }

        // **Handle AI's Transcribed Responses**
        if (response.type === "response.audio_transcript.done") {
            console.log("AI transcription completed:", response.transcript);
            const aiTranscribedText = response.transcript;

            // Append AI's transcribed message to fullDialogue
            openAiWs.fullDialogue += `AI: ${aiTranscribedText}\n`;
            console.log("AI message from transcription:", aiTranscribedText);

            // Update last conversation
            await updateLastConversation(openAiWs, openAiWs.phoneNumber, openAiWs.lastUserMessage, aiTranscribedText);
        }

        // **Handle Transcription Completion Event for User Messages**
        if (response.type === "conversation.item.input_audio_transcription.completed") {
            console.log("Transcription completed:", response.transcript);
            const transcribedText = response.transcript;

            // Sanitize and validate User message
            if (transcribedText && transcribedText.trim() !== "") {
                const sanitizedText = sanitizeInput(transcribedText);
                console.log("Appending User message:", sanitizedText);
                openAiWs.fullDialogue += `User: ${sanitizedText}\n`;
                openAiWs.lastUserMessage = sanitizedText;
            } else {
                console.log("Received empty or invalid User message. Skipping append.");
            }

            // Proceed with handling the User message based on booking_state
            const bookingState = openAiWs.bookingState;
            if (bookingState === 'awaiting_time') {
                const parsedTime = parseUserTime(transcribedText);
                if (parsedTime) {
                    openAiWs.preferred_time = parsedTime;
                    await updateBookingStateWithRetry(openAiWs.phoneNumber, 'awaiting_email');
                    await askForEmail(openAiWs);
                } else {
                    const prompt = "I'm sorry, I couldn't understand the time you provided. Could you please specify a different time that suits you?";
                    openAiWs.send(JSON.stringify({
                        type: "response.create",
                        response: {
                            modalities: ["text", "audio"],
                            instructions: prompt,
                            voice: VOICE,
                            temperature: 0.7,
                            max_output_tokens: 150,
                        },
                    }));
                    console.log("Appended AI prompt for time clarification to fullDialogue:", `AI: ${prompt}`);
                }
            } else if (bookingState === 'awaiting_email') {
                // Handle email input
                const email = reconstructEmail(transcribedText);
                if (validateEmail(email)) {
                    openAiWs.email = email; // Store the user's email
                    await updateBookingStateWithRetry(openAiWs.phoneNumber, 'confirm_email');
                    await confirmEmail(openAiWs, email);
                } else {
                    const prompt = "The email address you provided doesn't seem to be valid. Could you please spell it out again?";
                    openAiWs.send(JSON.stringify({
                        type: "response.create",
                        response: {
                            modalities: ["text", "audio"],
                            instructions: prompt,
                            voice: VOICE,
                            temperature: 0.7,
                            max_output_tokens: 150,
                        },
                    }));
                    console.log("Appended AI prompt for email re-entry to fullDialogue:", `AI: ${prompt}`);
                }
            } else if (bookingState === 'confirm_email') {
                // Capture confirmation response
                const confirmation = transcribedText.trim().toLowerCase();
                const email = openAiWs.email;
                await handleEmailConfirmation(openAiWs, confirmation, email);
            } else if (bookingState === 'confirm_existing_email') {
                const confirmation = transcribedText.trim().toLowerCase();
                await handleExistingEmailConfirmation(openAiWs, confirmation);
            }

            // Update last conversation
            await updateLastConversation(openAiWs, openAiWs.phoneNumber, openAiWs.lastUserMessage, null);
        }

    } catch (error) {
        console.error(
            "Error processing OpenAI message:",
            error,
            "Raw message:",
            data,
        );
    }
}

// Helper function to sanitize inputs
function sanitizeInput(input) {
    // Remove any unwanted characters or patterns
    return input.replace(/[\n\r]/g, ' ').trim();
}

// Function to interact with Supabase for the knowledge base
async function askSupabaseAssistant(question) {
    console.log("Querying knowledge base for:", question);
    try {
        // Generate embedding for the question using Azure OpenAI's Embedding API
        const embeddingResponse = await fetch(`${process.env.AZURE_OPENAI_CHAT_ENDPOINT}/embeddings`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "api-key": process.env.AZURE_OPENAI_CHAT_API_KEY,
            },
            body: JSON.stringify({
                input: question,
                model: "text-embedding-ada-002",
            }),
        });

        if (!embeddingResponse.ok) {
            console.error("Error fetching embedding from Azure OpenAI:", embeddingResponse.statusText);
            return null;
        }

        const embeddingData = await embeddingResponse.json();
        const queryEmbedding = embeddingData.data[0].embedding;

        const { data, error } = await supabase.rpc('search_documents', { query_embedding: queryEmbedding });

        if (error) {
            console.error("Error querying Supabase:", error.message);
            return null;
        }

        if (data && data.length > 0) {
            console.log("Knowledge base answers found:", data);
            // Combine context and relevant metadata for a more informative answer
            const combinedAnswer = data.map(item => {
                const metadataStr = Object.entries(item.metadata)
                    .map(([key, value]) => `${key}: ${value}`)
                    .join(', ');
                return `${item.context} (${metadataStr})`;
            }).join('\n');
            return combinedAnswer;
        } else {
            console.log("No relevant documents found in Supabase.");
            return null;
        }
    } catch (error) {
        console.error("Error in askSupabaseAssistant:", error);
        return null;
    }
}

// Handle messages from Twilio WebSocket
function handleTwilioMessage(message, openAiWs, setStreamSid, setCallSid) {
    try {
        const data = JSON.parse(message);

        switch (data.event) {
            case "media":
                if (openAiWs.readyState === WebSocket.OPEN) {
                    const audioAppend = {
                        type: "input_audio_buffer.append",
                        audio: data.media.payload,
                    };
                    openAiWs.send(JSON.stringify(audioAppend));
                }
                break;
            case "start":
                setStreamSid(data.start.streamSid);
                setCallSid(data.start.callSid);
                openAiWs.callSid = data.start.callSid;
                console.log("Incoming stream started:", data.start.streamSid);
                console.log("Call SID:", data.start.callSid);
                break;
            case "stop":
                console.log("Call ended");
                finalizeConversation(openAiWs);
                break;
            default:
                console.log("Received non-media event:", data.event);
                break;
        }
    } catch (error) {
        console.error("Error parsing Twilio message:", error);
    }
}

// Constants for AI prompts
const NEW_USER_PROMPT = "You are Marcus, a friendly Pokémon trainer AI assistant. Introduce yourself briefly and ask for the user's name.";

// Function to handle incoming calls
async function handleIncomingCall(callSid, openAiWs) {
    if (!callSid) {
        console.error("Call SID is undefined");
        return;
    }

    try {
        // Fetch call details from Twilio API
        const call = await twilioClient.calls(callSid).fetch();
        const phoneNumber = call.from;

        // Store the phone number
        openAiWs.phoneNumber = phoneNumber;

        // Create or get user with retry
        const user = await createOrGetUserWithRetry(phoneNumber);
        if (!user) {
            throw new Error("Failed to create or get user");
        }

        // Create new conversation with conversation_id set to callSid
        const conversation = await createConversationWithRetry(phoneNumber, callSid);
        if (!conversation) {
            throw new Error("Failed to create conversation");
        }
        openAiWs.conversationId = conversation.conversation_id;

        console.log(`Handling incoming call from ${phoneNumber} with Call SID: ${callSid}`);

        // Get last conversation for context
        const lastConversation = await getLastConversationWithRetry(phoneNumber);
        console.log("Last conversation data:", lastConversation);
        console.log("User details:", user);

        let prompt;
        if (user.name) {
            const lastTopic = lastConversation?.summary 
                ? summarizeLastTopic(lastConversation.summary)  // New helper function
                : "our introduction";
            
            prompt = RETURNING_USER_MESSAGE_TEMPLATE
                .replace('{name}', user.name)
                .replace('{lastTopic}', lastTopic);
            console.log("Generated returning user prompt:", prompt);
            sendUserMessage(openAiWs, prompt, true);
        } else {
            prompt = NEW_USER_PROMPT;
            console.log("Generated new user prompt:", prompt);
            sendUserMessage(openAiWs, prompt);
        }

    } catch (error) {
        console.error("Error handling incoming call:", error);
    }
}

// Function to send the initial greeting as a user message
function sendUserMessage(openAiWs, prompt, isReturningUser = false) {
    console.log("Sending AI prompt:", prompt);
    openAiWs.send(JSON.stringify({
        type: "response.create",
        response: {
            modalities: ["text", "audio"],
            instructions: prompt,
            voice: VOICE,
            temperature: 0.7,
            max_output_tokens: 300,
        },
    }));

    // We don't append anything to fullDialogue here, as we're waiting for the AI's response
}

// New helper function to clean up the summary (in index.js)
function summarizeLastTopic(summary) {
    // Remove common prefixes that might appear in summaries
    let cleanSummary = summary
        .replace(/^The user |^User |^The AI |^AI /, '')
        .replace(/asked (about|for) /, '')
        .replace(/^The conversation was about /, '');

    // Extract the main topic, typically before the first period or detailed explanation
    const mainTopic = cleanSummary.split('.')[0].trim();
    
    // If the topic is too long, try to shorten it
    if (mainTopic.length > 50) {
        return mainTopic.substring(0, 47) + '...';
    }
    
    return mainTopic;
}

// Function to update user name if not already set
async function updateUserName(phoneNumber, name) {
    console.log(`Attempting to update user name for ${phoneNumber}: ${name}`);
    const { data, error } = await supabase
        .from('users')
        .select('name')
        .eq('phone_number', phoneNumber)
        .single();

    if (error && error.code !== 'PGRST116') { // Ignore 'no rows found' error
        console.error("Error checking existing user name:", error);
        return;
    }

    if (data && data.name) {
        console.log(`User name already exists for ${phoneNumber}. Not updating.`);
        return;
    }

    const { data: updateData, error: updateError } = await supabase
        .from('users')
        .update({ name: name })
        .eq('phone_number', phoneNumber);

    if (updateError) {
        console.error("Error updating user name:", updateError);
    } else {
        console.log("User name updated successfully");
    }
}

// **Helper Functions for Booking Flow**

/**
 * Function to parse user-provided time using chrono-node
 * @param {string} userInput - The user's input containing the preferred time.
 * @returns {string|null} - ISO string of the parsed date or null if parsing fails.
 */
function parseUserTime(userInput) {
    const parsedDate = chrono.parseDate(userInput);
    if (parsedDate) {
        return parsedDate.toISOString();
    } else {
        return null;
    }
}

/**
 * Function to spell out email
 * @param {string} email - The email address to spell out.
 * @returns {string} - Spelled out email.
 */
function spellOutEmail(email) {
    return email.split('').join(' ');
}

/**
 * Function to reconstruct email from spelled-out letters
 * @param {string} spelledOutEmail - The spelled out email (e.g., "j o h n dot d o e at example dot com").
 * @returns {string} - Reconstructed email.
 */
function reconstructEmail(spelledOutEmail) {
    let email = spelledOutEmail.toLowerCase();
    email = email.replace(/\bat\b/g, '@').replace(/\bdot\b/g, '.').replace(/\s+/g, '');
    return email;
}

/**
 * Function to validate email format
 * @param {string} email - The email address to validate.
 * @returns {boolean} - True if valid, false otherwise.
 */
function validateEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}


// Function to ask user for a suitable time for the training session
async function askForSuitableTime(openAiWs) {
    const prompt = "Sure! I'd be happy to book a training session for you. What time would suit you best for the training session?";
    openAiWs.send(JSON.stringify({
        type: "response.create",
        response: {
            modalities: ["text", "audio"],
            instructions: prompt,
            voice: VOICE,
            temperature: 0.7,
            max_output_tokens: 150,
        },
    }));
    openAiWs.bookingState = 'awaiting_time';
    await updateBookingStateWithRetry(openAiWs.phoneNumber, 'awaiting_time');
}

// Function to ask user for their email address
async function askForEmail(openAiWs) {
    try {
        const user = await createOrGetUserWithRetry(openAiWs.phoneNumber);

        if (user && user.email) {
            // Ask if they want to use the stored email
            const prompt = `I see that I have your email address on file (${spellOutEmail(user.email)}). Would you like me to use this email for the booking? Please say yes or no.`;
            openAiWs.send(JSON.stringify({
                type: "response.create",
                response: {
                    modalities: ["text", "audio"],
                    instructions: prompt,
                    voice: VOICE,
                    temperature: 0.7,
                    max_output_tokens: 150,
                },
            }));
            openAiWs.email = user.email; // Store the existing email
            openAiWs.bookingState = 'confirm_existing_email';
        } else {
            // Ask for new email
            const prompt = "Please provide your email address so I can send you the meeting details. Please spell it out for me.";
            openAiWs.send(JSON.stringify({
                type: "response.create",
                response: {
                    modalities: ["text", "audio"],
                    instructions: prompt,
                    voice: VOICE,
                    temperature: 0.7,
                    max_output_tokens: 150,
                },
            }));
            openAiWs.bookingState = 'awaiting_email';
        }
    } catch (error) {
        console.error("Error in askForEmail:", error);
        // Fallback to asking for new email
        const prompt = "Please provide your email address so I can send you the meeting details. Please spell it out for me.";
        openAiWs.send(JSON.stringify({
            type: "response.create",
            response: {
                modalities: ["text", "audio"],
                instructions: prompt,
                voice: VOICE,
                temperature: 0.7,
                max_output_tokens: 150,
            },
        }));
        openAiWs.bookingState = 'awaiting_email';
    }
}

// Function to confirm user's email address
async function confirmEmail(openAiWs, email) {
    const prompt = `Thank you! Just to confirm, your email address is spelled as: ${spellOutEmail(email)}. Is that correct? Please say "yes" or "no".`;
    openAiWs.send(JSON.stringify({
        type: "response.create",
        response: {
            modalities: ["text", "audio"],
            instructions: prompt,
            voice: VOICE,
            temperature: 0.5,
            max_output_tokens: 150,
        },
    }));
    openAiWs.bookingState = 'confirm_email';
    await updateBookingStateWithRetry(openAiWs.phoneNumber, 'confirm_email');
}

// Function to handle email confirmation response
async function handleEmailConfirmation(openAiWs, confirmation, email) {
    if (confirmation === 'yes') {
        const bookingSuccess = await bookTrainingSession(openAiWs, openAiWs.preferred_time, email);
        if (bookingSuccess) {
            const prompt = "Your training session has been booked successfully! I've sent the meeting details to your email. Looking forward to your training session!";
            openAiWs.send(JSON.stringify({
                type: "response.create",
                response: {
                    modalities: ["text", "audio"],
                    instructions: prompt,
                    voice: VOICE,
                    temperature: 0.7,
                    max_output_tokens: 150,
                },
            }));
            openAiWs.bookingState = 'idle';
            await updateBookingStateWithRetry(openAiWs.phoneNumber, 'idle');
        } else {
            const prompt = "I'm sorry, I encountered an issue while booking your training session. Please try again later.";
            openAiWs.send(JSON.stringify({
                type: "response.create",
                response: {
                    modalities: ["text", "audio"],
                    instructions: prompt,
                    voice: VOICE,
                    temperature: 0.7,
                    max_output_tokens: 150,
                },
            }));
            openAiWs.bookingState = 'idle';
            await updateBookingStateWithRetry(openAiWs.phoneNumber, 'idle');
        }
    } else {
        await askForEmail(openAiWs); // This will now handle both new and existing email flows
    }
}

/**
 * Function to book a training session using Google Calendar API
 * @param {WebSocket} openAiWs - The OpenAI WebSocket connection.
 * @param {string} preferredTime - The preferred time for the training session in ISO 8601 format.
 * @param {string} email - The user's email address.
 * @returns {boolean} - True if booking is successful, false otherwise.
 */
async function bookTrainingSession(openAiWs, preferredTime, email) {
    try {
        if (!preferredTime) {
            console.error("Preferred time is not set.");
            return false;
        }

        const startTime = new Date(preferredTime);
        const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);

        const event = {
            summary: "Pokémon Training Session",
            description: "A training session with Marcus, the Pokémon Master.",
            start: {
                dateTime: startTime.toISOString(),
                timeZone: 'America/Los_Angeles',
            },
            end: {
                dateTime: endTime.toISOString(),
                timeZone: 'America/Los_Angeles',
            },
            attendees: [
                { email: email },
            ],
            conferenceData: {
                createRequest: {
                    requestId: uuidv4(),
                    conferenceSolutionKey: { type: "hangoutsMeet" },
                },
            },
            reminders: {
                useDefault: true,
            },
        };

        const response = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            resource: event,
            conferenceDataVersion: 1,
        });

        if (response.status === 200 || response.status === 201) {
            console.log("Event created:", response.data.htmlLink);
            
            // Create booking record in database
            const booking = await createBookingWithRetry(
                openAiWs.phoneNumber,
                openAiWs.conversationId, // This is equal to callSid
                response.data.id,
                startTime.toISOString(),
                email
            );

            if (booking) {
                // Update user's email if not already set
                await updateUserEmailWithRetry(openAiWs.phoneNumber, email);
                return true;
            }
        }
        
        console.error("Failed to create event:", response.status, response.statusText);
        return false;

    } catch (error) {
        console.error("Error booking training session:", error);
        return false;
    }
}

// Function to finalize the conversation and generate summary
async function finalizeConversation(openAiWs) {
    if (!openAiWs.conversationId) {
        console.log("No conversation ID, skipping finalization");
        return;
    }

    console.log("Finalizing conversation:", openAiWs.conversationId);

    try {
        // Generate summary using Azure OpenAI
        const summaryResponse = await fetch(process.env.AZURE_OPENAI_CHAT_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "api-key": process.env.AZURE_OPENAI_CHAT_API_KEY,
            },
            body: JSON.stringify({
                messages: [
                    { role: "system", content: "You are a helpful assistant that summarizes conversations without including greetings." },
                    { role: "user", content: `Please summarize the following conversation:\n${openAiWs.fullDialogue}. Please do not include the greetings in summary, only the main conversation topic.` }
                ],
                max_tokens: 150
            }),
        });

        if (!summaryResponse.ok) {
            throw new Error("Error generating summary: " + summaryResponse.statusText);
        }

        const summaryData = await summaryResponse.json();
        const summary = summaryData.choices[0].message.content.trim();

        // Extract user's name from the summary
        const extractedName = await extractUserNameFromSummary(summary);
        if (extractedName) {
            await updateUserNameWithRetry(openAiWs.phoneNumber, extractedName);
        }

        // Extract email from the summary
        const extractedEmail = await extractEmailFromSummary(summary);
        if (extractedEmail) {
            await updateUserEmailWithRetry(openAiWs.phoneNumber, extractedEmail);
        }

        // Finalize the conversation in the database
        await finalizeConversationInDbWithRetry(
            openAiWs.conversationId,
            openAiWs.fullDialogue,
            summary
        );

    } catch (error) {
        console.error("Error finalizing conversation:", error);
    }
}

/**
 * Function to extract user's name from the conversation summary
 * @param {string} summary - The conversation summary.
 * @returns {string|null} - Extracted name or null if not found.
 */
async function extractUserNameFromSummary(summary) {
    const prompt = `Extract the user's name from the following conversation summary. If the name is not mentioned, respond with "Name not found".

Summary:
${summary}

Extracted Name:`;

    try {
        const response = await fetch(process.env.AZURE_OPENAI_CHAT_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "api-key": process.env.AZURE_OPENAI_CHAT_API_KEY,
            },
            body: JSON.stringify({
                messages: [
                    { role: "system", content: "You are a helpful assistant that extracts specific information from text." },
                    { role: "user", content: prompt }
                ],
                max_tokens: 10,
                temperature: 0,
            }),
        });

        if (!response.ok) {
            console.error("Error extracting user name:", response.statusText);
            return null;
        }

        const data = await response.json();
        const extractedName = data.choices[0].message.content.trim();

        // Handle case where name is not found
        if (extractedName.toLowerCase() === "name not found") {
            return null;
        }

        console.log("Extracted user name:", extractedName);
        return extractedName;
    } catch (error) {
        console.error("Error in extractUserNameFromSummary:", error);
        return null;
    }
}

// Function to update booking state in Supabase
async function updateBookingState(phoneNumber, state) {
    console.log(`Updating booking state for ${phoneNumber} to ${state}`);
    const { data, error } = await supabase
        .from('user_conversations')
        .update({ booking_state: state })
        .eq('phone_number', phoneNumber);

    if (error) {
        console.error("Error updating booking state:", error);
    } else {
        console.log(`Booking state updated to ${state} for ${phoneNumber}`);
    }
}

// New function to handle existing email confirmation
async function handleExistingEmailConfirmation(openAiWs, confirmation) {
    if (confirmation.includes('yes')) {
        // Proceed with booking using stored email
        const bookingSuccess = await bookTrainingSession(openAiWs, openAiWs.preferred_time, openAiWs.email);
        if (bookingSuccess) {
            const prompt = "Perfect! Your training session has been booked successfully! I've sent the meeting details to your email. Looking forward to your training session!";
            openAiWs.send(JSON.stringify({
                type: "response.create",
                response: {
                    modalities: ["text", "audio"],
                    instructions: prompt,
                    voice: VOICE,
                    temperature: 0.7,
                    max_output_tokens: 150,
                },
            }));
            openAiWs.bookingState = 'idle';
            await updateBookingStateWithRetry(openAiWs.phoneNumber, 'idle');
        } else {
            const prompt = "I'm sorry, I encountered an issue while booking your training session. Please try again later.";
            openAiWs.send(JSON.stringify({
                type: "response.create",
                response: {
                    modalities: ["text", "audio"],
                    instructions: prompt,
                    voice: VOICE,
                    temperature: 0.7,
                    max_output_tokens: 150,
                },
            }));
            openAiWs.bookingState = 'idle';
            await updateBookingStateWithRetry(openAiWs.phoneNumber, 'idle');
        }
    } else {
        // Ask for new email
        const prompt = "No problem! Please spell out the email address you'd like to use for this booking.";
        openAiWs.send(JSON.stringify({
            type: "response.create",
            response: {
                modalities: ["text", "audio"],
                instructions: prompt,
                voice: VOICE,
                temperature: 0.7,
                max_output_tokens: 150,
            },
        }));
        openAiWs.bookingState = 'awaiting_email';
        await updateBookingStateWithRetry(openAiWs.phoneNumber, 'awaiting_email');
    }
}

// Start the server
fastifyInstance.listen({ port: PORT }, (err, address) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`AI Assistant With a Brain Server is listening on ${address}`);
});
