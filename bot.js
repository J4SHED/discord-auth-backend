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
    ButtonStyle,
    MessageFlags 
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
const EXE_PREMIUM_ROLE_ID = process.env.EXE_PREMIUM_ROLE_ID || 'YOUR_EXE_PREMIUM_ROLE_ID_HERE';
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || '1488588617503867070'; 

// Register Slash Commands (/panel & /admin)
const commands = [
    new SlashCommandBuilder()
        .setName('panel')
        .setDescription('Open the User Control Panel to check trial status or renew'),
    
    new SlashCommandBuilder()
        .setName('admin')
        .setDescription('Admin Panel: Manage user accounts')
        .addSubcommand(sub => 
            sub.setName('panel')
               .setDescription('Open Admin Control Panel with action buttons for a user')
               .addStringOption(opt => opt.setName('username').setDescription('Target username').setRequired(true)))
        .addSubcommand(sub => 
            sub.setName('ban')
               .setDescription('Ban a user by username')
               .addStringOption(opt => opt.setName('username').setDescription('Target username').setRequired(true)))
        .addSubcommand(sub => 
            sub.setName('unban')
               .setDescription('Unban a user by username')
               .addStringOption(opt => opt.setName('username').setDescription('Target username').setRequired(true)))
        .addSubcommand(sub => 
            sub.setName('endtrial')
               .setDescription('End trial immediately for a user')
               .addStringOption(opt => opt.setName('username').setDescription('Target username').setRequired(true)))
        .addSubcommand(sub => 
            sub.setName('extendtrial')
               .setDescription('Extend trial by custom hours')
               .addStringOption(opt => opt.setName('username').setDescription('Target username').setRequired(true))
               .addIntegerOption(opt => opt.setName('hours').setDescription('Hours to add').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('list')
               .setDescription('View a list of all registered users and their details'))
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
            { name: 'Total Renewals Used', value: `\`${row.renewal_count || 0}\``, inline: true }
        )
        .setFooter({ text: 'JASH Authentication System' })
        .setTimestamp();

    const renewButton = new ButtonBuilder()
        .setCustomId('renew_trial')
        .setLabel('🔄 Renew Trial (+1 Day)')
        .setStyle(ButtonStyle.Success)
        .setDisabled(status === 'banned');

    const rowComponent = new ActionRowBuilder().addComponents(renewButton);

    return { embed, rowComponent, status };
}

// Helper: Build Admin Panel Embed & Action Buttons
function createAdminPanelComponents(row) {
    const trialExpiry = new Date(row.trial_expiry);
    const unixTimestamp = Math.floor(trialExpiry.getTime() / 1000);

    const adminEmbed = new EmbedBuilder()
        .setTitle('⚙️ Admin Control Panel')
        .setColor(0x3498DB)
        .addFields(
            { name: 'Target User', value: `\`${row.username}\``, inline: true },
            { name: 'Discord ID', value: row.discord_id ? `<@${row.discord_id}>` : 'Not Linked', inline: true },
            { name: 'Status', value: row.status === 'banned' ? '⛔ Banned' : '✅ Active', inline: true },
            { name: 'Trial Expiry', value: `<t:${unixTimestamp}:F> (<t:${unixTimestamp}:R>)`, inline: false },
            { name: 'Total Renewals Used', value: `\`${row.renewal_count || 0}\``, inline: true }
        )
        .setFooter({ text: 'Admin Management Panel' })
        .setTimestamp();

    const banBtn = new ButtonBuilder()
        .setCustomId(`admin_ban_${row.username}`)
        .setLabel(row.status === 'banned' ? 'Unban User' : 'Ban User')
        .setStyle(row.status === 'banned' ? ButtonStyle.Success : ButtonStyle.Danger);

    const resetBtn = new ButtonBuilder()
        .setCustomId(`admin_reset_${row.username}`)
        .setLabel('🔄 Reset Trial (+1 Day)')
        .setStyle(ButtonStyle.Primary);

    const actionRow = new ActionRowBuilder().addComponents(banBtn, resetBtn);

    return { adminEmbed, actionRow };
}

