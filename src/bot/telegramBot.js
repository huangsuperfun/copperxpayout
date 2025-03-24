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
 * @param {string} accessToken - User's access token (optional)
 * @param {string} organizationId - User's organization ID (optional)
 */
async function connectToPusher(userId, accessToken = null, organizationId = null) {
  try {
    // Log that we're attempting to connect
    logger.info(`Attempting to connect to Pusher for user ${userId}`);
    
    // Check if there's an existing client
    if (pusherClients[userId]) {
      logger.info(`Found existing Pusher client for user ${userId}, disconnecting...`);
      // Disconnect existing client
      await pusherClients[userId].disconnect();
      delete pusherClients[userId];
    }
    
    // Get access token if not provided
    if (!accessToken) {
      logger.info(`No access token provided, retrieving for user ${userId}`);
      const tokenData = await getUserToken(userId);
      if (!tokenData || !tokenData.accessToken) {
        logger.error(`Failed to get access token for user ${userId}`);
        return;
      }
      accessToken = tokenData.accessToken;
      logger.info(`Retrieved access token for user ${userId}: ${accessToken.substring(0, 10)}...`);
    }
    
    // Get organization ID if not provided
    if (!organizationId) {
      logger.info(`No organization ID provided, retrieving for user ${userId}`);
      organizationId = await getOrganizationId(userId);
      if (organizationId) {
        logger.info(`Retrieved organization ID for user ${userId}: ${organizationId}`);
      } else {
        logger.warn(`No organization ID found for user ${userId}`);
      }
    }
    
    // Create new Pusher client
    logger.info(`Creating new PusherClient for user ${userId} with org ID ${organizationId || 'unknown'}`);
    const pusherClient = new PusherClient(userId, accessToken, organizationId);
    
    // Store the client
    pusherClients[userId] = pusherClient;
    
    // Subscribe to channels if organization ID is available
    if (organizationId) {
      // Try all possible channel formats
      const channelNames = [
        `org-${organizationId}`,
        `private-org-${organizationId}`
      ];
      
      for (const channelName of channelNames) {
        logger.info(`Subscribing to channel ${channelName} for user ${userId}`);
        await pusherClient.subscribe(channelName).catch(err => {
          logger.warn(`Failed to subscribe to ${channelName}: ${err.message}`);
        });
      }
    }
    
    logger.info(`Pusher setup completed for user ${userId}`);
    
    // Test connection
    setTimeout(() => {
      if (pusherClient.connected) {
        logger.info(`Pusher is connected for user ${userId}`);
      } else {
        logger.warn(`Pusher connection not confirmed for user ${userId}`);
      }
    }, 3000);
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
    // Log the received notification with full details
    logger.info(`DEPOSIT NOTIFICATION RECEIVED for user ${userId}`);
    logger.info(`Notification data: ${JSON.stringify(data)}`);
    
    if (!botInstance) {
      logger.error(`Bot instance not initialized when handling deposit for user ${userId}`);
      throw new Error('Bot instance not initialized');
    }
    
    // Format the notification message
    const message = `
💰 *New Deposit Received*

Amount: ${data.amount || '0'} ${data.currency || 'USDC'}
Network: ${data.network || 'Unknown'}
${data.address ? `Address: ${data.address.slice(0, 6)}...${data.address.slice(-4)}\n` : ''}Transaction ID: \`${data.transactionId || 'Unknown'}\`
    `.trim();
    
    // Try multiple methods to send the notification
    try {
      // Method 1: Direct telegram.sendMessage
      logger.info(`Attempting to send deposit notification to user ${userId} (Method 1)`);
      await botInstance.telegram.sendMessage(userId, message, {
        parse_mode: 'Markdown'
      });
      logger.info(`Successfully sent deposit notification to user ${userId} (Method 1)`);
    } catch (error1) {
      logger.error(`Failed to send notification (Method 1): ${error1.message}`);
      
      try {
        // Method 2: Get chat and send
        logger.info(`Attempting to send deposit notification to user ${userId} (Method 2)`);
        await botInstance.telegram.getChat(userId).then(async (chat) => {
          await botInstance.telegram.sendMessage(chat.id, message, {
            parse_mode: 'Markdown'
          });
        });
        logger.info(`Successfully sent deposit notification to user ${userId} (Method 2)`);
      } catch (error2) {
        logger.error(`Failed to send notification (Method 2): ${error2.message}`);
        throw new Error(`Failed to send notification: ${error1.message}, ${error2.message}`);
      }
    }
  } catch (error) {
    logger.error(`Error handling deposit notification: ${error.message}`);
    logger.error(`Stack trace: ${error.stack}`);
  }
}

/**
 * Initialize and start the Telegram bot
 */
function startBot() {
  // Create the bot
  const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
  botInstance = bot;
  
  // Set the bot instance in PusherClient
  PusherClient.setBotInstance(bot);
  
  // Set the deposit notification handler
  PusherClient.setDepositNotificationHandler(handleDepositNotification);
  
  // Log successful setup
  logger.info('PusherClient configured with bot instance and notification handler');
  
  // Set up sessions and scenes middleware
  const stage = new Scenes.Stage([
    loginScene,
    transferScene,
    withdrawalScene,
    addPayeeScene
  ]);
  
  bot.use(session());
  bot.use(stage.middleware());
  
  // Add debugging middleware in debug mode
  if (config.DEBUG) {
    bot.use((ctx, next) => {
      const update = ctx.update;
      const updateId = update.update_id;
      logger.debug(`Received update #${updateId}`);
      return next();
    });
  }
  
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