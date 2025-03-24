const { Scenes, Markup } = require('telegraf');
const logger = require('../../utils/logger');
const { getUserToken, makeApiRequest } = require('../../dependencies');
const { getFormattedWalletBalances } = require('../../services/walletService');

// Create withdrawal wizard scene
const withdrawalScene = new Scenes.WizardScene(
  'withdrawal-scene',
  
  // Step 1: Show wallet balances and ask for amount
  async (ctx) => {
    const userId = ctx.from.id;
    
    // Check if user is logged in
    const token = await getUserToken(userId);
    if (!token) {
      await ctx.reply(
        'You need to log in first to withdraw funds.',
        Markup.inlineKeyboard([
          Markup.button.callback('Login', 'login')
        ])
      );
      return ctx.scene.leave();
    }
    
    // Clear any existing withdrawal data
    ctx.scene.session.data = {};
    
    // Get wallet balances to show available funds
    try {
      // Send a loading message
      const loadingMessage = await ctx.reply(
        'Loading your wallet balance... ⏳',
        { parse_mode: 'Markdown' }
      );
      
      // Get formatted wallet balances
      const [formattedBalances, walletIdsByNetwork] = await getFormattedWalletBalances(userId);
      
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMessage.message_id,
        null,
        `*Withdrawal*\n\n${formattedBalances}\n` +
        `Please enter the amount you want to withdraw in USDC:`,
        { parse_mode: 'Markdown' }
      );
      
      return ctx.wizard.next();
    } catch (error) {
      await ctx.reply(
        `❌ Error: ${error.message}\n\nPlease try again or contact support.`,
        { parse_mode: 'Markdown' }
      );
      return ctx.scene.leave();
    }
  },
  
  // Step 2: Handle amount input and show quote
  async (ctx) => {
    // Check if this is a command (like /cancel)
    if (ctx.message?.text?.startsWith('/')) {
      await ctx.reply('Withdrawal cancelled. You can start again with /withdrawal.');
      return ctx.scene.leave();
    }
    
    const userId = ctx.from.id;
    const amountText = ctx.message.text.trim();
    
    // Send a loading message
    const loadingMessage = await ctx.reply(
      'Processing your request... ⏳',
      { parse_mode: 'Markdown' }
    );
    
    try {
      // Parse amount
      let amount;
      try {
        amount = parseFloat(amountText);
        if (amount <= 0) {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            loadingMessage.message_id,
            null,
            '❌ Amount must be greater than 0. Please try again.',
            { parse_mode: 'Markdown' }
          );
          return;
        }
      } catch (error) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          loadingMessage.message_id,
          null,
          '❌ Invalid amount format. Please enter a valid number.',
          { parse_mode: 'Markdown' }
        );
        return;
      }
      
      // Convert amount to the format expected by the API (multiply by 1e8)
      const amountInt = Math.floor(amount * 100000000);
      const amountStr = amountInt.toString();
      
      // Store the amount in scene session
      ctx.scene.session.data.amount = amountStr;
      
      // Get user profile to determine country code
      try {
        const profile = await makeApiRequest('GET', '/api/auth/me', userId);
        const countryCode = (profile && profile.countryCode) ? profile.countryCode.toLowerCase() : 'vnm'; // Default to "vnm" if not found
        ctx.scene.session.data.countryCode = countryCode;
      } catch (error) {
        logger.error(`Error getting user profile: ${error.message}`);
        const countryCode = 'vnm'; // Default to Vietnam if profile fetch fails
        ctx.scene.session.data.countryCode = countryCode;
      }
      
      // Get quote from public offramp API
      const payload = {
        sourceCountry: 'none',
        destinationCountry: ctx.scene.session.data.countryCode,
        amount: amountStr,
        currency: 'USDC'
      };
      
      // Call the public offramp API
      try {
        const quoteResponse = await makeApiRequest(
          'POST', 
          '/api/quotes/public-offramp', 
          userId, 
          payload
        );
        
        // Store the quote response
        ctx.scene.session.data.quoteResponse = quoteResponse;
        
        // Parse the quote payload
        const quotePayload = JSON.parse(quoteResponse.quotePayload || '{}');
        
        // Calculate the final amount after fees
        const toAmount = parseFloat(quotePayload.toAmount || 0) / 100000000;
        const toCurrency = quotePayload.toCurrency || 'VND';
        const rate = quotePayload.rate || 0;
        const fee = parseFloat(quotePayload.totalFee || 0) / 100000000; // Convert to USDC
        
        // Format the quote details
        const formattedAmount = `${amount.toFixed(2)} USDC`;
        // Format the VND amount without decimal places
        const formattedToAmount = `${Math.floor(toAmount).toLocaleString()} ${toCurrency}`;
        const formattedRate = `1 USDC = ${Math.floor(parseFloat(rate)).toLocaleString()} ${toCurrency}`;
        const formattedFee = `${fee.toFixed(2)} USDC`;
        const arrivalTime = quoteResponse.arrivalTimeMessage || '1-3 Business days';
        
        // Create confirmation message
        const confirmationMessage = 
          `*Withdrawal Quote*\n\n` +
          `*Amount:* ${formattedAmount}\n` +
          `*Fee:* ${formattedFee}\n` +
          `*Exchange Rate:* ${formattedRate}\n` +
          `*You Will Receive:* ${formattedToAmount}\n` +
          `*Estimated Arrival:* ${arrivalTime}\n\n` +
          `Do you want to proceed with this withdrawal?`;
        
        // Update loading message with confirmation
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          loadingMessage.message_id,
          null,
          confirmationMessage,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('Confirm', 'confirm_withdrawal'),
                Markup.button.callback('Cancel', 'cancel_withdrawal')
              ]
            ])
          }
        );
        
        return ctx.wizard.next();
      } catch (error) {
        logger.error(`Error getting quote: ${error.message}`);
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          loadingMessage.message_id,
          null,
          `❌ Error getting withdrawal quote: ${error.message}\n\nPlease try again or contact support.`,
          { parse_mode: 'Markdown' }
        );
        return ctx.scene.leave();
      }
    } catch (error) {
      logger.error(`Error in amount handler: ${error.message}`);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMessage.message_id,
        null,
        `❌ Error: ${error.message}\n\nPlease try again or contact support.`,
        { parse_mode: 'Markdown' }
      );
      return ctx.scene.leave();
    }
  },
  
  // Step 3: Handle confirmation
  async (ctx) => {
    // Must be a callback query at this point
    if (!ctx.callbackQuery) {
      await ctx.reply('Please select an option from the buttons above.');
      return;
    }
    
    await ctx.answerCbQuery();
    const action = ctx.callbackQuery.data;
    
    if (action === 'cancel_withdrawal') {
      await ctx.editMessageText('Withdrawal cancelled.');
      return ctx.scene.leave();
    }
    
    if (action === 'confirm_withdrawal') {
      // Get withdrawal details from context
      const userId = ctx.from.id;
      const amount = ctx.scene.session.data.amount;
      const countryCode = ctx.scene.session.data.countryCode;
      const quoteResponse = ctx.scene.session.data.quoteResponse;
      
      // Show loading message
      await ctx.editMessageText(
        'Processing your withdrawal... ⏳',
        { parse_mode: 'Markdown' }
      );
      
      try {
        // First, get an official quote
        const quotePayload = {
          sourceCountry: 'none',
          destinationCountry: countryCode,
          amount: amount,
          currency: 'USDC'
        };
        
        const officialQuoteResponse = await makeApiRequest(
          'POST', 
          '/api/quotes/offramp', 
          userId, 
          quotePayload
        );
        
        // Extract quote payload and signature
        const officialQuotePayload = officialQuoteResponse.quotePayload;
        const officialQuoteSignature = officialQuoteResponse.quoteSignature;
        
        if (!officialQuotePayload || !officialQuoteSignature) {
          throw new Error('Invalid quote response');
        }
        
        // Now initiate the withdrawal
        const withdrawalPayload = {
          quotePayload: officialQuotePayload,
          quoteSignature: officialQuoteSignature
        };
        
        const withdrawalResponse = await makeApiRequest(
          'POST', 
          '/api/transfers/offramp', 
          userId, 
          withdrawalPayload
        );
        
        // Check if withdrawal was successful
        if (withdrawalResponse && withdrawalResponse.id) {
          // Format the response
          const txId = withdrawalResponse.id;
          const status = (withdrawalResponse.status || 'PENDING').toUpperCase();
          
          // Parse the quote payload to get amount details
          const quoteData = JSON.parse(officialQuotePayload);
          const amountUsdc = parseFloat(quoteData.amount || 0) / 100000000;
          const toAmount = parseFloat(quoteData.toAmount || 0);
          const toCurrency = quoteData.toCurrency || 'VND';
          
          const successMessage = 
            `✅ *Withdrawal Initiated*\n\n` +
            `*Transaction ID:* \`${txId}\`\n` +
            `*Amount:* ${amountUsdc.toFixed(2)} USDC\n` +
            `*You Will Receive:* ${Math.floor(toAmount).toLocaleString()} ${toCurrency}\n` +
            `*Status:* ${status}\n\n` +
            `You can check the status of your withdrawal with the /transactions command.`;
          
          await ctx.editMessageText(
            successMessage,
            { parse_mode: 'Markdown' }
          );
        } else {
          throw new Error('Failed to initiate withdrawal');
        }
      } catch (error) {
        logger.error(`Error processing withdrawal: ${error.message}`);
        await ctx.editMessageText(
          `❌ Error processing withdrawal: ${error.message}\n\nPlease try again or contact support.`,
          { parse_mode: 'Markdown' }
        );
      }
      
      return ctx.scene.leave();
    }
    
    // If we get here, unknown action
    await ctx.reply('Unknown action. Please try again with /withdrawal.');
    return ctx.scene.leave();
  }
);

// Register scene commands
withdrawalScene.command('cancel', async (ctx) => {
  await ctx.reply('Withdrawal cancelled. You can start again with /withdrawal.');
  return ctx.scene.leave();
});

module.exports = {
  withdrawalScene
};