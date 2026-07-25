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
        const username = interaction.options.getString('username');

        try {
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

    // 3. Button Interactions (User Renewal)
    if (interaction.isButton() && interaction.customId === 'renew_trial') {
        const member = interaction.member;

        if (!member.roles.cache.has(EXE_ROLE_ID)) {
            return interaction.reply({
                content: `⛔ You need the <@&${EXE_ROLE_ID}> role to renew your trial!`,
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
            return interaction.reply({ content: '⚠️ Failed to renew trial.', flags: MessageFlags.Ephemeral });
        }
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);