const { Markup } = require('telegraf');
const { getUserToken } = require('../../dependencies');

/**
 * Handle the /help command
 * @param {Object} ctx - Telegraf context
 */
async function helpCommand(ctx) {
  const userId = ctx.from.id;
  
  // Check if user is logged in
  const token = await getUserToken(userId);
  
  // Create different help messages based on login status
  let helpText;
  if (token) {
    // User is logged in
    helpText = 
      "*Copperx Payout Bot - Help*\n\n" +
      "This bot allows you to manage your USDC wallets and transactions directly from Telegram.\n\n" +
      "*Available Commands:*\n\n" +
      "• /start - Start or restart the bot\n" +
      "• /login - Log in to your Copperx account\n" +
      "• /balance - Check your wallet balances\n" +
      "• /send - Send funds to an email or wallet address\n" +
      "• /payee - Manage your saved payees\n" +   // Add this line
      "• /deposit - Get your deposit address\n" +
      "• /withdrawal - Withdraw funds to your bank account\n" +
      "• /transactions - View your transaction history\n" +
      "• /myprofile - View your profile information\n" +
      "• /help - Show this help message\n" +
      "• /logout - Log out of your account\n\n" +
      "*Common Tasks:*\n\n" +
      "1. *Checking Balance*: Use /balance to see all your wallet balances.\n" +
      "2. *Managing Payees*: Use /payee to save and manage recipient emails.\n" +   // Add this line
      "3. *Sending Funds*: Use /send and follow the prompts to send USDC to an email or wallet address.\n" +
      "4. *Withdrawing Funds*: Use /withdrawal to withdraw funds to your bank account.\n" +
      "5. *Viewing Transactions*: Use /transactions to see your transaction history with details.\n\n" +
      "*Need More Help?*\n" +
      "Visit Copperx Support at https://t.me/copperxcommunity/2183";
  } else {
    // User is not logged in
    helpText = 
      "*Copperx Payout Bot - Help*\n\n" +
      "This bot allows you to manage your USDC wallets and transactions directly from Telegram.\n\n" +
      "*Getting Started:*\n\n" +
      "1. Use /login to authenticate with your Copperx account.\n" +
      "2. Once logged in, you can check balances, send funds, and more.\n\n" +
      "*Available Commands:*\n\n" +
      "• /start - Start or restart the bot\n" +
      "• /login - Log in to your Copperx account\n" +
      "• /help - Show this help message\n\n" +
      "*Need More Help?*\n" +
      "Visit Copperx Support at https://t.me/copperxcommunity/2183";
  }
  
  // Support button
  await ctx.replyWithMarkdown(
    helpText,
    Markup.inlineKeyboard([
      Markup.button.url('Copperx Support', 'https://t.me/copperxcommunity/2183')
    ])
  );
}

module.exports = {
  helpCommand
};