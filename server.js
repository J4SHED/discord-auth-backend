require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@libsql/client');

const app = express();
app.use(express.json());
app.use(cors());

// Connect to Turso Cloud DB (or fallback to local sqlite file)
const db = createClient({
    url: process.env.TURSO_DATABASE_URL || "file:database.db",
    authToken: process.env.TURSO_AUTH_TOKEN
});

// Initialize Table
async function initDb() {
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS users (
                discord_id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                trial_start DATETIME NOT NULL,
                trial_expiry DATETIME NOT NULL,
                renewal_count INTEGER DEFAULT 0,
                last_login DATETIME NOT NULL,
                status TEXT DEFAULT 'active'
            )
        `);
        console.log("Connected and initialized DB.");
    } catch (err) {
        console.error("Database initialization error:", err);
    }
}
initDb();

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:5000/callback/';
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Handle OAuth Request from C# App
app.post('/api/auth/discord', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'Missing auth code.' });

    try {
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: DISCORD_CLIENT_ID,
            client_secret: DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: REDIRECT_URI
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const accessToken = tokenResponse.data.access_token;

        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const user = userResponse.data;
        const now = new Date();

        // Query user from DB
        const result = await db.execute({
            sql: 'SELECT * FROM users WHERE discord_id = ?',
            args: [user.id]
        });

        const row = result.rows[0];
        let trialExpiry;
        let renewalCount = 0;
        let status = 'active';

        if (!row) {
            // First Time User: 2-Day Trial
            trialExpiry = new Date(now.getTime() + (2 * 24 * 60 * 60 * 1000));
            await db.execute({
                sql: `INSERT INTO users (discord_id, username, trial_start, trial_expiry, renewal_count, last_login, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                args: [user.id, user.username, now.toISOString(), trialExpiry.toISOString(), 0, now.toISOString(), 'active']
            });
        } else {
            trialExpiry = new Date(row.trial_expiry);
            renewalCount = Number(row.renewal_count);
            status = row.status || 'active';
            await db.execute({
                sql: `UPDATE users SET last_login = ?, username = ? WHERE discord_id = ?`,
                args: [now.toISOString(), user.username, user.id]
            });
        }

        // Check if user is banned by admin
        if (status === 'banned') {
            await sendLogWebhook({
                discordId: user.id,
                username: user.username,
                lastLogin: now.toLocaleString(),
                trialExpiry: trialExpiry.toLocaleString(),
                renewalCount: renewalCount,
                statusText: '⛔ Banned by Admin'
            });

            return res.status(403).json({
                success: false,
                message: 'Your account has been banned by an administrator.'
            });
        }

        const isExpired = now > trialExpiry;

        await sendLogWebhook({
            discordId: user.id,
            username: user.username,
            lastLogin: now.toLocaleString(),
            trialExpiry: trialExpiry.toLocaleString(),
            renewalCount: renewalCount,
            statusText: isExpired ? '❌ Expired' : '✅ Active'
        });

        if (isExpired) {
            return res.status(403).json({
                success: false,
                message: 'Your trial has expired! Run the /panel command in Discord to renew.'
            });
        }

        return res.json({
            success: true,
            message: 'Login successful.',
            user: {
                id: user.id,
                username: user.username,
                trial_expiry: trialExpiry.toISOString(),
                renewal_count: renewalCount
            }
        });

    } catch (error) {
        console.error("Auth Error:", error.response?.data || error.message);
        return res.status(500).json({ success: false, message: 'Authentication failed.' });
    }
});

// Sends webhook notification log to Discord channel
async function sendLogWebhook(data) {
    if (!WEBHOOK_URL) return;
    const embed = {
        title: "🔑 User Login Event",
        color: data.statusText.includes('✅') ? 0x00FF00 : 0xFF0000,
        fields: [
            { name: "User", value: `${data.username} (<@${data.discordId}>)`, inline: true },
            { name: "Status", value: data.statusText, inline: true },
            { name: "Last Login", value: data.lastLogin, inline: false },
            { name: "Trial Expiry", value: data.trialExpiry, inline: true },
            { name: "Renewals Used", value: `${data.renewalCount}`, inline: true },
            { name: "Need Actions?", value: "Type `/panel` in the server to access the Control Panel menu!", inline: false }
        ],
        timestamp: new Date().toISOString()
    };

    try {
        await axios.post(WEBHOOK_URL, { embeds: [embed] });
    } catch (e) {
        console.error("Webhook Error:", e.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));

// Load the Discord Bot alongside the Express server
require('./bot.js');