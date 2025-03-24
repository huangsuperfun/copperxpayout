const Pusher = require('pusher-js');
const axios = require('axios');
const logger = require('./logger');
const { PUSHER_APP_KEY, PUSHER_CLUSTER, COPPERX_API_BASE_URL } = require('../config');

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
      
      // Subscribe to the channel
      const channel = this.pusherClient.subscribe(fullChannelName);
      
      // Store the channel
      this.channels[fullChannelName] = channel;
      
      // Set up event handlers
      channel.bind('pusher:subscription_succeeded', () => {
        logger.info(`Successfully subscribed to ${fullChannelName} for user ${this.userId}`);
      });
      
      channel.bind('pusher:subscription_error', (error) => {
        logger.error(`Error subscribing to ${fullChannelName} for user ${this.userId}: ${error}`);
      });
      
      // Bind to all possible event types
      const eventTypes = ['deposit', 'transaction', 'transfer'];
      
      for (const eventType of eventTypes) {
        logger.info(`Binding to ${eventType} event on channel ${fullChannelName} for user ${this.userId}`);
        
        channel.bind(eventType, (data) => {
          logger.info(`Received ${eventType} event on channel ${fullChannelName} for user ${this.userId}`);
          logger.info(`Event data: ${JSON.stringify(data)}`);
          
          // If it's a deposit event, handle it
          if (eventType === 'deposit') {
            this.handleDepositEvent(data);
          }
        });
      }
      
      // Also bind to all events (capture any we didn't explicitly bind to)
      channel.bind_global((eventName, data) => {
        if (!eventTypes.includes(eventName) && !eventName.startsWith('pusher:')) {
          logger.info(`Received global event ${eventName} on channel ${fullChannelName} for user ${this.userId}`);
          logger.info(`Event data: ${JSON.stringify(data)}`);
          
          // If it contains deposit-related fields, handle it as deposit
          if (data && (data.amount || data.transactionId)) {
            this.handleDepositEvent(data);
          }
        }
      });
      
      return channel;
    } catch (error) {
      logger.error(`Error subscribing to channel ${channelName} for user ${this.userId}: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Handle deposit event
   * @param {Object} data - Deposit event data
   */
  async handleDepositEvent(data) {
    try {
      logger.info(`Deposit event received for user ${this.userId}`);
      logger.info(`Deposit data: ${JSON.stringify(data)}`);
      
      // Extract deposit information
      const amount = data.amount || '0';
      const currency = data.currency || 'USDC';
      const network = data.network || 'Unknown';
      const txId = data.transactionId || 'Unknown';
      
      // Format notification message
      const message = `
💰 *New Deposit Received*

Amount: ${amount} ${currency}
Network: ${network}
Transaction ID: \`${txId}\`
      `.trim();
      
      // Try to handle via the static notification handler first
      if (PusherClient.depositNotificationHandler) {
        try {
          logger.info(`Calling depositNotificationHandler for user ${this.userId}`);
          await PusherClient.depositNotificationHandler(this.userId, data);
          return; // If successful, we're done
        } catch (handlerError) {
          logger.error(`Error in depositNotificationHandler: ${handlerError.message}`);
          // Continue to fallback
        }
      } else {
        logger.warn(`No depositNotificationHandler set for user ${this.userId}`);
      }
      
      // Fallback: Try to send via bot instance directly
      if (PusherClient.botInstance) {
        try {
          logger.info(`Sending notification directly via bot instance for user ${this.userId}`);
          await PusherClient.botInstance.telegram.sendMessage(
            this.userId,
            message,
            { parse_mode: 'Markdown' }
          );
          
          logger.info(`Successfully sent deposit notification to user ${this.userId}`);
        } catch (botError) {
          logger.error(`Failed to send notification via bot: ${botError.message}`);
          throw botError;
        }
      } else {
        logger.error(`Cannot send notification: Bot instance not set for user ${this.userId}`);
      }
    } catch (error) {
      logger.error(`Error handling deposit event for user ${this.userId}: ${error.message}`);
      logger.error(`Stack trace: ${error.stack}`);
    }
  }
  
  /**
   * Simulate a deposit event for testing
   * @param {string} network - Network name
   * @param {string} address - Wallet address
   * @param {string} amount - Amount deposited
   * @param {string} currency - Currency code
   * @returns {string} Notification message
   */
  async simulateDeposit(network, address, amount, currency = 'USDC') {
    try {
      // Create mock deposit event data
      const data = {
        amount,
        currency,
        network,
        address,
        transactionId: `sim_${Date.now().toString(36)}`
      };
      
      logger.info(`Simulating deposit for user ${this.userId}`);
      logger.info(`Simulation data: ${JSON.stringify(data)}`);
      
      // Call the deposit handler directly
      await this.handleDepositEvent(data);
      
      // Try the static handler too for redundancy
      if (PusherClient.depositNotificationHandler) {
        try {
          await PusherClient.depositNotificationHandler(this.userId, data);
        } catch (error) {
          logger.warn(`Static handler failed during simulation: ${error.message}`);
        }
      }
      
      // Format the notification message (for return value)
      return `
💰 *New Deposit Received (SIMULATED)*

Amount: ${amount} ${currency}
Network: ${network}
Address: ${address.slice(0, 6)}...${address.slice(-4)}
Transaction ID: ${data.transactionId}
      `.trim();
    } catch (error) {
      logger.error(`Error simulating deposit for user ${this.userId}: ${error.message}`);
      throw error;
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