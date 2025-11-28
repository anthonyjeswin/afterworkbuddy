const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const cron = require('node-cron');
const axios = require('axios');

// Firebase setup
require('dotenv').config();
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();
app.use(bodyParser.json());

// Zoho Cliq Bot API
const BOT_API_URL = 'https://cliq.zoho.com/api/v2/bots/afterworkbuddy/message';
const BOT_INCOMING_URL = 'https://cliq.zoho.com/api/v2/bots/afterworkbuddy/incoming';
require('dotenv').config();
const BOT_AUTH_TOKEN = process.env.BOT_AUTH_TOKEN;


// Send message to user via Zoho Cliq Bot API
async function sendCliqMessage(userId, message) {
    try {
        await axios.post(BOT_API_URL, {
            text: message,
            user: { id: userId }
        }, {
            headers: {
                'Authorization': 'Zoho-oauthtoken ' + BOT_AUTH_TOKEN,
                'Content-Type': 'application/json'
            }
        });
    } catch (err) {
        console.error('Error sending message to user', userId, err.message);
    }
}

// Check if current time is within work hours
function isWorkTime(workStart, workEnd) {
    const now = new Date();
    const currentTime = now.toTimeString().substring(0, 5);
    const currentDay = now.getDay();
    if (currentDay === 0 || currentDay === 6) {
        return false;
    }
    if (currentTime >= workStart && currentTime < workEnd) {
        return true;
    } else {
        return false;
    }
}

// Process user preferences and determine mute/unmute
async function processUserChannels(userId) {
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            return null;
        }

        const userData = userDoc.data();
        const channels = userData.channels;
        const workStart = userData.workStart;
        const workEnd = userData.workEnd;
        const manualOverride = userData.manualOverride;
        const overrideUntil = userData.overrideUntil;

        if (!channels || !workStart || !workEnd) {
            return null;
        }

        let shouldMute = isWorkTime(workStart, workEnd);

        if (manualOverride !== undefined && overrideUntil) {
            const now = new Date();
            const until = new Date(overrideUntil);
            if (now < until) {
                shouldMute = manualOverride;
            }
        }

        let currentStatus = '';
        if (shouldMute === true) {
            currentStatus = 'Work Time (Please mute channels)';
        } else {
            currentStatus = 'Relax Time (Please unmute channels)';
        }

        await db.collection('users').doc(userId).set({
            lastProcessed: new Date().toISOString(),
            currentStatus: currentStatus
        }, { merge: true });

        // Send automatic message to user
        let action = '';
        if (shouldMute === true) {
            action = 'mute';
        } else {
            action = 'unmute';
        }
        const message = '🕒 Status Update: ' + currentStatus + '\nPlease manually ' + action + ' these channels: ' + channels.join(', ');
        await sendCliqMessage(userId, message);

        return {
            processed: channels.length,
            status: currentStatus,
            channels: channels,
            shouldMute: shouldMute
        };

    } catch (error) {
        console.error('Error processing channels for user ' + userId, error);
        throw error;
    }
}

// Scheduled task for all users
async function scheduledChannelCheck() {
    try {
        const usersSnapshot = await db.collection('users').get();
        for (const doc of usersSnapshot.docs) {
            const userId = doc.id;
            try {
                await processUserChannels(userId);
            } catch (err) {
                console.error('Failed to process user ' + userId, err);
            }
        }
        console.log('Scheduled check completed at', new Date().toLocaleString());
    } catch (err) {
        console.error('Scheduled check error:', err);
    }
}

// Incoming webhook for Cliq
app.post('/incoming', async(req, res) => {
    try {
        const data = req.body;
        const userId = data.sender.id;
        const userName = data.sender.name;
        const text = data.message.text.trim();

        if (!userId) {
            return res.status(400).json({ text: "❌ User ID not found" });
        }

        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            await userRef.set({
                name: userName,
                createdAt: new Date().toISOString(),
                notifications: true
            }, { merge: true });
        }

        let responseMessage = '';

        // Example commands
        if (text.startsWith("/afterwork setchannels")) {
            const channels = text.replace("/afterwork setchannels", "").trim().split(",").map(c => c.trim()).filter(c => c.length > 0);
            if (!channels.length) {
                responseMessage = "❌ Please provide channel names";
            } else {
                await userRef.set({ channels }, { merge: true });
                responseMessage = "✅ Channels saved: " + channels.join(", ");
            }
        } else if (text.startsWith("/afterwork sethours")) {
            const timeMatch = text.match(/\/afterwork sethours\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
            if (timeMatch) {
                const workStart = timeMatch[1];
                const workEnd = timeMatch[2];
                await userRef.set({ workStart, workEnd }, { merge: true });
                responseMessage = "✅ Work hours saved: " + workStart + " - " + workEnd;
            } else {
                responseMessage = "❌ Invalid format. Use `/afterwork sethours 09:00-17:00`";
            }
        } else if (text.startsWith("/afterwork status")) {
            const userData = (await userRef.get()).data();
            responseMessage = "Channels: " + (userData.channels || []).join(", ") + "\nWork Hours: " + (userData.workStart || 'Not set') + " - " + (userData.workEnd || 'Not set') + "\nCurrent Status: " + (userData.currentStatus || 'N/A');
        } else {
            responseMessage = "❌ Unknown command. Type `/afterwork help` for commands.";
        }

        res.json({ text: responseMessage });

    } catch (err) {
        console.error("Error processing webhook:", err);
        res.status(500).json({ text: "❌ Something went wrong." });
    }
});

// Health endpoint
app.get('/health', async(req, res) => {
    try {
        await db.collection('health').doc('check').set({ timestamp: new Date().toISOString() });
        res.json({ status: 'healthy', service: 'AfterWork Buddy', timestamp: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ status: 'unhealthy', error: err.message });
    }
});

// Cron jobs
cron.schedule('*/30 * * * *', scheduledChannelCheck);
cron.schedule('0 9,17 * * 1-5', scheduledChannelCheck);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('AfterWork Buddy running on port ' + PORT);
    console.log('Incoming Webhook Endpoint: ' + BOT_INCOMING_URL);
});
