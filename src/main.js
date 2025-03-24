const express = require('express');
const logger = require('./utils/logger');
const config = require('./config');
const telegramBot = require('./bot/telegramBot');

// Start the bot
const bot = telegramBot.startBot();

// Create Express app if webhook is enabled
if (config.WEBHOOK_URL) {
  const app = express();
  
  // Parse JSON body
  app.use(express.json());
  
  // Root endpoint
  app.get('/', (req, res) => {
    res.json({
      status: 'ok',
      message: 'Copperx Payout Telegram Bot API is running'
    });
  });
  
  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      bot_running: 'webhook_mode'
    });
  });
  
  // Use bot's webhook callback
  app.use(bot.webhookCallback(config.WEBHOOK_SECRET_PATH));
  
  // Start the server
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    logger.info(`Express server is running on port ${PORT}`);
  });
} else {
  // For development with polling, just log that the bot is running
  logger.info('Bot is running in polling mode');
}

// Handle graceful shutdown
const gracefulShutdown = () => {
  logger.info('Received shutdown signal, closing bot and connections...');
  
  // Stop bot if in polling mode
  if (!config.WEBHOOK_URL && bot) {
    bot.stop();
  }
  
  // Close other connections if needed
  
  logger.info('Graceful shutdown completed');
  process.exit(0);
};

// Listen for termination signals
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);