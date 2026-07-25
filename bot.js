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

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] 
});

// Configure Role IDs
const EXE_ROLE_ID = process.env.EXE_ROLE_ID || '1530696299358191706';
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || '1488588617503867070'; // Replace or set in .env

// Register Slash Commands (/panel & /admin)
const commands = [
    new SlashCommandBuilder()
        .setName('panel')
        .setDescription('Open the User Control Panel to check trial status or renew'),
    new SlashCommandBuilder()
        .setName('admin')
        .setDescription('Admin Panel: Manage user accounts (Admin Only)')
        .addUserOption(option => 
            option.setName('target')
                .setDescription('The user to manage')
                .setRequired(true))
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

client.once('clientReady', async () => {
    console.log(`🤖 Discord Bot online as ${client.user.tag}`);

    try {
        await rest.put(
            Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
            { body: commands }
        );
        console.log('✅ Slash commands (/panel, /admin) registered globally.');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
});

// Helper: Build User Panel Embed & Components
function createPanelComponents(row) {
    const trialExpiry = new Date(row.trial_expiry);
    const now = new Date();
    const isExpired = now > trialExpiry;
    const status = row.status || 'active';

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

    const renewButton = new ButtonBuilder()
        .setCustomId('renew_trial')
        .setLabel('🔄 Renew Trial (+2 Days)')
        .setStyle(ButtonStyle.Success)
        .setDisabled(status === 'banned');

    const rowComponent = new ActionRowBuilder().addComponents(renewButton);

    return { embed, rowComponent, status };
}

// Handle Slash Commands and Button Interactions
client.on('interactionCreate', async interaction => {

    // 1. /panel Command (User Panel)
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

    // 2. /admin Command (Admin Controls)
    if (interaction.isChatInputCommand() && interaction.commandName === 'admin') {
        const member = interaction.member;

        // Check if caller has the Admin Role
        if (ADMIN_ROLE_ID !== 'YOUR_ADMIN_ROLE_ID_HERE' && !member.roles.cache.has(ADMIN_ROLE_ID)) {
            return interaction.reply({
                content: '⛔ You do not have permission to use admin commands.',
                ephemeral: true
            });
        }

        const targetUser = interaction.options.getUser('target');

        try {
            const result = await db.execute({
                sql: 'SELECT * FROM users WHERE discord_id = ?',
                args: [targetUser.id]
            });

            const row = result.rows[0];

            if (!row) {
                return interaction.reply({
                    content: `❌ User <@${targetUser.id}> has no record in the database.`,
                    ephemeral: true
                });
            }

            const trialExpiry = new Date(row.trial_expiry);
            const unixTimestamp = Math.floor(trialExpiry.getTime() / 1000);

            const adminEmbed = new EmbedBuilder()
                .setTitle('⚙️ Admin Control Panel')
                .setColor(0x3498DB)
                .addFields(
                    { name: 'Target User', value: `<@${targetUser.id}> (\`${row.username}\`)`, inline: false },
                    { name: 'Status', value: row.status === 'banned' ? '⛔ Banned' : '✅ Active', inline: true },
                    { name: 'Trial Expiry', value: `<t:${unixTimestamp}:F>`, inline: false },
                    { name: 'Renewals Used', value: `\`${row.renewal_count}\``, inline: true }
                );

            const banBtn = new ButtonBuilder()
                .setCustomId(`admin_ban_${targetUser.id}`)
                .setLabel(row.status === 'banned' ? 'Unban User' : 'Ban User')
                .setStyle(row.status === 'banned' ? ButtonStyle.Success : ButtonStyle.Danger);

            const resetBtn = new ButtonBuilder()
                .setCustomId(`admin_reset_${targetUser.id}`)
                .setLabel('Reset Trial (+2 Days)')
                .setStyle(ButtonStyle.Primary);

            const actionRow = new ActionRowBuilder().addComponents(banBtn, resetBtn);

            return interaction.reply({
                embeds: [adminEmbed],
                components: [actionRow],
                ephemeral: true
            });

        } catch (err) {
            console.error('Admin Command Error:', err);
            return interaction.reply({ content: '⚠️ Error executing admin command.', ephemeral: true });
        }
    }

    // 3. Handle Button Interactions
    if (interaction.isButton()) {
        const customId = interaction.customId;
        const member = interaction.member;

        // --- RENEW TRIAL BUTTON (EXE Role check) ---
        if (customId === 'renew_trial') {
            if (!member.roles.cache.has(EXE_ROLE_ID)) {
                return interaction.reply({
                    content: `⛔ You need the <@&${EXE_ROLE_ID}> role to renew your trial!`,
                    ephemeral: true
                });
            }

            const userId = interaction.user.id;

            try {
                const result = await db.execute({
                    sql: 'SELECT * FROM users WHERE discord_id = ?',
                    args: [userId]
                });

                const row = result.rows[0];
                if (!row) return interaction.reply({ content: '❌ Account not found.', ephemeral: true });

                const now = new Date();
                const currentExpiry = new Date(row.trial_expiry);
                const baseTime = now > currentExpiry ? now : currentExpiry;
                const newExpiry = new Date(baseTime.getTime() + (2 * 24 * 60 * 60 * 1000));
                const newRenewalCount = Number(row.renewal_count || 0) + 1;

                await db.execute({
                    sql: 'UPDATE users SET trial_expiry = ?, renewal_count = ? WHERE discord_id = ?',
                    args: [newExpiry.toISOString(), newRenewalCount, userId]
                });

                const updatedResult = await db.execute({
                    sql: 'SELECT * FROM users WHERE discord_id = ?',
                    args: [userId]
                });

                const { embed, rowComponent } = createPanelComponents(updatedResult.rows[0]);

                return interaction.update({
                    content: '✅ **Trial extended by +2 days!**',
                    embeds: [embed],
                    components: [rowComponent]
                });

            } catch (err) {
                console.error('Renewal Error:', err);
                return interaction.reply({ content: '⚠️ Failed to renew trial.', ephemeral: true });
            }
        }

        // --- ADMIN BUTTON ACTIONS (Ban/Unban & Reset) ---
        if (customId.startsWith('admin_')) {
            if (ADMIN_ROLE_ID !== 'YOUR_ADMIN_ROLE_ID_HERE' && !member.roles.cache.has(ADMIN_ROLE_ID)) {
                return interaction.reply({ content: '⛔ Admin permissions required.', ephemeral: true });
            }

            const targetId = customId.split('_')[2];

            if (customId.startsWith('admin_ban_')) {
                const current = await db.execute({ sql: 'SELECT status FROM users WHERE discord_id = ?', args: [targetId] });
                const currentStatus = current.rows[0]?.status || 'active';
                const newStatus = currentStatus === 'banned' ? 'active' : 'banned';

                await db.execute({ sql: 'UPDATE users SET status = ? WHERE discord_id = ?', args: [newStatus, targetId] });

                return interaction.update({
                    content: `✅ User status updated to: **${newStatus.toUpperCase()}**`,
                    embeds: [],
                    components: []
                });
            }

            if (customId.startsWith('admin_reset_')) {
                const newExpiry = new Date(Date.now() + (2 * 24 * 60 * 60 * 1000));
                await db.execute({ sql: 'UPDATE users SET trial_expiry = ? WHERE discord_id = ?', args: [newExpiry.toISOString(), targetId] });

                return interaction.update({
                    content: `✅ Reset trial for <@${targetId}>. New Expiry set to +2 Days.`,
                    embeds: [],
                    components: []
                });
            }
        }
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);