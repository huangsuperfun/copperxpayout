const { Markup } = require('telegraf');
const { getUserToken, makeApiRequest } = require('../../dependencies');
const logger = require('../../utils/logger');
const { connectToPusher } = require('../telegramBot');

/**
 * Handle the /start command
 * @param {Object} ctx - Telegraf context
 */
async function startCommand(ctx) {
  const userId = ctx.from.id;
  
  // Check if user is logged in
  const token = await getUserToken(userId);
  
  if (token) {
    // User is logged in, get their profile info
    try {
      const profile = await makeApiRequest('GET', '/api/auth/me', userId);
      
      // Get user's name or email
      const firstName = profile.firstName || '';
      const lastName = profile.lastName || '';
      const email = profile.email || '';
      
      // Determine greeting name
      let greetingName;
      if (firstName && lastName) {
        greetingName = `${firstName} ${lastName}`;
      } else if (firstName) {
        greetingName = firstName;
      } else if (email) {
        greetingName = email;
      } else {
        greetingName = "there";
      }
      
      // Create welcome message
      let welcomeMessage = `Welcome back, ${greetingName}! 👋\n\n`;
      welcomeMessage += "You're already logged in. What would you like to do?\n\n";
      
      // Add command list
      welcomeMessage += "• /balance - Check your wallet balances\n";
      welcomeMessage += "• /deposit - Deposit funds to your wallet\n";
      welcomeMessage += "• /send - Send funds to an email or wallet\n";
      welcomeMessage += "• /withdrawal - Withdraw to a bank account\n";
      welcomeMessage += "• /history - View recent transactions\n";
      welcomeMessage += "• /help - Show help information\n";
      welcomeMessage += "• /logout - Log out of your account";
      
      await ctx.replyWithMarkdown(welcomeMessage);
      
      // Connect to Pusher if not already connected
      if (!ctx.session?.pusherConnected) {
        await connectToPusher(userId);
        ctx.session.pusherConnected = true;
      }
    } catch (error) {
      // If there's an error getting profile, use a generic greeting
      const welcomeMessage = "Welcome back! 👋\n\n" +
        "You're already logged in. What would you like to do?\n\n" +
        "• /balance - Check your wallet balances\n" +
        "• /deposit - Deposit funds to your wallet\n" +
        "• /send - Send funds to an email or wallet\n" +
        "• /withdrawal - Withdraw to a bank account\n" +
        "• /history - View recent transactions\n" +
        "• /help - Show help information\n" +
        "• /logout - Log out of your account";
      
      await ctx.replyWithMarkdown(welcomeMessage);
    }
  } else {
    // User is not logged in
    await ctx.replyWithMarkdown(
      "Welcome to BountyTele! 🚀\n\n" +
      "This bot allows you to manage your crypto wallet, send and receive funds, and more.\n\n" +
      "Please log in to get started.",
      Markup.inlineKeyboard([
        Markup.button.callback('Login', 'login')
      ])
    );
  }
}

module.exports = {
  startCommand
};