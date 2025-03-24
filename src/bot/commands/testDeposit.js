const logger = require('../../utils/logger');
const { getUserToken, getOrganizationId } = require('../../dependencies');
const { getWallets } = require('../../services/walletService');
const PusherClient = require('../../utils/pusherClient');

/**
 * Handle the /test_deposit command (for testing only)
 * @param {Object} ctx - Telegraf context
 */
async function testDepositCommand(ctx) {
  const userId = ctx.from.id;
  
  // Check if user is logged in
  const token = await getUserToken(userId);
  
  if (!token) {
    await ctx.reply(
      'You need to log in first to test deposits.',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  // Check if user has organization ID
  const orgId = await getOrganizationId(userId);
  if (!orgId) {
    await ctx.reply(
      'Organization ID not found. Please log in again.',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  // Import the pusher clients from the main bot file
  // This avoids circular dependencies
  const { pusherClients } = require('../telegramBot');
  
  // Get or create a pusher client for this user
  let pusherClient = pusherClients[userId];
  
  if (!pusherClient) {
    // Create a new pusher client if one doesn't exist
    try {
      pusherClient = new PusherClient(userId, token.accessToken);
      
      // Store the client for future use
      pusherClients[userId] = pusherClient;
    } catch (error) {
      await ctx.reply(
        `Error creating client: ${error.message}. Please try logging in again.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
  }
  
  try {
    // Get user's wallets
    const wallets = await getWallets(userId);
    
    if (!wallets || wallets.length === 0) {
      await ctx.reply(
        "You don't have any wallets. Please check your account.",
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    // Simulate a deposit to the first wallet
    const wallet = wallets[0];
    const network = wallet.network || 'ETHEREUM';
    const address = wallet.address || wallet.walletAddress;
    
    if (!address) {
      await ctx.reply(
        'Could not find a valid wallet address.',
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    // Send a message about the test
    await ctx.reply(
      `Simulating a test deposit of 10 USDC to your ${network} wallet:\n` +
      `\`${address}\`\n\n` +
      'This is a simulated deposit (no actual funds are being transferred).',
      { parse_mode: 'Markdown' }
    );
    
    // Simulate the deposit notification
    const notificationMessage = await pusherClient.simulateDeposit(network, address, '10', 'USDC');
    
    // Send the notification message as if it came from Pusher
    await ctx.reply(
      notificationMessage,
      { parse_mode: 'Markdown' }
    );
    
    // Send confirmation
    await ctx.reply(
      '✅ Deposit simulation completed successfully!',
      { parse_mode: 'Markdown' }
    );
    
  } catch (error) {
    await ctx.reply(
      `Error testing deposit: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
  }
}

module.exports = {
  testDepositCommand
};