"use strict";

/**
 * @typedef {import('moleculer').ServiceSchema} ServiceSchema Moleculer's Service Schema
 * @typedef {import('moleculer').Context} Context Moleculer's Context
 */

const DbService = require("../mixins/db.mixin.js");
const { generateResponse, EmailConfig, generateOtp, sendEmail, convertKeysToSnakeCase, generateAlphanumericOTP, base64toBlob, generateJWT } = require('../utils/utility');
const { OpenAIEmbeddings } = require('@langchain/openai')
const { SupabaseVectorStore } = require('@langchain/community/vectorstores/supabase');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai')
const { Document } = require('@langchain/core/documents');

const openAIKey = process.env.OPENAI_API_KEY
const sbUrl = process.env.SB_PROJECT_URL;
const sbApiKey = process.env.SB_API_KEY;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })


//GCP
// const { PredictionServiceClient } = require('@google-cloud/aiplatform').v1;
// const { helpers } = require('@google-cloud/aiplatform');
// const API_ENDPOINT = `${LOCATION}-aiplatform.googleapis.com`;
// const MODEL = 'gemini-embedding-001';
// const GOOGLE_CLOUD_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID;
// const LOCATION = 'us-central1';
// const client = new PredictionServiceClient({ apiEndpoint: API_ENDPOINT });
// const endpoint = `projects/${projectId}/locations/${LOCATION}/publishers/google/models/${MODEL}`;
// const task = 'QUESTION_ANSWERING';



