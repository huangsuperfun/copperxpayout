const Pusher = require('pusher-js');
const axios = require('axios');
const logger = require('./logger');
const { PUSHER_APP_KEY, PUSHER_CLUSTER, COPPERX_API_BASE_URL, NETWORK_NAMES } = require('../config');

// Initialize notification cache at the module level
const notificationCache = new Map();

/**
 * Client for Pusher service to handle real-time notifications
 */
class PusherClient {
  // Static properties for bot instance and notification handler
  static botInstance = null;
  static depositNotificationHandler = null;
  
  /**
   * Set the bot instance for notifications
   * @param {Object} bot - Telegraf bot instance
   */
  static setBotInstance(bot) {
    PusherClient.botInstance = bot;
    logger.info('Bot instance set in PusherClient');
  }
  
  /**
   * Set the deposit notification handler
   * @param {Function} handler - Function to handle deposit notifications
   */
  static setDepositNotificationHandler(handler) {
    PusherClient.depositNotificationHandler = handler;
    logger.info('Deposit notification handler set in PusherClient');
  }
  
  /**
   * Initialize the Pusher client
   * @param {number} userId - Telegram user ID
   * @param {string} accessToken - User's authentication token
   * @param {string} organizationId - User's organization ID
   */
  constructor(userId, accessToken, organizationId) {
    this.userId = userId;
    this.accessToken = accessToken;
    this.organizationId = organizationId;
    this.pusherClient = null;
    this.connected = false;
    this.channels = {};
    
    logger.info(`Creating PusherClient for user ${userId} with org ID ${organizationId || 'unknown'}`);
    
    // Initialize Pusher client
    this.initialize();
  }
  
  /**
   * Initialize the Pusher client
   */
  initialize() {
    try {
      logger.info(`Initializing Pusher client for user ${this.userId}`);
      
      // Initialize the Pusher client
      this.pusherClient = new Pusher(PUSHER_APP_KEY, {
        cluster: PUSHER_CLUSTER,
        enabledTransports: ['ws', 'wss'],
        authEndpoint: `${COPPERX_API_BASE_URL}/api/notifications/auth`,
        auth: {
          headers: {
            Authorization: `Bearer ${this.accessToken}`
          }
        }
      });
      
      // Set up connection handlers
      this.pusherClient.connection.bind('connected', () => {
        this.connected = true;
        logger.info(`Pusher connected for user ${this.userId}`);
        
        // Subscribe to organization channel when connected if available
        if (this.organizationId) {
          const channelName = `org-${this.organizationId}`;
          this.subscribe(channelName);
          
          // Also try private- prefix format
          const privateChannelName = `private-org-${this.organizationId}`;
          this.subscribe(privateChannelName);
        }
      });
      
      this.pusherClient.connection.bind('disconnected', () => {
        this.connected = false;
        logger.info(`Pusher disconnected for user ${this.userId}`);
      });
      
      this.pusherClient.connection.bind('error', (error) => {
        logger.error(`Pusher connection error for user ${this.userId}: ${error.message}`);
      });
      
      // Log connection state
      logger.info(`Pusher initialized for user ${this.userId}, connection state: ${this.pusherClient.connection.state}`);
      
    } catch (error) {
      logger.error(`Error initializing Pusher client for user ${this.userId}: ${error.message}`);
    }
  }
  
