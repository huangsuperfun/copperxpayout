const { Markup } = require('telegraf');
const logger = require('../../utils/logger');
const { getUserToken } = require('../../dependencies');
const { 
  getWallets, 
  getNetworkName, 
  getFormattedWalletBalances 
} = require('../../services/walletService');

/**
 * Handle the /deposit command
 * @param {Object} ctx - Telegraf context
 */
async function depositCommand(ctx) {
  const userId = ctx.from.id;
  
  // Send initial message that we'll update
  const message = await ctx.replyWithMarkdown(
    'Preparing deposit options...'
  );
  
  // Check if user is logged in
  const token = await getUserToken(userId);
  
  if (!token) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      message.message_id,
      null,
      'You need to log in first to deposit funds.',
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
    // Show wallet selection for deposit
    const wallets = await getWallets(userId);
    
    if (wallets && wallets.length > 0) {
      const keyboard = [];
      
      // Add a header row
      keyboard.push([
        Markup.button.callback('Select wallet to deposit to:', 'no_action')
      ]);
      
      // Add buttons for each wallet with full address and network
      for (const wallet of wallets) {
        const networkId = wallet.network;
        const networkName = getNetworkName(networkId);
        const address = wallet.address || wallet.walletAddress;
        
        if (address && networkId) {
          // Format as "Full Address (Network)"
          const buttonText = `${address.slice(0, 10)}...${address.slice(-6)} (${networkName})`;
          keyboard.push([
            Markup.button.callback(buttonText, `deposit_${networkId}`)
          ]);
        }
      }
      
      // Add back button
      keyboard.push([
        Markup.button.callback('« Back to Balances', 'back_to_balance')
      ]);
      
      // Get formatted wallet balances
      const [formattedBalances, _] = await getFormattedWalletBalances(userId);
      
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        message.message_id,
        null,
        `*Deposit Funds*\n\n${formattedBalances}`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(keyboard)
        }
      );
    } else {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        message.message_id,
        null,
        "You don't have any wallets available for deposit.",
        { parse_mode: 'Markdown' }
      );
    }
  } catch (error) {
    logger.error(`Error preparing deposit options: ${error.message}`);
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
 * Handle deposit-related callback queries
 * @param {Object} ctx - Telegraf context
 */
async function depositCallback(ctx) {
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
  
  if (callbackData.startsWith('deposit_')) {
    // Handle deposit for specific network
    const networkId = callbackData.replace('deposit_', '');
    const networkName = getNetworkName(networkId);
    
    try {
      // Get wallet address for this network
      const wallets = await getWallets(userId);
      let walletAddress = null;
      
      for (const wallet of wallets) {
        if (wallet.network === networkId) {
          walletAddress = wallet.address || wallet.walletAddress;
          break;
        }
      }
      
      if (!walletAddress) {
        await ctx.answerCbQuery(`No wallet address found for ${networkName}`);
        return;
      }
      
      // Get token symbol (default to USDC)
      const tokenSymbol = 'USDC';
      
      // Store the original message ID in ctx.session for returning back
      if (!ctx.session) ctx.session = {};
      ctx.session.depositMessageId = ctx.callbackQuery.message.message_id;
      
      // Use QR code generation service that works with Telegram
      const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${walletAddress}`;
      
      // Create message with deposit instructions
      const depositMessage = 
        `*Deposit ${tokenSymbol}*\n\n` +
        `*${networkName}*\n\n` +
        `\`${walletAddress}\`\n\n` +
        `Only send ${tokenSymbol} to this address on supported network. Sending wrong token or wrong network will cause loss of funds.`;
      
      // Add back button
      const keyboard = [
        [Markup.button.callback('« Back to Wallets', 'back_to_deposit')]
      ];
      
      // Delete current message
      await ctx.deleteMessage();
      
      // Send a new message with the QR code
      await ctx.replyWithPhoto(
        { url: qrCodeUrl },
        {
          caption: depositMessage,
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(keyboard)
        }
      );
    } catch (error) {
      logger.error(`Error generating deposit info: ${error.message}`);
      console.error(error);
      await ctx.answerCbQuery(`Error generating deposit info: ${error.message}`);
    }
  } else if (callbackData === 'back_to_deposit') {
    // Go back to deposit wallet selection view
    try {
      // Get wallets
      const wallets = await getWallets(userId);
      
      if (wallets && wallets.length > 0) {
        const keyboard = [];
        
        // Add a header row
        keyboard.push([
          Markup.button.callback('Select wallet to deposit to:', 'no_action')
        ]);
        
        // Add buttons for each wallet with full address and network
        for (const wallet of wallets) {
          const networkId = wallet.network;
          const networkName = getNetworkName(networkId);
          const address = wallet.address || wallet.walletAddress;
          
          if (address && networkId) {
            // Format as "Full Address (Network)"
            const buttonText = `${address.slice(0, 10)}...${address.slice(-6)} (${networkName})`;
            keyboard.push([
              Markup.button.callback(buttonText, `deposit_${networkId}`)
            ]);
          }
        }
        
        // Add back button to main balance view
        keyboard.push([
          Markup.button.callback('« Back to Balances', 'back_to_balance')
        ]);
        
        // Get formatted wallet balances
        const [formattedBalances, _] = await getFormattedWalletBalances(userId);
        
        // Delete the current QR code message
        await ctx.deleteMessage();
        
        // Send a new message with the wallet selection
        await ctx.replyWithMarkdown(
          `*Deposit Funds*\n\n${formattedBalances}`,
          Markup.inlineKeyboard(keyboard)
        );
      } else {
        // If no wallets, show message
        await ctx.answerCbQuery('No wallets available for deposit.');
      }
    } catch (error) {
      logger.error(`Error returning to deposit view: ${error.message}`);
      console.error(error);
      await ctx.answerCbQuery(`Error returning to deposit view: ${error.message}`);
    }
  }
}

module.exports = {
  depositCommand,
  depositCallback
};