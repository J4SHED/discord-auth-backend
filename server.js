require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@libsql/client');

const app = express();

app.use(express.json());
app.use(cors());

const db = createClient({
    url: process.env.TURSO_DATABASE_URL || "file:database.db",
    authToken: process.env.TURSO_AUTH_TOKEN
});

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const REDIRECT_URI = 'http://localhost:5000/callback/';

async function initDb() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS users (
            discord_id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            trial_start TEXT NOT NULL,
            trial_expiry TEXT NOT NULL,
            renewal_count INTEGER DEFAULT 0,
            last_login TEXT NOT NULL,
            status TEXT DEFAULT 'active'
        )
    `);

    try {
        await db.execute(
            'ALTER TABLE users ADD COLUMN last_renewal_at TEXT;'
        );
    } catch (_) {
    }

    try {
        await db.execute(
            'ALTER TABLE users ADD COLUMN daily_renewal_count INTEGER DEFAULT 0;'
        );
    } catch (_) {
    }

    console.log("Database initialized.");
}

const dbReady = initDb();

app.get('/health', async (req, res) => {
    try {
        await dbReady;

        res.json({
            success: true,
            message: 'JASH authentication backend is online.'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Database unavailable.'
        });
    }
});

app.post('/api/auth/discord', async (req, res) => {
    try {
        await dbReady;

        const { code, redirect_uri } = req.body;

        if (!code) {
            return res.status(400).json({
                success: false,
                message: 'Missing Discord authorization code.'
            });
        }

        if (redirect_uri !== REDIRECT_URI) {
            return res.status(400).json({
                success: false,
                message: 'Invalid redirect URI.'
            });
        }

        if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
            console.error('Discord OAuth credentials are missing.');

            return res.status(500).json({
                success: false,
                message: 'Discord authentication is not configured.'
            });
        }

        const tokenResponse = await axios.post(
            'https://discord.com/api/v10/oauth2/token',
            new URLSearchParams({
                client_id: DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI
            }),
            {
                headers: {
                    'Content-Type':
                        'application/x-www-form-urlencoded'
                },
                timeout: 15000
            }
        );

        const accessToken =
            tokenResponse.data.access_token;

        if (!accessToken) {
            return res.status(401).json({
                success: false,
                message: 'Discord did not return an access token.'
            });
        }

        const userResponse = await axios.get(
            'https://discord.com/api/v10/users/@me',
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`
                },
                timeout: 15000
            }
        );

        const user = userResponse.data;

        if (!user || !user.id || !user.username) {
            return res.status(401).json({
                success: false,
                message: 'Invalid Discord user response.'
            });
        }

        const now = new Date();

        const existing = await db.execute({
            sql: 'SELECT * FROM users WHERE discord_id = ?',
            args: [user.id]
        });

        let row = existing.rows[0];

        if (!row) {
            const trialStart = now;

            // First login = 48-hour trial.
            const trialExpiry =
                new Date(
                    now.getTime() +
                    (48 * 60 * 60 * 1000)
                );

            await db.execute({
                sql: `
                    INSERT INTO users
                    (
                        discord_id,
                        username,
                        trial_start,
                        trial_expiry,
                        renewal_count,
                        last_login,
                        status,
                        last_renewal_at,
                        daily_renewal_count
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                args: [
                    user.id,
                    user.username,
                    trialStart.toISOString(),
                    trialExpiry.toISOString(),
                    0,
                    now.toISOString(),
                    'active',
                    null,
                    0
                ]
            });

            row = {
                discord_id: user.id,
                username: user.username,
                trial_start: trialStart.toISOString(),
                trial_expiry: trialExpiry.toISOString(),
                renewal_count: 0,
                last_login: now.toISOString(),
                status: 'active'
            };
        } else {
            await db.execute({
                sql: `
                    UPDATE users
                    SET last_login = ?, username = ?
                    WHERE discord_id = ?
                `,
                args: [
                    now.toISOString(),
                    user.username,
                    user.id
                ]
            });

            row.username = user.username;
            row.last_login = now.toISOString();
        }

        const trialExpiry =
            new Date(row.trial_expiry);

        const status =
            row.status || 'active';

        const renewalCount =
            Number(row.renewal_count || 0);

        if (status === 'banned') {
            await sendLogWebhook({
                discordId: user.id,
                username: user.username,
                lastLogin: now.toLocaleString(),
                trialExpiry: trialExpiry.toLocaleString(),
                renewalCount,
                statusText: '⛔ Banned by Admin'
            });

            return res.status(403).json({
                success: false,
                message:
                    'Your account has been banned by an administrator.'
            });
        }

        const isExpired =
            now.getTime() >= trialExpiry.getTime();

        await sendLogWebhook({
            discordId: user.id,
            username: user.username,
            lastLogin: now.toLocaleString(),
            trialExpiry: trialExpiry.toLocaleString(),
            renewalCount,
            statusText:
                isExpired
                    ? '❌ Expired'
                    : '✅ Active'
        });

        if (isExpired) {
            return res.status(403).json({
                success: false,
                message:
                    'Your trial has expired! Run /panel in Discord to renew it.'
            });
        }

        return res.json({
            success: true,
            message: 'Discord authentication successful.',
            user: {
                id: user.id,
                username: user.username,
                trial_start: row.trial_start,
                trial_expiry: trialExpiry.toISOString(),
                renewal_count: renewalCount
            }
        });

    } catch (error) {
        console.error(
            'Discord Authentication Error:',
            error.response?.data || error.message
        );

        return res.status(500).json({
            success: false,
            message:
                error.response?.data?.error_description ||
                error.response?.data?.message ||
                error.message ||
                'Authentication failed.'
        });
    }
});

async function sendLogWebhook(data) {
    if (!WEBHOOK_URL)
        return;

    const embed = {
        title: "🔑 User Login Event",
        color:
            data.statusText.includes('✅')
                ? 0x00FF00
                : 0xFF0000,

        fields: [
            {
                name: "User",
                value:
                    `${data.username} (<@${data.discordId}>)`,
                inline: true
            },
            {
                name: "Status",
                value: data.statusText,
                inline: true
            },
            {
                name: "Last Login",
                value: data.lastLogin,
                inline: false
            },
            {
                name: "Trial Expiry",
                value: data.trialExpiry,
                inline: true
            },
            {
                name: "Renewals Used",
                value: `${data.renewalCount}`,
                inline: true
            }
        ],

        timestamp: new Date().toISOString()
    };

    try {
        await axios.post(
            WEBHOOK_URL,
            { embeds: [embed] },
            { timeout: 10000 }
        );
    } catch (error) {
        console.error(
            "Webhook Error:",
            error.message
        );
    }
}

const PORT = process.env.PORT || 3000;

dbReady
    .then(() => {
        app.listen(PORT, () => {
            console.log(
                `API running on port ${PORT}`
            );
        });

        require('./bot.js');
    })
    .catch(error => {
        console.error(
            'Fatal database initialization error:',
            error
        );

        process.exit(1);
    });