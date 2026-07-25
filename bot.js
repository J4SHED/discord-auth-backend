require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle 
} = require('discord.js');
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

client.once('clientReady', async () => {
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

// Helper function to build Panel Embed & Action Row
function createPanelComponents(row) {
    const trialExpiry = new Date(row.trial_expiry);
    const now = new Date();
    const isExpired = now > trialExpiry;
    const status = row.status || 'active';

    // Discord Unix Timestamp for dynamic formatting (<t:UNIX:F> and <t:UNIX:R>)
    const unixTimestamp = Math.floor(trialExpiry.getTime() / 1000);

    const embed = new EmbedBuilder()
        .setTitle('👤 User Control Panel')
        .setColor(status === 'banned' ? 0x000000 : (isExpired ? 0xFF0000 : 0x00FF00))
        .addFields(
            { name: 'Username', value: `\`${row.username}\``, inline: true },
            { name: 'Status', value: status === 'banned' ? '⛔ Banned' : (isExpired ? '❌ Expired' : '✅ Active'), inline: true },
            { name: 'Trial Expiry', value: `<t:${unixTimestamp}:F> (<t:${unixTimestamp}:R>)`, inline: false },
            { name: 'Renewals Used', value: `\`${row.renewal_count}\``, inline: true }
        )
        .setFooter({ text: 'JASH Authentication System' })
        .setTimestamp();

    // Add a Renew Trial Button if active or expired
    const renewButton = new ButtonBuilder()
        .setCustomId('renew_trial')
        .setLabel('🔄 Renew Trial (+2 Days)')
        .setStyle(ButtonStyle.Success)
        .setDisabled(status === 'banned');

    const rowComponent = new ActionRowBuilder().addComponents(renewButton);

    return { embed, rowComponent, status };
}

// Handle Slash Command & Button Interaction
client.on('interactionCreate', async interaction => {

    // 1. Handle Slash Command (/panel)
    if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
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

            const { embed, rowComponent, status } = createPanelComponents(row);

            if (status === 'banned') {
                return interaction.reply({
                    content: '⛔ Your account has been banned by an administrator.',
                    ephemeral: true
                });
            }

            return interaction.reply({ 
                embeds: [embed], 
                components: [rowComponent], 
                ephemeral: true 
            });

        } catch (err) {
            console.error('Database query error:', err);
            return interaction.reply({
                content: '⚠️ An error occurred while retrieving your account info.',
                ephemeral: true
            });
        }
    }

    // 2. Handle Button Click (Renew Trial)
    if (interaction.isButton() && interaction.customId === 'renew_trial') {
        const userId = interaction.user.id;

        try {
            const result = await db.execute({
                sql: 'SELECT * FROM users WHERE discord_id = ?',
                args: [userId]
            });

            const row = result.rows[0];

            if (!row) {
                return interaction.reply({ content: '❌ Account not found.', ephemeral: true });
            }

            const now = new Date();
            const currentExpiry = new Date(row.trial_expiry);
            
            // Add 2 days from either NOW or current Expiry (whichever is later)
            const baseTime = now > currentExpiry ? now : currentExpiry;
            const newExpiry = new Date(baseTime.getTime() + (2 * 24 * 60 * 60 * 1000));
            const newRenewalCount = Number(row.renewal_count || 0) + 1;

            // Update Database
            await db.execute({
                sql: 'UPDATE users SET trial_expiry = ?, renewal_count = ? WHERE discord_id = ?',
                args: [newExpiry.toISOString(), newRenewalCount, userId]
            });

            // Fetch updated record for fresh display
            const updatedResult = await db.execute({
                sql: 'SELECT * FROM users WHERE discord_id = ?',
                args: [userId]
            });

            const updatedRow = updatedResult.rows[0];
            const { embed, rowComponent } = createPanelComponents(updatedRow);

            // Update the interaction message in real time
            return interaction.update({
                content: '✅ **Trial successfully extended by +2 days!**',
                embeds: [embed],
                components: [rowComponent]
            });

        } catch (err) {
            console.error('Renewal Error:', err);
            return interaction.reply({
                content: '⚠️ Failed to renew trial. Please try again later.',
                ephemeral: true
            });
        }
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);