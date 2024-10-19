// server.js

import dotenv from "dotenv";
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '.env') });

console.log("Environment variables loaded:");
console.log("PORT:", process.env.PORT);
console.log("OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "Set" : "Not set");
console.log("SUPABASE_URL:", process.env.SUPABASE_URL);
console.log("SUPABASE_ANON_KEY:", process.env.SUPABASE_ANON_KEY ? "Set" : "Not set");
console.log("TWILIO_ACCOUNT_SID:", process.env.TWILIO_ACCOUNT_SID ? "Set" : "Not set");
console.log("TWILIO_AUTH_TOKEN:", process.env.TWILIO_AUTH_TOKEN ? "Set" : "Not set");

import fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";
import twilio from 'twilio';
import { v4 as uuidv4 } from 'uuid';

// Initialize Twilio client
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Other constants and configurations
const PORT = process.env.PORT || 5050;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VOICE = process.env.VOICE || "shimmer";
const SYSTEM_MESSAGE = `You are an AI assistant designed as a Pokémon Master. You have access to a vast knowledge base containing detailed information about all Pokémon, their abilities, types, evolutions, and related game mechanics.

Key Guidelines:
- For ANY question related to Pokémon, you MUST check the knowledge base first.
- Tell the user you're checking your Pokédex (which is your knowledge base) before answering.
- Provide accurate and detailed answers about Pokémon, their characteristics, and the Pokémon world.
- If you are unsure or need more information, tell the user "Let me check my Pokédex for that information." and use 'access_knowledge_base' to reference your knowledge base.
- Keep your responses clear, informative, and in the style of an enthusiastic Pokémon expert.
- Don't reveal any technical details about the knowledge base or how you're accessing the information.
- Be friendly and excited about sharing Pokémon knowledge!`;

const LOG_EVENT_TYPES = [
    "response.content.done",
    "response.function_call_arguments.done",
    "input_audio_buffer.committed",
    "input_audio_buffer.speech_stopped",
    "input_audio_buffer.speech_started",
    "session.created",
];

// Add these new constants
const INITIAL_GREETING = "Hey trainer! My name is Marcus, it's nice to meet you. What is your name?";
const RETURNING_GREETING = "Welcome back, {name}! Last time we talked about {lastTopic}. Would you like to continue that discussion or do you have a new question?";

// Add this flag to track if the session is ready
let sessionReady = false;

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
        let callSid = null;  // Add this line

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
            handleTwilioMessage(message, openAiWs, (sid) => (streamSid = sid), (cid) => (callSid = cid))  // Modify this line
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

// Function to initialize OpenAI WebSocket
function initializeOpenAiWebSocket() {
    const ws = new WebSocket(
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
        {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1",
            },
        },
    );
    ws.fullDialogue = "";
    ws.awaitingName = true;
    ws.phoneNumber = null;
    ws.lastUserMessage = null;
    return ws;
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
                    description:
                        "Access the knowledge base to answer the user's question.",
                    parameters: {
                        type: "object",
                        properties: {
                            question: {
                                type: "string",
                                description:
                                    "The question to ask the knowledge base.",
                            },
                        },
                        required: ["question"],
                        additionalProperties: false,
                    },
                },
            ],
            modalities: ["text", "audio"],
            temperature: 0.7,
        },
    };
    console.log("Sending session update:", JSON.stringify(sessionUpdate));
    ws.send(JSON.stringify(sessionUpdate));
}

// Handle messages from OpenAI WebSocket
async function handleOpenAiMessage(openAiWs, data, connection, streamSid) {
    try {
        const response = JSON.parse(data);

        if (response.type === "session.created") {
            console.log("Session created:", response);
            sendSessionUpdate(openAiWs);
        }

        if (response.type === "session.updated") {
            console.log("Session updated successfully:", response);
            sessionReady = true;
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
                // Extract the 'question' argument
                const functionArgs = JSON.parse(response.arguments);
                const question = functionArgs.question;

                console.log("AI is accessing knowledge base for question:", question);

                // Inform the user that the assistant is checking the knowledge base
                openAiWs.send(
                    JSON.stringify({
                        type: "conversation.item.create",
                        item: {
                            type: "assistant",
                            content:
                                "Give me a second, I'm checking my knowledge.",
                            modalities: ["text", "audio"],
                        },
                    }),
                );

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
                            },
                        }),
                    );

                    console.log("Knowledge base answer provided to OpenAI");
                } else {
                    console.log("No answer from knowledge base, AI will use its general knowledge.");
                    // Handle the case where the Supabase query failed
                    openAiWs.send(
                        JSON.stringify({
                            type: "conversation.item.create",
                            item: {
                                type: "assistant",
                                content:
                                    "I'm sorry, I couldn't access the knowledge base at this time.",
                                modalities: ["text", "audio"],
                            },
                        }),
                    );
                }
            }
        }

        if (response.type === "response.audio.delta" && response.delta) {
            const audioDelta = {
                event: "media",
                streamSid: streamSid,
                media: {
                    payload: Buffer.from(response.delta, "base64").toString(
                        "base64",
                    ),
                },
            };
            connection.send(JSON.stringify(audioDelta));
        }

        if (response.type === "response.content.done") {
            console.log("AI final response:", response.content);
            openAiWs.fullDialogue += `AI: ${response.content}\n`;
            
            // Update last conversation regardless of whether it's a name or not
            await updateLastConversation(openAiWs.phoneNumber, openAiWs.lastUserMessage, response.content);
            
            if (openAiWs.awaitingName) {
                console.log("Updating user name:", response.content);
                await updateUserName(openAiWs.phoneNumber, response.content);
                openAiWs.awaitingName = false;
            }
        }

        if (response.type === "input_audio_buffer.speech_started") {
            console.log("User speaking");
            openAiWs.awaitingName = openAiWs.awaitingName && openAiWs.fullDialogue.split('\n').length === 2;
        }

        if (response.type === "input_audio_buffer.committed") {
            // This is where we get the user's message
            if (response.text) {
                openAiWs.lastUserMessage = response.text;
                openAiWs.fullDialogue += `User: ${response.text}\n`;
                console.log("User message:", response.text);
            }
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
// Function to interact with Supabase for the knowledge base
async function askSupabaseAssistant(question) {
    console.log("Querying knowledge base for:", question);
    try {
        // Generate embedding for the question using OpenAI's Embedding API
        const embeddingResponse = await fetch("https://api.openai.com/v1/embeddings", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                input: question,
                model: "text-embedding-ada-002",
            }),
        });

        if (!embeddingResponse.ok) {
            console.error("Error fetching embedding from OpenAI:", embeddingResponse.statusText);
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
function handleTwilioMessage(message, openAiWs, setStreamSid) {
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
                openAiWs.callSid = data.start.callSid;  // Set callSid here
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
        console.error(
            "Error parsing Twilio message:",
            error,
            "Message:",
            message,
        );
    }
}