  /**
   * Handle deposit event
   * @param {Object} data - Deposit event data
   */
  async handleDepositEvent(data) {
    try {
      logger.info(`Deposit event received for user ${this.userId}`);
      
      // Only process if it's a valid deposit event
      if (!data || !data.metadata) {
        logger.warn(`Invalid deposit data received for user ${this.userId}`);
        return;
      }

      const { amount, currency } = data;
      const { network, txHash } = data.metadata;

      // Skip if missing required fields
      if (!amount || !txHash || !network) {
        logger.warn(`Missing required deposit data fields for user ${this.userId}`);
        return;
      }

      // Check for duplicate notification
      const cacheKey = `${this.userId}:${txHash}`;
      if (notificationCache.has(cacheKey)) {
        logger.info(`Skipping duplicate notification for txHash ${txHash}`);
        return;
      }

      // Add to cache immediately
      notificationCache.set(cacheKey, true);

      // Clear cache entry after 1 hour
      setTimeout(() => {
        notificationCache.delete(cacheKey);
      }, 3600000);

      // Get network name from config
      const networkName = NETWORK_NAMES?.[network] || network;

      // Format notification message
      const message = `
💰 *New Deposit Received*

Amount: ${amount} ${currency}
Network: ${networkName}
Transaction ID: \`${txHash}\``.trim();

      // Send notification
      if (PusherClient.botInstance) {
        await PusherClient.botInstance.telegram.sendMessage(
          this.userId,
          message,
          { parse_mode: 'Markdown' }
        );
        logger.info(`Sent deposit notification for txHash ${txHash} to user ${this.userId}`);
      } else {
        logger.error(`Cannot send notification: Bot instance not set for user ${this.userId}`);
      }

    } catch (error) {
      logger.error(`Error handling deposit event for user ${this.userId}: ${error.message}`);
      // Remove from cache if sending failed
      const cacheKey = `${this.userId}:${data?.metadata?.txHash}`;
      notificationCache.delete(cacheKey);
    }
  }
  
  /**
   * Subscribe to a channel
   * @param {string} channelName - Channel name to subscribe to
   * @returns {Object} Channel instance
   */
  async subscribe(channelName) {
    try {
      if (!this.pusherClient) {
        logger.error(`Cannot subscribe to ${channelName}: Pusher client not initialized for user ${this.userId}`);
        return null;
      }
      
      // Add private- prefix if not present for organization channels
      const fullChannelName = channelName.startsWith('private-') ? 
        channelName : 
        `private-${channelName}`;
      
      logger.info(`Subscribing to channel: ${fullChannelName} for user ${this.userId}`);
      
      // Unsubscribe first if already subscribed to prevent duplicate events
      if (this.channels[fullChannelName]) {
        this.unsubscribe(fullChannelName);
      }

      // Subscribe to the channel
      const channel = this.pusherClient.subscribe(fullChannelName);
      
      // Store the channel
      this.channels[fullChannelName] = channel;
      
      // Set up event handlers
      channel.bind('pusher:subscription_succeeded', () => {
        logger.info(`Successfully subscribed to ${fullChannelName} for user ${this.userId}`);
      });
      
      // Only bind to deposit event
      channel.bind('deposit', (data) => {
        logger.info(`Received deposit event on channel ${fullChannelName} for user ${this.userId}`);
        this.handleDepositEvent(data);
      });
      
      return channel;
    } catch (error) {
      logger.error(`Error subscribing to channel ${channelName} for user ${this.userId}: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Unsubscribe from a channel
   * @param {string} channelName - Channel name to unsubscribe from
   */
  unsubscribe(channelName) {
    try {
      if (!this.pusherClient) {
        logger.warn(`Cannot unsubscribe: Pusher client not initialized for user ${this.userId}`);
        return;
      }
      
      // Add private- prefix if not present
      const fullChannelName = channelName.startsWith('private-') ? 
        channelName : 
        `private-${channelName}`;
      
      // Unsubscribe from the channel
      this.pusherClient.unsubscribe(fullChannelName);
      
      // Remove from channels
      delete this.channels[fullChannelName];
      
      logger.info(`Unsubscribed from channel ${fullChannelName} for user ${this.userId}`);
    } catch (error) {
      logger.error(`Error unsubscribing from channel ${channelName} for user ${this.userId}: ${error.message}`);
    }
  }
  
  /**
   * Disconnect from Pusher
   */
  disconnect() {
    try {
      if (this.pusherClient) {
        // Unsubscribe from all channels
        for (const channelName in this.channels) {
          this.unsubscribe(channelName);
        }
        
        // Disconnect the client
        this.pusherClient.disconnect();
        this.connected = false;
        
        logger.info(`Disconnected from Pusher for user ${this.userId}`);
      } else {
        logger.warn(`No Pusher client to disconnect for user ${this.userId}`);
      }
    } catch (error) {
      logger.error(`Error disconnecting from Pusher for user ${this.userId}: ${error.message}`);
    }
  }
}

module.exports = PusherClient;