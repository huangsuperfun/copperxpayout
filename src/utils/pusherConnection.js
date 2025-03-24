const { getUserToken, getOrganizationId } = require('../dependencies');
const logger = require('./logger');
const PusherClient = require('./pusherClient');

// Import shared pusherClients object
const { pusherClients } = require('../bot/telegramBot');

async function connectToPusher(userId, accessToken = null, organizationId = null) {
  try {
    logger.info(`Attempting to connect to Pusher for user ${userId}`);

    if (pusherClients[userId]) {
      logger.info(`Found existing Pusher client for user ${userId}, disconnecting...`);
      await pusherClients[userId].disconnect();
      delete pusherClients[userId];
    }

    if (!accessToken) {
      const tokenData = await getUserToken(userId);
      if (!tokenData?.accessToken) return;
      accessToken = tokenData.accessToken;
    }

    if (!organizationId) {
      organizationId = await getOrganizationId(userId);
    }

    const pusherClient = new PusherClient(userId, accessToken, organizationId);
    pusherClients[userId] = pusherClient;

    if (organizationId) {
      const channels = [`org-${organizationId}`, `private-org-${organizationId}`];
      for (const ch of channels) {
        await pusherClient.subscribe(ch).catch(err => {
          logger.warn(`Failed to subscribe to ${ch}: ${err.message}`);
        });
      }
    }

    logger.info(`Pusher setup completed for user ${userId}`);
  } catch (err) {
    logger.error(`Failed to connect to Pusher: ${err.message}`);
  }
}

module.exports = { connectToPusher };