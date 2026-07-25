require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    EmbedBuilder, 
    ActionRowBuilder, 
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const db = new sqlite3.Database('./database.db');

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const ADMIN_ROLE_ID = '1488588617503867070';

if (!BOT_TOKEN) {
    console.error("❌ ERROR: DISCORD_BOT_TOKEN is missing in .env!");
    process.exit(1);
}

// Register /panel command
const commands = [
    new SlashCommandBuilder()
        .setName('panel')
        .setDescription('Open the User & Admin Control Panel')
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

(async () => {
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('Slash commands registered.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
})();

// Helper to check Admin Role
function hasAdminRole(interaction) {
    if (!interaction.member || !interaction.member.roles) return false;
    return interaction.member.roles.cache.has(ADMIN_ROLE_ID);
}

client.on('interactionCreate', async interaction => {

    // 1. SLASH COMMAND: /panel
    if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
        const embed = new EmbedBuilder()
            .setTitle('🛠️ Application Control Panel')
            .setDescription('Select an action from the menu below.\n*(Admin options require the Admin Role)*')
            .setColor(0x5865F2);

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('panel_actions_menu')
            .setPlaceholder('Choose an action...')
            .addOptions([
                // User Actions
                { label: 'Renew Trial (+1 Day)', description: 'Restart trial if expired', value: 'renew_trial', emoji: '🔄' },
                { label: 'Check My Trial Status', description: 'View expiry date & renewals', value: 'check_status', emoji: '📊' },
                
                // Admin Actions in ComboBox
                { label: '[Admin] Ban User', description: 'Ban a user by Username', value: 'admin_ban_modal', emoji: '⛔' },
                { label: '[Admin] Unban User', description: 'Unban a user by Username', value: 'admin_unban_modal', emoji: '✅' },
                { label: '[Admin] Extend Trial', description: 'Add custom hours to user trial', value: 'admin_extend_modal', emoji: '⏳' },
                { label: '[Admin] End Trial', description: 'Expire a user trial immediately', value: 'admin_endtrial_modal', emoji: '🛑' }
            ]);

        const row = new ActionRowBuilder().addComponents(selectMenu);
        return interaction.reply({ embeds: [embed], components: [row] });
    }

    // 2. COMBOBOX / SELECT MENU HANDLER
    if (interaction.isStringSelectMenu() && interaction.customId === 'panel_actions_menu') {
        const selectedValue = interaction.values[0];
        const discordId = interaction.user.id;

        // Check Admin Permissions for Admin Options
        if (selectedValue.startsWith('admin_')) {
            if (!hasAdminRole(interaction)) {
                return interaction.reply({
                    content: '❌ **Access Denied:** You need the Administrator role (ID: `1488588617503867070`) to perform this action.',
                    ephemeral: true
                });
            }
        }

        // USER OPTION: RENEW TRIAL
        if (selectedValue === 'renew_trial') {
            db.get('SELECT * FROM users WHERE discord_id = ?', [discordId], (err, row) => {
                if (err || !row) return interaction.reply({ content: '❌ Account not found. Please log in via the C# app first.', ephemeral: true });
                if (row.status === 'banned') return interaction.reply({ content: '⛔ Account is banned.', ephemeral: true });

                const now = new Date();
                const currentExpiry = new Date(row.trial_expiry);

                if (now < currentExpiry) {
                    return interaction.reply({ content: `⚠️ Active trial until **${currentExpiry.toLocaleString()}**. Can only renew after expiry.`, ephemeral: true });
                }

                const newExpiry = new Date(now.getTime() + (24 * 60 * 60 * 1000));
                const newCount = row.renewal_count + 1;

                db.run('UPDATE users SET trial_expiry = ?, renewal_count = ? WHERE discord_id = ?', [newExpiry.toISOString(), newCount, discordId], (uErr) => {
                    if (uErr) return interaction.reply({ content: '❌ Renewal failed.', ephemeral: true });
                    return interaction.reply({ content: `🎉 Trial renewed! New expiry: **${newExpiry.toLocaleString()}**`, ephemeral: true });
                });
            });
        }

        // USER OPTION: CHECK STATUS
        if (selectedValue === 'check_status') {
            db.get('SELECT * FROM users WHERE discord_id = ?', [discordId], (err, row) => {
                if (err || !row) return interaction.reply({ content: '❌ Account not found. Log in via C# app first.', ephemeral: true });
                const expiry = new Date(row.trial_expiry);
                const isExpired = new Date() > expiry;

                const embed = new EmbedBuilder()
                    .setTitle('📊 Account Status')
                    .setColor(isExpired ? 0xFF0000 : 0x00FF00)
                    .addFields(
                        { name: 'Status', value: row.status === 'banned' ? '⛔ Banned' : (isExpired ? '❌ Expired' : '✅ Active'), inline: true },
                        { name: 'Expiry Date', value: expiry.toLocaleString(), inline: false },
                        { name: 'Renewals', value: `${row.renewal_count}`, inline: true }
                    );
                return interaction.reply({ embeds: [embed], ephemeral: true });
            });
        }

        // ADMIN POPUP MODALS (Asking for Username)
        if (selectedValue === 'admin_ban_modal') {
            const modal = new ModalBuilder().setCustomId('modal_admin_ban').setTitle('Admin: Ban User');
            const userInput = new TextInputBuilder().setCustomId('target_username').setLabel("Discord Username (e.g. j4shed.ff)").setStyle(TextInputStyle.Short).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(userInput));
            return interaction.showModal(modal);
        }

        if (selectedValue === 'admin_unban_modal') {
            const modal = new ModalBuilder().setCustomId('modal_admin_unban').setTitle('Admin: Unban User');
            const userInput = new TextInputBuilder().setCustomId('target_username').setLabel("Discord Username (e.g. j4shed.ff)").setStyle(TextInputStyle.Short).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(userInput));
            return interaction.showModal(modal);
        }

        if (selectedValue === 'admin_endtrial_modal') {
            const modal = new ModalBuilder().setCustomId('modal_admin_endtrial').setTitle('Admin: End User Trial');
            const userInput = new TextInputBuilder().setCustomId('target_username').setLabel("Discord Username (e.g. j4shed.ff)").setStyle(TextInputStyle.Short).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(userInput));
            return interaction.showModal(modal);
        }

        if (selectedValue === 'admin_extend_modal') {
            const modal = new ModalBuilder().setCustomId('modal_admin_extend').setTitle('Admin: Extend Trial');
            const userInput = new TextInputBuilder().setCustomId('target_username').setLabel("Discord Username (e.g. j4shed.ff)").setStyle(TextInputStyle.Short).setRequired(true);
            const hoursInput = new TextInputBuilder().setCustomId('hours').setLabel("Hours to Add (e.g. 12, 24, 48)").setStyle(TextInputStyle.Short).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(userInput), new ActionRowBuilder().addComponents(hoursInput));
            return interaction.showModal(modal);
        }
    }

    // 3. SUBMITTED POPUP MODAL HANDLER (Searches DB by username)
    if (interaction.isModalSubmit()) {
        const targetUsername = interaction.fields.getTextInputValue('target_username').trim();

        if (interaction.customId === 'modal_admin_ban') {
            db.run(`UPDATE users SET status = 'banned' WHERE LOWER(username) = LOWER(?)`, [targetUsername], function(err) {
                if (err || this.changes === 0) return interaction.reply({ content: `❌ Username \`${targetUsername}\` not found in DB.`, ephemeral: true });
                return interaction.reply({ content: `⛔ Successfully **BANNED** user \`${targetUsername}\`.`, ephemeral: true });
            });
        }

        if (interaction.customId === 'modal_admin_unban') {
            db.run(`UPDATE users SET status = 'active' WHERE LOWER(username) = LOWER(?)`, [targetUsername], function(err) {
                if (err || this.changes === 0) return interaction.reply({ content: `❌ Username \`${targetUsername}\` not found in DB.`, ephemeral: true });
                return interaction.reply({ content: `✅ Successfully **UNBANNED** user \`${targetUsername}\`.`, ephemeral: true });
            });
        }

        if (interaction.customId === 'modal_admin_endtrial') {
            const pastDate = new Date(Date.now() - 86400000).toISOString();
            db.run(`UPDATE users SET trial_expiry = ? WHERE LOWER(username) = LOWER(?)`, [pastDate, targetUsername], function(err) {
                if (err || this.changes === 0) return interaction.reply({ content: `❌ Username \`${targetUsername}\` not found in DB.`, ephemeral: true });
                return interaction.reply({ content: `🛑 Ended trial for \`${targetUsername}\`.`, ephemeral: true });
            });
        }

        if (interaction.customId === 'modal_admin_extend') {
            const hours = parseInt(interaction.fields.getTextInputValue('hours').trim(), 10);
            if (isNaN(hours)) return interaction.reply({ content: '❌ Hours must be a valid number.', ephemeral: true });

            db.get(`SELECT * FROM users WHERE LOWER(username) = LOWER(?)`, [targetUsername], (err, row) => {
                if (err || !row) return interaction.reply({ content: `❌ Username \`${targetUsername}\` not found in DB.`, ephemeral: true });

                const currentExpiry = new Date(row.trial_expiry);
                const baseDate = new Date() > currentExpiry ? new Date() : currentExpiry;
                const newExpiry = new Date(baseDate.getTime() + (hours * 60 * 60 * 1000));

                db.run(`UPDATE users SET trial_expiry = ? WHERE LOWER(username) = LOWER(?)`, [newExpiry.toISOString(), targetUsername], (updateErr) => {
                    if (updateErr) return interaction.reply({ content: '❌ Extension failed.', ephemeral: true });
                    return interaction.reply({ content: `⏳ Extended \`${targetUsername}\` by **${hours} hours**. New expiry: **${newExpiry.toLocaleString()}**`, ephemeral: true });
                });
            });
        }
    }
});

client.login(BOT_TOKEN);