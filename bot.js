require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { createClient } = require('@libsql/client');

// Connect to Turso DB (or local fallback)
const db = createClient({
    url: process.env.TURSO_DATABASE_URL || "file:database.db",
    authToken: process.env.TURSO_AUTH_TOKEN
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Register /panel command
const commands = [
    new SlashCommandBuilder()
        .setName('panel')
        .setDescription('Open the User Control Panel to check trial status or renew')
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

client.once('ready', async () => {
    console.log(`🤖 Discord Bot online as ${client.user.tag}`);

    try {
        await rest.put(
            Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
            { body: commands }
        );
        console.log('✅ Slash command (/panel) registered globally.');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
});

// Handle /panel Command
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'panel') {
        const userId = interaction.user.id;

        try {
            const result = await db.execute({
                sql: 'SELECT * FROM users WHERE discord_id = ?',
                args: [userId]
            });

            const row = result.rows[0];

            if (!row) {
                return interaction.reply({
                    content: '❌ No active account found for your Discord ID. Please log in through the application first.',
                    ephemeral: true
                });
            }

            const trialExpiry = new Date(row.trial_expiry);
            const now = new Date();
            const isExpired = now > trialExpiry;
            const status = row.status || 'active';

            if (status === 'banned') {
                return interaction.reply({
                    content: '⛔ Your account has been banned by an administrator.',
                    ephemeral: true
                });
            }

            const embed = new EmbedBuilder()
                .setTitle('👤 User Control Panel')
                .setColor(isExpired ? 0xFF0000 : 0x00FF00)
                .addFields(
                    { name: 'Username', value: row.username, inline: true },
                    { name: 'Status', value: isExpired ? '❌ Expired' : '✅ Active', inline: true },
                    { name: 'Trial Expiry', value: trialExpiry.toLocaleString(), inline: false },
                    { name: 'Renewals Used', value: `${row.renewal_count}`, inline: true }
                )
                .setTimestamp();

            return interaction.reply({ embeds: [embed], ephemeral: true });

        } catch (err) {
            console.error('Database query error:', err);
            return interaction.reply({
                content: '⚠️ An error occurred while retrieving your account info.',
                ephemeral: true
            });
        }
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);