/** @type {ServiceSchema} */
module.exports = {
    name: "BotService",
    mixins: [DbService("BotService")],


    /**
     * Settings
     */
    settings: {

    },

    /**
     * Dependencies
     */
    dependencies: [],

    /**
     * Actions
     */
    actions: {

        whatsAppMessage: {
            rest: {
                method: 'GET',
                path: '/webhook'
            },
            async handler(ctx) {
                const queryParams = ctx.params;
                const mode = queryParams['hub.mode'];
                const token = queryParams['hub.verify_token'];
                const challenge = queryParams['hub.challenge'];

                const VERIFY_TOKEN = 'HiraVihar'

                if (mode === "subscribe" && token === VERIFY_TOKEN) {
                    console.log('TOKEN VERIFIED')
                    ctx.meta.$responseType = 'text/plain';
                    ctx.meta.$statusCode = 200;
                    return challenge;
                } else {
                    console.log(ctx.params, 'Error in token')
                    return 'Error verifying token'
                }
            }
        },

        receiveMessage: {
            rest: {
                method: 'POST',
                path: '/webhook'
            },
            async handler(ctx) {
                try {
                    console.log("Webhook Hit by Whats App")
                    this.brain(ctx.params)
                    ctx.meta.$statusCode = 200;
                    ctx.meta.$responseType = "application/json";
                    return { status: "success" };

                } catch (error) {
                    this.logger.error(`Error: recieveMessages > BotService : `, error);
                    ctx.meta.$responseType = "application/json";
                    return { error: 'Something went wrong' };
                }
            }
        },
    },

    /**
     * Events
     */
    events: {

    },

    /**
     * Methods
     */
    methods: {

        async brain(response) {
            try {
                console.log('Processing WhatsApp Webhook Response');
                const entry = response.entry?.[0]?.changes?.[0]?.value;
                if (entry.statuses?.[0]?.status) {
                    const status = entry.statuses[0].status;
                    console.log('Status of message:', status);
                    return; // No further processing needed for statuses
                }
                const mobileNumber = entry.contacts?.[0]?.wa_id;
                const message = entry.messages[0];
                const messageBody = message.text.body;

                // console.log(response)

                // const mobileNumber = response.mobileNumber
                // const messageBody = response.message;

                if (!mobileNumber) {
                    console.error('Mobile number not found in response');
                    return;
                }

                const systemPrompt = `
You are a helpful assistant that manages user memories and reminders.

Detect the user's intent and return it in **strict JSON** like this:
{
  "intent": "store" | "retrieve" | "update" | "delete" | "reminder" | "capabilities" | "unknown",
  "content": "..."  // what the user wants you to act on
}

Intents:
- store → Save a memory
- retrieve → Look up a saved memory
- update → Change an existing memory
- delete → Remove a saved memory
- reminder → Set a reminder
- capabilities → User is asking what you can do
- unknown → Not relevant or unclear

Examples:
"Remember my blood group is B+" → store  
"What did I say about my bank?" → retrieve  
"Update my phone number to 98765" → update  
"Forget my old address" → delete  
"Remind me to drink water at 2PM" → reminder  
"What can you do?" → capabilities  
"Tell me a joke" → unknown

Only respond with JSON. Now analyze this message:
`;

                const data = await openai.chat.completions.create({
                    model: 'gpt-4o-mini',
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: messageBody }
                    ],
                    temperature: 0
                });

                const responseText = data.choices[0].message.content.trim();

                const intent = JSON.parse(responseText);
                console.log(intent)

                switch (intent.intent) {
                    case 'store':
                        this.saveUserMemory({ text: intent.content, userId: mobileNumber });
                        break;
                    case 'retrieve':
                        this.retrieveUserMemory({ text: intent.content, userId: mobileNumber });
                        break;
                    case 'update':
                        this.updateUserMemory({ text: intent.content, userId: mobileNumber });
                        break;
                    case 'delete':
                        this.deleteUserMemory({ text: intent.content, userId: mobileNumber });
                        break;
                    case 'reminder':
                        this.scheduleReminder({ text: intent.content, userId: mobileNumber });
                        break;
                    case 'capabilities':
                        this.capabilities({ text: intent.content, userId: mobileNumber });
                        break;
                    case 'unknown':
                        this.unknownIntent({ text: intent.content, userId: mobileNumber });
                        break;
                    default:
                        console.log('Unknown intent:', intent);
                }

            } catch (error) {
                console.error('Error in sendResponse:', error);
            }
        },

        async saveUserMemory({ text, userId }) {
            try {
                console.log('Processing Save Message to Supabase', text);

                const client = createClient(sbUrl, sbApiKey);
                const embeddings = new OpenAIEmbeddings({ openAIApiKey: openAIKey });

                const queryEmbedding = await embeddings.embedQuery(text);
                const { data: existing, error: matchError } = await client.rpc('match_user_memory', {
                    user_id_input: userId,
                    query_embedding: queryEmbedding,
                    match_count: 1,
                    similarity_threshold: 0.8
                });

                if (existing && existing.length > 0) {
                    console.log('Memory already exists or is similar — updating instead');
                    return this.updateUserMemory({ text, userId });
                }

                const documents = [
                    new Document({
                        pageContent: text,
                        metadata: { user_id: userId }
                    })
                ];

                await SupabaseVectorStore.fromDocuments(
                    documents,
                    embeddings,
                    {
                        client,
                        tableName: 'documents',
                    }
                );

                const completion = await openai.chat.completions.create({
                    model: 'gpt-4o-mini',
                    messages: [
                        {
                            role: 'system',
                            content: `You are a helpful assistant. Generate a creative response to confirm that the user's memory has been saved successfully.`
                        },
                        {
                            role: 'user',
                            content: text
                        }
                    ],
                    temperature: 2
                });

                const answer = completion.choices[0].message.content.trim();

                const data = {
                    messaging_product: "whatsapp",
                    recipient_type: "individual",
                    to: userId,
                    type: "text",
                    text: {
                        body: answer
                    }
                };

                const apiUrl = `https://graph.facebook.com/v23.0/${process.env.PHONE_NUMBER_ID}/messages`

                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(data)
                });

                if (response.status !== 200) {
                    console.log('Error connecting whats app server', response)
                }

                console.log('Memory saved successfully for user:', userId);

            } catch (error) {
                console.error('Error in sendResponse:', error);
            }
        },

        async retrieveUserMemory({ text, userId }) {
            try {
                const client = createClient(sbUrl, sbApiKey);
                const embeddings = new OpenAIEmbeddings({ openAIApiKey: openAIKey });

                const store = new SupabaseVectorStore(embeddings, {
                    client,
                    tableName: 'documents',
                    queryName: 'semantic_search_by_user'
                });

                const results = await store.similaritySearch(text, 2, {
                    match_threshold: 0.75,
                    target_user_id: userId
                });

                console.log('Semantic search results:', results);

                if (!results || results.length === 0) {
                    console.log('No relevant memories found for user:', userId);
                }

                const memoryText = results.map(doc => doc.pageContent).join('\n');

                const completion = await openai.chat.completions.create({
                    model: 'gpt-4o-mini',
                    messages: [
                        {
                            role: 'system',
                            content: `You are a helpful assistant. You can only answer based on the memory provided below. If you cannot find a direct answer, generate kind realistic response that you don't have that information."
                            Memory: ${memoryText}`
                        },
                        {
                            role: 'user',
                            content: text
                        }
                    ],
                    temperature: 2
                });

                const answer = completion.choices[0].message.content.trim();

                const data = {
                    messaging_product: "whatsapp",
                    recipient_type: "individual",
                    to: userId,
                    type: "text",
                    text: {
                        body: answer
                    }
                };

                const apiUrl = `https://graph.facebook.com/v23.0/${process.env.PHONE_NUMBER_ID}/messages`

                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(data)
                });

                if (response.status !== 200) {
                    console.log('Error connecting whats app server')
                }

                console.log('Answer generated for user:', userId);

            } catch (error) {
                console.error('Error in retrieveUserMemory:', error);
            }

        },

        async updateUserMemory({ text, userId }) {
            try {
                const embeddings = new OpenAIEmbeddings({ openAIApiKey: openAIKey });
                console.log('Processing Update Message to Supabase', text);
                const [newEmbedding] = await embeddings.embedDocuments([text]);
                const client = createClient(sbUrl, sbApiKey);

                const { data: existing, error: matchError } = await client.rpc('match_user_memory', {
                    user_id_input: userId,
                    query_embedding: newEmbedding,
                    match_count: 1,
                    similarity_threshold: 0.75
                });


                if (matchError || !existing || existing.length === 0) {
                    console.error('No matching memory found to update.');
                }

                const currentMemory = existing[0];
                const currentText = currentMemory.content;

                const prompt =
                    `You're an assistant that updates user memory.
Original memory:
${currentText}
User instruction:
${text}
Update the original memory accordingly and return only the final updated sentence, without quotes or explanations.`;

                const res = await openai.chat.completions.create({
                    model: 'gpt-4o-mini',
                    messages: [
                        { role: 'system', content: prompt }
                    ],
                    temperature: 0
                });

                const updatedMemory = res.choices[0].message.content.trim();

                const updatedEmbedding = await embeddings.embedQuery(updatedMemory);

                const { error: updateError } = await client
                    .from('documents')
                    .update({
                        content: updatedMemory,
                        embedding: updatedEmbedding,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', currentMemory.id)
                    .eq('user_id', userId);

                if (updateError) {
                    console.error('Error updating memory: ' + updateError.message);
                }

                const replyPrompt =
                    `Create a friendly response to the user confirming that their memory has been updated from original text to the updated text.
Original text:
${currentText}
Updated text:
${updatedMemory}`;

                const replyRes = await openai.chat.completions.create({
                    model: 'gpt-4o-mini',
                    messages: [
                        { role: 'system', content: replyPrompt }
                    ],
                    temperature: 2
                });

                const replyResponse = replyRes.choices[0].message.content.trim();

                const data = {
                    messaging_product: "whatsapp",
                    recipient_type: "individual",
                    to: userId,
                    type: "text",
                    text: {
                        body: replyResponse
                    }
                };

                const apiUrl = `https://graph.facebook.com/v23.0/${process.env.PHONE_NUMBER_ID}/messages`

                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(data)
                });

                if (response.status !== 200) {
                    console.log('Error connecting whats app server')
                }

                console.log('Memory updated successfully for user:', userId);

            } catch (error) {
                console.error('Error in updateUserMemory: ', error);
            }
        },

        async deleteUserMemory({ text, userId }) {
            try {
                const [deleteEmbedding] = await embeddings.embedDocuments([text]);
                const { data: match, error: matchError } = await client.rpc('match_user_document', {
                    user_id_input: userId,
                    query_embedding: deleteEmbedding,
                    match_count: 1,
                    similarity_threshold: 0.75
                });

                if (matchError || !match || match.length === 0) {
                    console.error('No matching memory found to delete.');
                }

                const memoryToDelete = match[0];

                const { error: deleteError } = await client
                    .from('documents')
                    .delete()
                    .eq('id', memoryToDelete.id)
                    .eq('user_id', userId);

                if (deleteError) {
                    console.error('Failed to delete memory: ' + deleteError.message);
                }

                const deletePrompt =
                    `Create a friendly response to the user confirming that their saved memory has been deleted.
Memory to delete:${memoryToDelete.content}`;

                const replyRes = await openai.chat.completions.create({
                    model: 'gpt-4o-mini',
                    messages: [
                        { role: 'system', content: deletePrompt }
                    ],
                    temperature: 1
                });

                const deleteResponse = replyRes.choices[0].message.content.trim();

                const data = {
                    messaging_product: "whatsapp",
                    recipient_type: "individual",
                    to: userId,
                    type: "text",
                    text: {
                        body: deleteResponse
                    }
                };

                const apiUrl = `https://graph.facebook.com/v23.0/${process.env.PHONE_NUMBER_ID}/messages`

                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(data)
                });

                if (response.status !== 200) {
                    console.log('Error connecting whats app server')
                }

            } catch (error) {
                console.error('Error in deleteUserMemory: ', error);
            }
        }
    },

    /**
     * Service created lifecycle event handler
     */
    created() {

    },

    /**
     * Service started lifecycle event handler
     */
    async started() {

    },

    /**
     * Service stopped lifecycle event handler
     */
    async stopped() {

    }
};