// Handle Interactions
client.on('interactionCreate', async interaction => {

    // 1. /panel Command
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
                    flags: MessageFlags.Ephemeral
                });
            }

            const { embed, rowComponent, status } = createPanelComponents(row);

            if (status === 'banned') {
                return interaction.reply({
                    content: '⛔ Your account has been banned by an administrator.',
                    flags: MessageFlags.Ephemeral
                });
            }

            return interaction.reply({ 
                embeds: [embed], 
                components: [rowComponent], 
                flags: MessageFlags.Ephemeral 
            });

        } catch (err) {
            console.error('Database query error:', err);
            return interaction.reply({
                content: '⚠️ An error occurred while retrieving your account info.',
                flags: MessageFlags.Ephemeral
            });
        }
    }

    // 2. /admin Subcommands
    if (interaction.isChatInputCommand() && interaction.commandName === 'admin') {
        const member = interaction.member;

        // Check if caller has Admin Role
        if (!member.roles.cache.has(ADMIN_ROLE_ID)) {
            return interaction.reply({
                content: '⛔ You do not have permission to run admin commands.',
                flags: MessageFlags.Ephemeral
            });
        }

        const subcommand = interaction.options.getSubcommand();

        try {
            // --- ADMIN LIST USERS ---
            if (subcommand === 'list') {
                const usersRes = await db.execute('SELECT * FROM users');
                const users = usersRes.rows;

                if (users.length === 0) {
                    return interaction.reply({
                        content: 'ℹ️ No users found in the database.',
                        flags: MessageFlags.Ephemeral
                    });
                }

                const listEmbed = new EmbedBuilder()
                    .setTitle('📋 Registered Users List')
                    .setColor(0x3498DB)
                    .setFooter({ text: `Total Users: ${users.length}` })
                    .setTimestamp();

                users.slice(0, 25).forEach(u => {
                    const expiryUnix = u.trial_expiry ? Math.floor(new Date(u.trial_expiry).getTime() / 1000) : null;
                    const expiryStr = expiryUnix ? `<t:${expiryUnix}:R>` : 'N/A';
                    const discordTag = u.discord_id ? `<@${u.discord_id}>` : 'Not Linked';
                    const statusTag = u.status === 'banned' ? '⛔ Banned' : '✅ Active';

                    listEmbed.addFields({
                        name: `👤 ${u.username}`,
                        value: `• **Discord:** ${discordTag}\n• **Status:** ${statusTag}\n• **Expiry:** ${expiryStr}\n• **Renewals:** \`${u.renewal_count || 0}\``,
                        inline: true
                    });
                });

                return interaction.reply({
                    embeds: [listEmbed],
                    flags: MessageFlags.Ephemeral
                });
            }

            const username = interaction.options.getString('username');

            // Find target user by username
            const userRes = await db.execute({
                sql: 'SELECT * FROM users WHERE username = ?',
                args: [username]
            });

            const user = userRes.rows[0];
            if (!user) {
                return interaction.reply({
                    content: `❌ No user found in the database with username: **\`${username}\`**`,
                    flags: MessageFlags.Ephemeral
                });
            }

            // --- ADMIN PANEL WITH INTERACTIVE BUTTONS ---
            if (subcommand === 'panel') {
                const { adminEmbed, actionRow } = createAdminPanelComponents(user);
                return interaction.reply({
                    embeds: [adminEmbed],
                    components: [actionRow],
                    flags: MessageFlags.Ephemeral
                });
            }

            // --- ADMIN BAN ---
            if (subcommand === 'ban') {
                await db.execute({
                    sql: 'UPDATE users SET status = ? WHERE username = ?',
                    args: ['banned', username]
                });
                return interaction.reply({
                    content: `⛔ **\`${username}\`** has been successfully **banned**.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            // --- ADMIN UNBAN ---
            if (subcommand === 'unban') {
                await db.execute({
                    sql: 'UPDATE users SET status = ? WHERE username = ?',
                    args: ['active', username]
                });
                return interaction.reply({
                    content: `✅ **\`${username}\`** has been successfully **unbanned**.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            // --- ADMIN END TRIAL ---
            if (subcommand === 'endtrial') {
                const nowIso = new Date().toISOString();
                await db.execute({
                    sql: 'UPDATE users SET trial_expiry = ? WHERE username = ?',
                    args: [nowIso, username]
                });
                return interaction.reply({
                    content: `⏳ Trial for **\`${username}\`** has been ended immediately.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            // --- ADMIN EXTEND TRIAL (Custom Hours) ---
            if (subcommand === 'extendtrial') {
                const hoursToAdd = interaction.options.getInteger('hours');
                const currentExpiry = new Date(user.trial_expiry);
                const baseTime = new Date() > currentExpiry ? new Date() : currentExpiry;
                
                const newExpiry = new Date(baseTime.getTime() + (hoursToAdd * 60 * 60 * 1000));

                await db.execute({
                    sql: 'UPDATE users SET trial_expiry = ? WHERE username = ?',
                    args: [newExpiry.toISOString(), username]
                });

                const unixTimestamp = Math.floor(newExpiry.getTime() / 1000);

                return interaction.reply({
                    content: `✅ Extended trial for **\`${username}\`** by **${hoursToAdd} hours**.\nNew Expiry: <t:${unixTimestamp}:F> (<t:${unixTimestamp}:R>)`,
                    flags: MessageFlags.Ephemeral
                });
            }

        } catch (err) {
            console.error('Admin Subcommand Error:', err);
            return interaction.reply({
                content: '⚠️ An error occurred while processing the admin command.',
                flags: MessageFlags.Ephemeral
            });
        }
    }

    // 3. Button Interactions
    if (interaction.isButton()) {
        const customId = interaction.customId;
        const member = interaction.member;

        // --- USER RENEW TRIAL BUTTON ---
        if (customId === 'renew_trial') {
            const hasExe = member.roles.cache.has(EXE_ROLE_ID);
            const hasPremium = EXE_PREMIUM_ROLE_ID !== 'YOUR_EXE_PREMIUM_ROLE_ID_HERE' && member.roles.cache.has(EXE_PREMIUM_ROLE_ID);

            if (!hasExe && !hasPremium) {
                return interaction.reply({
                    content: `⛔ You need either the <@&${EXE_ROLE_ID}> or Premium role to renew your trial!`,
                    flags: MessageFlags.Ephemeral
                });
            }

            const userId = interaction.user.id;

            try {
                const result = await db.execute({
                    sql: 'SELECT * FROM users WHERE discord_id = ?',
                    args: [userId]
                });

                const row = result.rows[0];
                if (!row) return interaction.reply({ content: '❌ Account not found.', flags: MessageFlags.Ephemeral });

                const now = new Date();
                const lastRenewal = row.last_renewal_at ? new Date(row.last_renewal_at) : null;
                const dailyCount = Number(row.daily_renewal_count || 0);

                const maxRenewalsAllowed = hasPremium ? 3 : 1;
                let currentDailyCount = dailyCount;

                if (lastRenewal && (now.getTime() - lastRenewal.getTime()) > (24 * 60 * 60 * 1000)) {
                    currentDailyCount = 0;
                }

                if (currentDailyCount >= maxRenewalsAllowed) {
                    const resetTime = new Date(lastRenewal.getTime() + (24 * 60 * 60 * 1000));
                    const resetUnix = Math.floor(resetTime.getTime() / 1000);

                    return interaction.reply({
                        content: `⏳ **Cooldown Active!**\nYou have reached your maximum renewals (${maxRenewalsAllowed}/24 hrs).\nYou can renew again <t:${resetUnix}:R>.`,
                        flags: MessageFlags.Ephemeral
                    });
                }

                const currentExpiry = new Date(row.trial_expiry);
                const baseTime = now > currentExpiry ? now : currentExpiry;
                const newExpiry = new Date(baseTime.getTime() + (24 * 60 * 60 * 1000));

                const totalRenewalCount = Number(row.renewal_count || 0) + 1;
                const updatedDailyCount = currentDailyCount + 1;

                await db.execute({
                    sql: 'UPDATE users SET trial_expiry = ?, renewal_count = ?, last_renewal_at = ?, daily_renewal_count = ? WHERE discord_id = ?',
                    args: [newExpiry.toISOString(), totalRenewalCount, now.toISOString(), updatedDailyCount, userId]
                });

                const updatedResult = await db.execute({
                    sql: 'SELECT * FROM users WHERE discord_id = ?',
                    args: [userId]
                });

                const { embed, rowComponent } = createPanelComponents(updatedResult.rows[0]);

                return interaction.update({
                    content: `✅ **Trial extended by +1 day!** (${updatedDailyCount}/${maxRenewalsAllowed} renewals used today)`,
                    embeds: [embed],
                    components: [rowComponent]
                });

            } catch (err) {
                console.error('Renewal Error:', err);
                return interaction.reply({ content: '⚠️ Failed to renew trial.', flags: MessageFlags.Ephemeral });
            }
        }

        // --- ADMIN BUTTON ACTIONS (Ban/Unban & Reset Trial) ---
        if (customId.startsWith('admin_')) {
            if (!member.roles.cache.has(ADMIN_ROLE_ID)) {
                return interaction.reply({ content: '⛔ Admin permissions required.', flags: MessageFlags.Ephemeral });
            }

            const targetUsername = customId.split('_')[2];

            // ADMIN BAN / UNBAN BUTTON
            if (customId.startsWith('admin_ban_')) {
                const current = await db.execute({ sql: 'SELECT status FROM users WHERE username = ?', args: [targetUsername] });
                const currentStatus = current.rows[0]?.status || 'active';
                const newStatus = currentStatus === 'banned' ? 'active' : 'banned';

                await db.execute({ sql: 'UPDATE users SET status = ? WHERE username = ?', args: [newStatus, targetUsername] });

                const updatedUser = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [targetUsername] });
                const { adminEmbed, actionRow } = createAdminPanelComponents(updatedUser.rows[0]);

                return interaction.update({
                    content: `✅ Status updated to **${newStatus.toUpperCase()}** for **\`${targetUsername}\`**`,
                    embeds: [adminEmbed],
                    components: [actionRow]
                });
            }

            // ADMIN RESET TRIAL BUTTON (+1 Day / 24 Hours)
            if (customId.startsWith('admin_reset_')) {
                const newExpiry = new Date(Date.now() + (24 * 60 * 60 * 1000));
                await db.execute({ 
                    sql: 'UPDATE users SET trial_expiry = ?, daily_renewal_count = 0 WHERE username = ?', 
                    args: [newExpiry.toISOString(), targetUsername] 
                });

                const updatedUser = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [targetUsername] });
                const { adminEmbed, actionRow } = createAdminPanelComponents(updatedUser.rows[0]);

                return interaction.update({
                    content: `✅ **Trial reset to +1 day (24 hrs)** for **\`${targetUsername}\`**! Cooldown cleared.`,
                    embeds: [adminEmbed],
                    components: [actionRow]
                });
            }
        }
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);