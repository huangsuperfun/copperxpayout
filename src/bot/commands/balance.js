const { Markup } = require('telegraf');
const logger = require('../../utils/logger');
const { getUserToken } = require('../../dependencies');
const { 
  getWalletBalances, 
  getWallets, 
  setDefaultWallet, 
  getNetworkName, 
  getFormattedWalletBalances 
} = require('../../services/walletService');

/**
 * Handle the /balance command
 * @param {Object} ctx - Telegraf context
 */
async function balanceCommand(ctx) {
  const userId = ctx.from.id;
  
  // Send initial message that we'll update
  const message = await ctx.replyWithMarkdown(
    'Checking your wallet balances...'
  );
  
  // Check if user is logged in
  const token = await getUserToken(userId);
  
  if (!token) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      message.message_id,
      null,
      'You need to log in first to check your balances.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          Markup.button.callback('Login', 'login')
        ])
      }
    );
    return;
  }
  
  try {
    // Get formatted wallet balances and wallet IDs by network
    const [formattedBalances, walletIdsByNetwork] = await getFormattedWalletBalances(userId);
    
    // Create buttons for actions
    if (walletIdsByNetwork && Object.keys(walletIdsByNetwork).length > 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        message.message_id,
        null,
        formattedBalances,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('💰 Deposit', 'deposit'),
              Markup.button.callback('🔄 Change Default Wallet', 'change_default')
            ]
          ])
        }
      );
    } else {
      // If no wallets, no need for buttons
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        message.message_id,
        null,
        formattedBalances,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (error) {
    logger.error(`Error checking balances: ${error.message}`);
    console.error(error);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      message.message_id,
      null,
      `❌ Error: ${error.message}\n\nPlease try again or contact support.`,
      { parse_mode: 'Markdown' }
    );
  }
}

/**
 * Handle balance-related callback queries
 * @param {Object} ctx - Telegraf context
 */
async function balanceCallback(ctx) {
  await ctx.answerCbQuery();
  
  const userId = ctx.from.id;
  
  // Check if user is logged in
  const token = await getUserToken(userId);
  if (!token) {
    await ctx.editMessageText(
      'Your session has expired. Please log in again with /login.',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  const callbackData = ctx.callbackQuery.data;
  
  if (callbackData === 'change_default') {
    // Show network selection buttons
    try {
      // Get wallet IDs by network
      const [_, walletIdsByNetwork] = await getFormattedWalletBalances(userId);
      
      if (Object.keys(walletIdsByNetwork).length > 1) {
        const keyboard = [];
        let networkButtons = [];
        
        // Add a header row
        const networkRow = [Markup.button.callback('🌐 Select wallet to set as default:', 'no_action')];
        keyboard.push(networkRow);
        
        // Add buttons for each network (up to 4 per row)
        for (const [networkId, walletId] of Object.entries(walletIdsByNetwork)) {
          const networkName = getNetworkName(networkId).split(' ')[0]; // Just get the first word
          networkButtons.push(
            Markup.button.callback(
              `[${networkName}]`,
              `set_default_${walletId}`
            )
          );
          
          // Create a new row after every 4 buttons
          if (networkButtons.length === 4) {
            keyboard.push(networkButtons);
            networkButtons = [];
          }
        }
        
        // Add any remaining buttons
        if (networkButtons.length > 0) {
          keyboard.push(networkButtons);
        }
        
        // Add back button
        keyboard.push([Markup.button.callback('« Back', 'back_to_balance')]);
        
        // Update the message with the network selection buttons
        await ctx.editMessageReplyMarkup({
          inline_keyboard: keyboard
        });
      } else {
        // If only one network, show message
        await ctx.answerCbQuery('You only have one wallet, no need to set default.');
      }
    } catch (error) {
      await ctx.editMessageText(
        `❌ Error: ${error.message}\n\nPlease try again or contact support.`,
        { parse_mode: 'Markdown' }
      );
    }
  } else if (callbackData === 'back_to_balance') {
    // Go back to balance view
    try {
      // Get formatted wallet balances and wallet IDs by network
      const [formattedBalances, walletIdsByNetwork] = await getFormattedWalletBalances(userId);
      
      // Create buttons for actions
      const keyboard = [
        [
          Markup.button.callback('💰 Deposit', 'deposit'),
          Markup.button.callback('🔄 Change Default Wallet', 'change_default')
        ]
      ];
      
      // Update message with the formatted balances and buttons
      await ctx.editMessageText(
        formattedBalances,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(keyboard)
        }
      );
    } catch (error) {
      logger.error(`Error returning to balance view: ${error.message}`);
      
      // If we can't edit the message, delete it and send a new one
      try {
        await ctx.deleteMessage();
        
        const [formattedBalances, walletIdsByNetwork] = await getFormattedWalletBalances(userId);
        
        const keyboard = [
          [
            Markup.button.callback('💰 Deposit', 'deposit'),
            Markup.button.callback('🔄 Change Default Wallet', 'change_default')
          ]
        ];
        
        // Send a new message
        await ctx.replyWithMarkdown(
          formattedBalances,
          Markup.inlineKeyboard(keyboard)
        );
      } catch (innerError) {
        logger.error(`Failed to recover from error: ${innerError.message}`);
      }
    }
  }
}

/**
 * Handle the set default wallet callback query
 * @param {Object} ctx - Telegraf context
 */
async function setDefaultWalletCallback(ctx) {
  await ctx.answerCbQuery();
  
  // If this is the header button, do nothing
  if (ctx.callbackQuery.data === 'no_action') {
    return;
  }
  
  const userId = ctx.from.id;
  
  // Check if user is logged in
  const token = await getUserToken(userId);
  if (!token) {
    await ctx.editMessageText(
      'Your session has expired. Please log in again with /login.',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  // Extract wallet ID from callback data
  const callbackData = ctx.callbackQuery.data;
  if (callbackData.startsWith('set_default_')) {
    const walletId = callbackData.replace('set_default_', '');
    
    try {
      // Show loading state
      await ctx.editMessageText(
        'Setting default wallet...',
        { parse_mode: 'Markdown' }
      );
      
      // Set the wallet as default
      await setDefaultWallet(userId, walletId);
      
      // Show loading state for getting updated balances
      await ctx.editMessageText(
        'Default wallet updated! Refreshing balances...',
        { parse_mode: 'Markdown' }
      );
      
      // Get updated wallet balances
      const [formattedBalances, walletIdsByNetwork] = await getFormattedWalletBalances(userId);
      
      // Create buttons for actions
      const keyboard = [
        [
          Markup.button.callback('💰 Deposit', 'deposit'),
          Markup.button.callback('🔄 Change Default Wallet', 'change_default')
        ]
      ];
      
      // Update the message with the formatted balances and buttons
      await ctx.editMessageText(
        `✅ Default wallet updated!\n\n${formattedBalances}`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(keyboard)
        }
      );
    } catch (error) {
      await ctx.editMessageText(
        `❌ Error: ${error.message}\n\nPlease try again or contact support.`,
        { parse_mode: 'Markdown' }
      );
    }
  }
}

module.exports = {
  balanceCommand,
  balanceCallback,
  setDefaultWalletCallback
};