// New function to handle incoming calls
async function handleIncomingCall(callSid, openAiWs) {
    if (!callSid) {
        console.error("Call SID is undefined");
        return;
    }

    try {
        // Fetch call details from Twilio API
        const call = await twilioClient.calls(callSid).fetch();
        const phoneNumber = call.from;

        // Store the conversation ID and phone number
        openAiWs.conversationId = uuidv4();
        openAiWs.phoneNumber = phoneNumber;

        // Check if the user exists in the database
        const { data: userData, error } = await supabase
            .from('user_conversations')
            .select('*')
            .eq('phone_number', phoneNumber)
            .single();

        if (error && error.code !== 'PGRST116') {
            console.error("Error fetching user data:", error);
        }

        let greeting;
        if (userData) {
            // Returning user
            greeting = RETURNING_GREETING
                .replace('{name}', userData.user_name || 'trainer')
                .replace('{lastTopic}', userData.last_question || 'Pokémon');
        } else {
            // New user
            greeting = INITIAL_GREETING;
            // Create a new user entry in the database
            const { data, error } = await supabase
                .from('user_conversations')
                .insert([{ phone_number: phoneNumber }]);
            if (error) console.error("Error creating new user:", error);
        }

        sendInitialGreeting(openAiWs, greeting);

    } catch (error) {
        console.error("Error handling incoming call:", error);
        if (error.message.includes("Parameter 'sid' is not valid")) {
            console.error("Invalid Call SID:", callSid);
        }
    }
}

// New function to send the initial greeting
function sendInitialGreeting(openAiWs, greeting) {
    if (sessionReady && greeting) {
        console.log("Sending initial greeting:", greeting);
        sendAIMessage(openAiWs, greeting);
        openAiWs.fullDialogue = `AI: ${greeting}\n`;
        openAiWs.awaitingName = greeting === INITIAL_GREETING;
    } else {
        console.log("Session not ready or greeting not set, delaying initial greeting");
    }
}
// New function to send AI messages
function sendAIMessage(openAiWs, message) {
    console.log("Sending AI message:", message);
    openAiWs.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
            type: "assistant",
            content: message,
            modalities: ["text", "audio"],
        },
    }));

    // Add this to force audio generation
    openAiWs.send(JSON.stringify({
        type: "response.create",
        response: {
            modalities: ["text", "audio"],
            content: message,
        },
    }));
}

// New function to update user name
async function updateUserName(phoneNumber, name) {
    console.log(`Updating user name for ${phoneNumber}: ${name}`);
    const { data, error } = await supabase
        .from('user_conversations')
        .upsert({ phone_number: phoneNumber, user_name: name }, { onConflict: 'phone_number' });

    if (error) {
        console.error("Error updating user name:", error);
    } else {
        console.log("User name updated successfully");
    }
}

// New function to update last conversation
async function updateLastConversation(phoneNumber, question, answer) {
    console.log(`Updating last conversation for ${phoneNumber}`);
    console.log(`Question: ${question}`);
    console.log(`Answer: ${answer}`);
    const { data, error } = await supabase
        .from('user_conversations')
        .upsert({
            phone_number: phoneNumber,
            last_question: question || 'No question',
            last_answer: answer,
            last_conversation_timestamp: new Date().toISOString(),
        }, { onConflict: 'phone_number' });

    if (error) {
        console.error("Error updating last conversation:", error);
    } else {
        console.log("Last conversation updated successfully");
    }
}

// New function to finalize the conversation
async function finalizeConversation(openAiWs) {
    if (!openAiWs.conversationId) {
        console.log("No conversation ID, skipping finalization");
        return;
    }

    console.log("Finalizing conversation:", openAiWs.conversationId);

    try {
        // Generate summary using GPT-4
        const summaryResponse = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "You are a helpful assistant that summarizes conversations." },
                    { role: "user", content: `Please summarize the following conversation:\n${openAiWs.fullDialogue}` }
                ],
                max_tokens: 150
            }),
        });

        const summaryData = await summaryResponse.json();
        const summary = summaryData.choices[0].message.content;

        console.log("Generated summary:", summary);

        // Update the database with the full dialogue and summary
        const { data, error } = await supabase
            .from('user_conversations')
            .update({
                full_dialogue: openAiWs.fullDialogue,
                summary: summary
            })
            .eq('phone_number', openAiWs.phoneNumber);

        if (error) {
            console.error("Error updating conversation summary:", error);
        } else {
            console.log("Conversation summary updated successfully");
        }
    } catch (error) {
        console.error("Error finalizing conversation:", error);
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

