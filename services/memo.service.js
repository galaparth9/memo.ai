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
const cron = require('node-cron');
const { DateTime } = require('luxon');

const openAIKey = process.env.OPENAI_API_KEY
const sbUrl = process.env.SB_PROJECT_URL;
const sbApiKey = process.env.SB_API_KEY;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const client = createClient(sbUrl, sbApiKey);


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

                const { data: profile, error: tzError } = await client
                    .from('user_activity')
                    .select('timezone, user_name')
                    .eq('user_id', mobileNumber)
                    .maybeSingle();

                const userTimezone = profile?.timezone;
                const userName = profile?.user_name;

                if (tzError) {
                    console.error('Error fetching user profile:', tzError);
                }

                // if (!userName || userName.trim() === '') {
                //     await this.askUserName({ mobileNumber });
                //     return;
                // }

                if (!userTimezone) {
                    await this.askTimezone({ mobileNumber });
                    return;
                }

                if (entry.messages?.[0]?.interactive?.list_reply) {
                    const message = entry.messages[0];
                    const responseId = message.interactive.list_reply.id;
                    const responseTitle = message.interactive.list_reply.title;

                    if (responseId.startsWith("tz_")) {
                        const timezone = responseId.replace("tz_", "").replace(/_/g, "/");
                        console.log("User selected timezone:", timezone);

                        await timezoneSet(mobileNumber, timezone);
                    }

                }

                // console.log(response)

                // const mobileNumber = response.mobileNumber
                // const messageBody = response.message;

                if (!mobileNumber) {
                    console.error('Mobile number not found in response');
                    return;
                }

                await client
                    .from('user_activity')
                    .upsert({
                        user_id: mobileNumber,
                        last_active_at: new Date().toISOString()
                    });

                await client.from('chat_logs').insert({
                    user_id: mobileNumber,
                    message: messageBody,
                    role: 'user'
                });

                const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

                const { data: chatHistory } = await client
                    .from('chat_logs')
                    .select('message, role')
                    .eq('user_id', mobileNumber)
                    .gte('created_at', thirtyMinsAgo)
                    .order('created_at', { ascending: true });

                const pastMessages = chatHistory?.map(entry => `${entry.role}: ${entry.message}`).join('\n') || '';

                console.log('Past messages from the last 30 minutes:', pastMessages);


                const systemPrompt = `
You are a helpful assistant that manages user memories and reminders.

The following is the chat history from the past 30 minutes:
${pastMessages}

From latest message and referring to chat history detect the user's intent and return it in **strict JSON** like this:
{
  "intent": "store" | "retrieve" | "update" | "delete" | "reminder" | "capabilities" | "unknown" | "timezone",
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
"Hi or What can you do?" → capabilities  
"Tell me a joke" → unknown
"Asia/Kolkata or IST" → timezone

Only respond with JSON. Now analyze this message:`;

                const data = await openai.chat.completions.create({
                    model: 'gpt-4.1-mini',
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
                        this.saveUserMemory({ text: intent.content, userId: mobileNumber, pastMessages: pastMessages });
                        break;
                    case 'retrieve':
                        this.retrieveUserMemory({ text: intent.content, userId: mobileNumber, pastMessages: pastMessages });
                        break;
                    case 'update':
                        this.updateUserMemory({ text: intent.content, userId: mobileNumber, pastMessages: pastMessages });
                        break;
                    case 'delete':
                        this.deleteUserMemory({ text: intent.content, userId: mobileNumber, pastMessages: pastMessages });
                        break;
                    case 'reminder':
                        this.scheduleReminder({ text: intent.content, userId: mobileNumber, pastMessages: pastMessages });
                        break;
                    case 'capabilities':
                        this.capabilities({ text: intent.content, userId: mobileNumber, pastMessages: pastMessages });
                        break;
                    case 'unknown':
                        this.unknownIntent({ text: intent.content, userId: mobileNumber, pastMessages: pastMessages });
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
                    await this.updateUserMemory({ text, userId });
                    return;
                }

                const documents = [
                    new Document({
                        pageContent: text,
                        metadata: { user_id: userId }
                    })
                ];

                await SupabaseVectorStore.fromDocuments(documents, embeddings, {
                    client,
                    tableName: 'documents',
                });

                // await client.from('chat_logs').insert({
                //     user_id: userId,
                //     message: text,
                //     role: 'user'
                // });

                const now = new Date();
                const thirtyMinsAgo = new Date(now.getTime() - 30 * 60 * 1000);

                const { data: chatHistory, error: chatError } = await client
                    .from('chat_logs')
                    .select('message, role')
                    .eq('user_id', userId)
                    .gte('created_at', thirtyMinsAgo.toISOString())
                    .order('created_at', { ascending: true });

                const historyMessages = (chatHistory || []).map(msg => ({
                    role: msg.role,
                    content: msg.message
                }));

                const messages = [
                    {
                        role: 'system',
                        content: `You are a friendly assistant helping a user save a memory. 
Include a short message confirming that their memory has been saved. 
Be brief, human-like, and kind.`
                    },
                    ...historyMessages,
                    {
                        role: 'user',
                        content: text
                    }
                ];

                const completion = await openai.chat.completions.create({
                    model: 'gpt-4.1-mini',
                    messages,
                    temperature: 0.8
                });

                const answer = completion.choices[0].message.content.trim();

                await client.from('chat_logs').insert({
                    user_id: userId,
                    message: answer,
                    role: 'assistant'
                });

                const data = {
                    messaging_product: "whatsapp",
                    recipient_type: "individual",
                    to: userId,
                    type: "text",
                    text: {
                        body: answer
                    }
                };

                const apiUrl = `https://graph.facebook.com/v17.0/${process.env.PHONE_NUMBER_ID}/messages`;

                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(data)
                });

                if (response.status !== 200) {
                    console.log('Error sending WhatsApp message:', response.status, await response.text());
                }

                console.log('Memory saved and reply sent for user:', userId);

            } catch (error) {
                console.error('Error in saveUserMemory:', error);
            }
        }
        ,

        async retrieveUserMemory({ text, userId }) {
            try {
                const embeddings = new OpenAIEmbeddings({ openAIApiKey: openAIKey });

                const store = new SupabaseVectorStore(embeddings, {
                    client,
                    tableName: 'documents',
                    queryName: 'semantic_search_by_user'
                });

                const results = await store.similaritySearch(text, 4, {
                    match_threshold: 0.75,
                    target_user_id: userId
                });

                console.log('Semantic search results:', results);

                if (!results || results.length === 0) {
                    console.log('No relevant memories found for user:', userId);
                }

                const now = new Date();
                const thirtyMinsAgo = new Date(now.getTime() - 30 * 60 * 1000);

                const { data: chatHistory, error: chatError } = await client
                    .from('chat_logs')
                    .select('message, role, created_at')
                    .eq('user_id', userId)
                    .gte('created_at', thirtyMinsAgo.toISOString())
                    .order('created_at', { ascending: true });

                const historyMessages = (chatHistory || []).map(m => ({
                    role: m.role,
                    content: m.message
                }));


                const memoryText = results.map(doc => doc.pageContent).join('\n');

                const messages = [
                    {
                        role: 'system',
                        content: `You are a helpful assistant. You can only answer based on the memory provided below. 
If you cannot find a direct answer, generate a friendly and realistic response that you don't have that information.
Memory: ${memoryText}`
                    },
                    ...historyMessages,
                    {
                        role: 'user',
                        content: text
                    }
                ];

                const completion = await openai.chat.completions.create({
                    model: 'gpt-4.1-mini',
                    messages,
                    temperature: 1
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

                await client.from('chat_logs').insert({
                    user_id: userId,
                    message: answer,
                    role: 'assistant'
                });

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

                const { data: existing, error: matchError } = await client.rpc('match_user_memory', {
                    user_id_input: userId,
                    query_embedding: newEmbedding,
                    match_count: 1,
                    similarity_threshold: 0.75
                });

                if (matchError || !existing || existing.length === 0) {
                    console.error('No matching memory found to update.');
                    return;
                }

                const currentMemory = existing[0];
                const currentText = currentMemory.content;

                const prompt = `You're an assistant that updates user memory.
Original memory:
${currentText}
User instruction:
${text}
Update the original memory accordingly and return only the final updated sentence, without quotes or explanations.`;

                const res = await openai.chat.completions.create({
                    model: 'gpt-4.1-mini',
                    messages: [{ role: 'system', content: prompt }],
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

                const now = new Date();
                const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);

                const { data: chatHistory, error: chatError } = await client
                    .from('chat_logs')
                    .select('message, role')
                    .eq('user_id', userId)
                    .gte('created_at', thirtyMinAgo.toISOString())
                    .order('created_at', { ascending: true });

                const historyMessages = (chatHistory || []).map(msg => ({
                    role: msg.role,
                    content: msg.message
                }));

                const replyPrompt = [
                    {
                        role: 'system',
                        content: `You're an assistant confirming to the user that you've updated their memory. Be friendly and conversational.`
                    },
                    ...historyMessages,
                    {
                        role: 'user',
                        content: `My previous memory was: "${currentText}"\nPlease update it to: "${updatedMemory}"`
                    }
                ];

                const replyRes = await openai.chat.completions.create({
                    model: 'gpt-4.1-mini',
                    messages: replyPrompt,
                    temperature: 0.7
                });

                const replyResponse = replyRes.choices[0].message.content.trim();

                await client.from('chat_logs').insert({
                    user_id: userId,
                    message: replyResponse,
                    role: 'assistant'
                });

                const data = {
                    messaging_product: "whatsapp",
                    recipient_type: "individual",
                    to: userId,
                    type: "text",
                    text: {
                        body: replyResponse
                    }
                };

                const apiUrl = `https://graph.facebook.com/v23.0/${process.env.PHONE_NUMBER_ID}/messages`;

                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(data)
                });

                if (response.status !== 200) {
                    console.log('Error connecting WhatsApp server:', await response.text());
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
                    model: 'gpt-4.1-mini',
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
        },

        async scheduleReminder({ text, userId }) {
            try {

                const { data: profile, error: tzError } = await client
                    .from('user_activity')
                    .select('timezone')
                    .eq('user_id', userId)
                    .maybeSingle();

                const userTimezone = profile?.timezone;

                if (tzError) {
                    console.error('Error fetching user profile:', tzError);
                }

                const now = DateTime.now().setZone(userTimezone);
                const nowString = now.toISO();

                const prompt = `
You are a smart assistant. Today's date and time is ${nowString}. 
From this sentence: "${text}", extract a clean reminder message and ISO 8601 datetime in the user's timezone: "${userTimezone}".

Respond with JSON like:
{
  "message": "Call mom",
  "datetime": "2025-06-27T18:00:00"
}`;

                const response = await openai.chat.completions.create({
                    model: 'gpt-4.1-mini',
                    messages: [
                        { role: 'system', content: prompt }
                    ],
                    temperature: 0
                });

                const parsed = JSON.parse(response.choices[0].message.content.trim());
                const { message, datetime } = parsed;

                const utcDatetime = DateTime.fromISO(datetime, { zone: userTimezone }).toUTC().toISO();

                const { error } = await client.from('reminders').insert({
                    user_id: userId,
                    content: message,
                    remind_at: utcDatetime
                });

                if (error) {
                    console.error('Error inserting reminder:', error.message);
                    return;
                }

                const data = {
                    messaging_product: "whatsapp",
                    recipient_type: "individual",
                    to: userId,
                    type: "text",
                    text: {
                        body: `Reminder set for ${message} at ${datetime}).`
                    }
                };

                const apiUrl = `https://graph.facebook.com/v23.0/${process.env.PHONE_NUMBER_ID}/messages`

                const res = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(data)
                });

                if (res.status !== 200) {
                    console.log('Error connecting whats app server')
                }

            } catch (error) {
                console.error('Error in scheduleReminder: ', error);

            }
        },

        async sendReminder(userId, message) {
            try {
                const apiUrl = `https://graph.facebook.com/v23.0/${process.env.PHONE_NUMBER_ID}/messages`;

                const payload = {
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to: userId,
                    type: 'text',
                    text: {
                        body: message
                    }
                };

                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });

                const result = await response.json();

                if (!response.ok) {
                    console.error('WhatsApp API error:', result);
                } else {
                    console.log('Message sent to', userId);
                }

            } catch (error) {
                console.error('Error in sendMessageToUser:', error.message);
            }
        },

        async capabilities({ userId }) {
            try {
                const apiUrl = `https://graph.facebook.com/v23.0/${process.env.PHONE_NUMBER_ID}/messages`;

                const payload = {
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to: userId,
                    type: 'text',
                    text: {
                        body: 'Here are some things I can do for you:\n' +
                            '- Store memories for you\n' +
                            '- Retrieve saved memories\n' +
                            '- Update existing memories\n' +
                            '- Delete memories you no longer need\n' +
                            '- Set reminders for important tasks\n' +
                            'Just type what you need, and I will assist you!'
                    }
                };

                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });

                const result = await response.json();

                if (!response.ok) {
                    console.error('WhatsApp API error:', result);
                }
            } catch (error) {
                console.error('Error in capabilities:', error);

            }
        },

        async askTimezone({ userId }) {
            try {
                const data = {
                    messaging_product: "whatsapp",
                    recipient_type: "individual",
                    to: userId,
                    type: "interactive",
                    interactive: {
                        type: "list",
                        header: {
                            type: "text",
                            text: "🌍 Select Your Timezone"
                        },
                        body: {
                            text: "Please select your current timezone from the list below."
                        },
                        footer: {
                            text: "This helps us schedule reminders accurately."
                        },
                        action: {
                            button: "Choose Timezone",
                            sections: [
                                {
                                    title: "Timezone?",
                                    rows: [
                                        { id: "tz_asia_kolkata", title: "Asia/Kolkata (India)" },
                                        { id: "tz_asia_dubai", title: "Asia/Dubai (UAE)" },
                                        { id: "tz_asia_shanghai", title: "Asia/Shanghai (China)" },
                                        { id: "tz_america_new_york", title: "America/New_York (USA)" },
                                        { id: "tz_asia_tokyo", title: "Asia/Tokyo (Japan)" },
                                        { id: "tz_europe_london", title: "Europe/London (UK)" },
                                        { id: "tz_asia_jakarta", title: "Asia/Jakarta (Indonesia)" },
                                        { id: "tz_america_sao_paulo", title: "America/Sao_Paulo (Brazil)" },
                                        { id: "tz_europe_berlin", title: "Europe/Berlin (Germany)" },
                                        { id: "tz_africa_lagos", title: "Africa/Lagos (Nigeria)" },
                                        { id: "tz_europe_moscow", title: "Europe/Moscow (Russia)" },
                                        { id: "tz_asia_seoul", title: "Asia/Seoul (South Korea)" },
                                        { id: "tz_australia_sydney", title: "Australia/Sydney" },
                                        { id: "tz_asia_bangkok", title: "Asia/Bangkok (Thailand)" },
                                        { id: "tz_asia_manila", title: "Asia/Manila (Philippines)" },
                                    ]
                                }
                            ]
                        }
                    }
                };
                const apiUrl = `https://graph.facebook.com/v23.0/${process.env.PHONE_NUMBER_ID}/messages`;

                const res = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(data)
                });

                if (res.status !== 200) {
                    console.log('Error connecting whats app server')
                }
                console.log('Timezone selection message sent to user:', userId);

            } catch (error) {
                console.error('Error in askTimezone:', error);
            }
        },

        async timezoneSet(userId, timezone) {
            try {

                const { error } = await client
                    .from('user_activity')
                    .upsert(
                        {
                            user_id: userId,
                            timezone: timezone,
                            updated_at: new Date().toISOString()
                        },
                        { onConflict: 'user_id' }
                    );

                const apiUrl = `https://graph.facebook.com/v23.0/${process.env.PHONE_NUMBER_ID}/messages`;

                const payload = {
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to: userId,
                    type: 'text',
                    text: {
                        body: `Your timezone has been set to ${timezone}. Now let's get started with your reminders!`
                    }
                };

                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });

                const result = await response.json();

                if (!response.ok) {
                    console.error('WhatsApp API error:', result);
                }

                console.log('Timezone set for user:', userId, 'to', timezone);

                if (error) {
                    console.error('Error saving timezone:', error.message);
                }
            } catch (error) {
                console.error('Error in timezoneSet:', error);
            }
        },


        async startReminderCronJob() {
            try {
                cron.schedule('* * * * *', async () => {
                    console.log("Running cron job to send reminders.");
                    try {
                        const now = new Date().toISOString();

                        const { data: dueReminders, error } = await client
                            .from('reminders')
                            .select('*')
                            .eq('sent', false)
                            .lte('remind_at', now);

                        if (error) throw error;

                        for (const reminder of dueReminders) {
                            console.log(`Sending reminder to ${reminder.user_id}`);
                            await sendReminder(reminder.user_id, reminder.content);

                            await client
                                .from('reminders')
                                .update({ sent: true })
                                .eq('id', reminder.id);
                        }
                    } catch (err) {
                        console.error('Error checking reminders:', err.message);
                    }
                });
                console.log("Cron job scheduled to run every minute for reminders.");

            } catch (error) {
                console.error("Failed to start cron job:", error.message);
                throw new Error("Failed to start subscription cron job.");
            }
        },

        async startCleanupCronJob() {
            cron.schedule('*/10 * * * *', async () => {
                try {
                    console.log('Running chat history cleanup');
                    const threshold = new Date(Date.now() - 30 * 60 * 1000).toISOString();

                    const { data: inactiveUsers, error } = await client
                        .from('user_activity')
                        .select('user_id')
                        .lte('last_active_at', threshold);

                    if (error) throw error;

                    for (const user of inactiveUsers) {
                        const userId = user.user_id;

                        console.log(`Clearing chat history for inactive user: ${userId}`);

                        await client
                            .from('chat_logs')
                            .delete()
                            .eq('user_id', userId);
                    }
                } catch (err) {
                    console.error('Cleanup error:', err.message);
                }
            });
        },
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
        await this.startReminderCronJob();
        await this.startCleanupCronJob();
    },

    /**
     * Service stopped lifecycle event handler
     */
    async stopped() {

    }
};
