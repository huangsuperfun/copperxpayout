const { Telegraf, Scenes, session } = require('telegraf');
const { message } = require('telegraf/filters');
const logger = require('../utils/logger');
const config = require('../config');
const { getUserToken, getOrganizationId } = require('../dependencies');
const PusherClient = require('../utils/pusherClient');

// Import command handlers
const { startCommand } = require('./commands/start');
const { loginScene } = require('./commands/login');
const { balanceCommand, balanceCallback, setDefaultWalletCallback } = require('./commands/balance');
const { transferScene } = require('./commands/transfer');
const { depositCommand, depositCallback } = require('./commands/deposit');
const { helpCommand } = require('./commands/help');
const { logoutCommand, logoutCallback } = require('./commands/logout');
const { testDepositCommand } = require('./commands/testDeposit');
const { profileCommand, profileCallback } = require('./commands/profile');
const { kycCommand } = require('./commands/kyc');
const { 
  transactionsCommand, 
  transactionCallbackHandler, 
  handleDeepLink 
} = require('./commands/transactions');
const { withdrawalScene } = require('./commands/withdrawal');
const { 
  payeeCommand, 
  payeeCallback,
  addPayeeScene
} = require('./commands/payee');

// Store PusherClients by user_id
const pusherClients = {};

// Bot instance
let botInstance = null;

/**
 * Connect to Pusher for real-time notifications
 * @param {number} userId - Telegram user ID
 * @param {string} accessToken - User's access token
 * @param {string} organizationId - User's organization ID
 */
async function connectToPusher(userId, accessToken, organizationId) {
  try {
    // Check if there's an existing client
    if (pusherClients[userId]) {
      // Disconnect existing client
      await pusherClients[userId].disconnect();
      delete pusherClients[userId];
    }
    
    // Create new Pusher client
    const pusherClient = new PusherClient(userId, accessToken, organizationId);
    pusherClient.initialize();
    
    // Store the client
    pusherClients[userId] = pusherClient;
    
    logger.info(`Connected to Pusher for user ${userId}`);
  } catch (error) {
    logger.error(`Failed to connect to Pusher: ${error.message}`);
  }
}

/**
 * Handle deposit notifications
 * @param {number} userId - Telegram user ID
 * @param {Object} data - Notification data
 */
async function handleDepositNotification(userId, data) {
  try {
    if (!botInstance) {
      throw new Error('Bot instance not initialized');
    }
    
    // Format the notification message
    const message = `
💰 *New Deposit Received*

Amount: ${data.amount} ${data.currency}
Network: ${data.network}
Transaction ID: \`${data.transactionId}\`
    `.trim();
    
    // Send the notification
    await botInstance.telegram.sendMessage(userId, message, {
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error(`Error sending deposit notification: ${error.message}`);
  }
}

/**
 * Initialize and start the Telegram bot
 */
function startBot() {
  // Create the bot
  const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
  botInstance = bot;
  PusherClient.setBotInstance(bot);
  
  // Set the deposit notification handler
  PusherClient.setDepositNotificationHandler(handleDepositNotification);
  
  // Set up sessions and scenes middleware
  const stage = new Scenes.Stage([
    loginScene,
    transferScene,
    withdrawalScene,
    addPayeeScene
  ]);
  
  bot.use(session());
  bot.use(stage.middleware());
  
  // Set up command handlers
  bot.start(async (ctx) => {
    // Check if this is a deep link
    if (ctx.startPayload) {
      // Handle transaction deep links
      if (ctx.startPayload.startsWith('tx_')) {
        await handleDeepLink(ctx);
        return;
      }
    }
    
    // Regular start command
    await startCommand(ctx);
  });
  
  // Login command
  bot.command('login', (ctx) => ctx.scene.enter('login-scene'));
  bot.action('login', (ctx) => ctx.scene.enter('login-scene'));
  
  // Balance command
  bot.command('balance', balanceCommand);
  bot.action(/^(change_default|back_to_balance|no_action)$/, balanceCallback);
  bot.action(/^set_default_/, setDefaultWalletCallback);
  
  // Transfer command
  bot.command('send', (ctx) => ctx.scene.enter('transfer-scene'));
  
  // Withdrawal command
  bot.command('withdrawal', (ctx) => ctx.scene.enter('withdrawal-scene'));
  

  
  // Transactions command
  bot.command('transactions', transactionsCommand);
  bot.action(/^tx_/, transactionCallbackHandler);
  
  // Register the payee command
  bot.command('payee', payeeCommand);
  bot.action(/^(add_payee|edit_payee|delete_payee|back_to_payee_list)$/, payeeCallback);
  bot.action(/^edit_payee_[a-zA-Z0-9-]+$/, payeeCallback);
  bot.action(/^delete_payee_[a-zA-Z0-9-]+$/, payeeCallback);
  bot.action(/^delete_payee_confirm_[a-zA-Z0-9-]+$/, payeeCallback);
  // Help command
  bot.command('help', helpCommand);
  
  // Logout command
  bot.command('logout', logoutCommand);
  bot.action(/^(confirm|cancel)_logout$/, logoutCallback);
  
  // Test deposit command (only in debug mode)
  if (config.DEBUG) {
    bot.command('test_deposit', testDepositCommand);
    logger.info('Debug mode enabled - test_deposit command registered');
  }
  
  // Profile command
  bot.command('myprofile', profileCommand);
  bot.action('view_profile', profileCallback);
  
  // Deposit command
  bot.command('deposit', depositCommand);
  bot.action('deposit', depositCommand);
  bot.action(/^(deposit_|back_to_deposit)/, depositCallback);
  
  // KYC command
  bot.command('kyc', kycCommand);
  
  // Set up webhook or polling based on environment
  if (config.WEBHOOK_URL) {
    // Use webhook for production
    const webhookUrl = `${config.WEBHOOK_URL}${config.WEBHOOK_SECRET_PATH}`;
    bot.telegram.setWebhook(webhookUrl);
    logger.info(`Bot started with webhook at ${webhookUrl}`);
    
    // Export the webhook handler for Express
    module.exports.webhookCallback = bot.webhookCallback(config.WEBHOOK_SECRET_PATH);
  } else {
    // Use polling for development
    bot.launch();
    logger.info('Bot started with polling');
    
    // Enable graceful stop
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
  }
  
  return bot;
}

// Export functions and variables
module.exports = {
  startBot,
  connectToPusher,
  handleDepositNotification,
  pusherClients
};