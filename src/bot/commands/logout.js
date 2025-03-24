const { Markup } = require('telegraf');
const { getUserToken } = require('../../dependencies');
const { logout } = require('../../services/authService');

/**
 * Handle the /logout command
 * @param {Object} ctx - Telegraf context
 */
async function logoutCommand(ctx) {
  const userId = ctx.from.id;
  
  // Check if user is logged in
  const token = await getUserToken(userId);
  
  if (!token) {
    await ctx.replyWithMarkdown(
      "You are not currently logged in."
    );
    return;
  }
  
  // Ask for confirmation
  await ctx.replyWithMarkdown(
    "Are you sure you want to log out? You'll need to log in again to use the bot.",
    Markup.inlineKeyboard([
      [
        Markup.button.callback('Yes, Log Out', 'confirm_logout'),
        Markup.button.callback('Cancel', 'cancel_logout')
      ]
    ])
  );
}

/**
 * Handle the logout confirmation
 * @param {Object} ctx - Telegraf context
 */
async function logoutCallback(ctx) {
  await ctx.answerCbQuery();
  
  const action = ctx.callbackQuery.data;
  
  if (action === 'confirm_logout') {
    // Clear user data including tokens and organization ID
    await logout(ctx.from.id);
    
    // Also clear session data if present
    if (ctx.session) {
      ctx.session = {};
    }
    
    // Send confirmation
    await ctx.editMessageText(
      "✅ You have been logged out successfully.\n\n" +
      "You can log in again using /login.",
      { parse_mode: 'Markdown' }
    );
  } else { // cancel_logout
    await ctx.editMessageText(
      "Logout cancelled. You are still logged in.",
      { parse_mode: 'Markdown' }
    );
  }
}

module.exports = {
  logoutCommand,
  logoutCallback
};