const { Markup } = require('telegraf');
const logger = require('../../utils/logger');
const { getUserToken } = require('../../dependencies');
const { getTransactionHistory, formatAmount } = require('../../services/transferService');

/**
 * Format a timestamp to a readable date
 * @param {string} dateString - ISO date string
 * @returns {string} Formatted date string
 */
function formatDate(dateString) {
  try {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (error) {
    return dateString;
  }
}

/**
 * Handle the /transactions command
 * @param {Object} ctx - Telegraf context
 */
async function transactionsCommand(ctx) {
  // Send a loading message first
  const loadingMessage = await ctx.reply(
    'Loading transactions... ⏳',
    { parse_mode: 'Markdown' }
  );
  
  // Show first page of transactions
  await showTransactionsPage(ctx, 1, loadingMessage);
}

/**
 * Show a specific page of transactions with interactive buttons
 * @param {Object} ctx - Telegraf context
 * @param {number} page - Page number to display
 * @param {Object} loadingMessage - Optional loading message to update
 */
async function showTransactionsPage(ctx, page, loadingMessage = null) {
  const userId = ctx.from.id;
  const limit = 10;
  
  // Check if user is logged in
  const token = await getUserToken(userId);
  if (!token) {
    const message = 'You need to log in first to view your transactions.';
    
    if (loadingMessage) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMessage.message_id,
        null,
        message,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            Markup.button.callback('Login', 'login')
          ])
        }
      );
    } else {
      await ctx.reply(
        message,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            Markup.button.callback('Login', 'login')
          ])
        }
      );
    }
    return;
  }
  
  // Show typing indicator
  await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
  
  try {
    // Get transaction history for the selected page
    const transactions = await getTransactionHistory(userId, page, limit);
    
    if (!transactions || transactions.length === 0) {
      const message = 'No transactions found.';
      
      if (loadingMessage) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          loadingMessage.message_id,
          null,
          message,
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.reply(message, { parse_mode: 'Markdown' });
      }
      return;
    }
    
    // Format transactions as text message with View Details links
    const messageLines = ['📜 *Transaction History*\n'];
    
    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];
      const createdAt = new Date(tx.createdAt);
      const formattedDate = formatDate(tx.createdAt);
      const txType = (tx.type || 'Unknown').toUpperCase(); // Make TYPE uppercase
      const txId = tx.id;
      
      // Determine destination display
      let destination = 'N/A';
      if (tx.destinationAccount) {
        const destAccount = tx.destinationAccount;
        if (destAccount.payeeDisplayName) {
          destination = destAccount.payeeDisplayName;
        } else if (destAccount.payeeEmail) {
          destination = destAccount.payeeEmail;
        } else if (destAccount.walletAddress) {
          const wallet = destAccount.walletAddress;
          destination = `${wallet.substring(0, 6)}...${wallet.substring(wallet.length - 4)}`;
        }
      } else if (tx.payee) {
        if (tx.payee.displayName) {
          destination = tx.payee.displayName;
        } else if (tx.payee.email) {
          destination = tx.payee.email;
        }
      } else if (tx.destinationWallet) {
        // Show shortened wallet address
        const wallet = tx.destinationWallet.address || '';
        if (wallet) {
          destination = `${wallet.substring(0, 6)}...${wallet.substring(wallet.length - 4)}`;
        }
      }
      
      const amount = formatAmount(tx.amount || 0);
      const status = (tx.status || 'Unknown').toUpperCase(); // Make STATUS uppercase
      
      // Create transaction line with View Details link
      messageLines.push(`${i + 1}. *${formattedDate}* | ${txType} | ${destination}`);
      messageLines.push(`   Amount: ${amount} USDC | Status: ${status}`);
      messageLines.push(`   [View Details](https://t.me/${ctx.me}?start=tx_${txId})`);
      messageLines.push(''); // Empty line for spacing
    }
    
    // Create pagination buttons
    const paginationButtons = [];
    if (page > 1) {
      paginationButtons.push(Markup.button.callback(
        '« Previous', `tx_page_${page - 1}`
      ));
    }
    
    // Check if there might be more pages
    if (transactions.length >= limit) {
      paginationButtons.push(Markup.button.callback(
        'Next »', `tx_page_${page + 1}`
      ));
    }
    
    // Define keyboard with pagination
    let keyboard = null;
    if (paginationButtons.length > 0) {
      keyboard = [
        paginationButtons,
        [Markup.button.callback(`Page ${page}`, 'tx_page_info')]
      ];
    }
    
    // Send or edit message with transactions
    const messageText = messageLines.join('\n');
    
    if (ctx.callbackQuery) {
      await ctx.editMessageText(
        messageText,
        {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
          ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
        }
      );
    } else if (loadingMessage) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMessage.message_id,
        null,
        messageText,
        {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
          ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
        }
      );
    } else {
      await ctx.reply(
        messageText,
        {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
          ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
        }
      );
    }
  } catch (error) {
    const errorMessage = `❌ Error: ${error.message}\n\nPlease try again or contact support.`;
    
    if (ctx.callbackQuery) {
      await ctx.editMessageText(
        errorMessage,
        { parse_mode: 'Markdown' }
      );
    } else if (loadingMessage) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMessage.message_id,
        null,
        errorMessage,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply(
        errorMessage,
        { parse_mode: 'Markdown' }
      );
    }
  }
}

/**
 * Handle transaction-related callbacks
 * @param {Object} ctx - Telegraf context
 */
async function transactionCallbackHandler(ctx) {
  await ctx.answerCbQuery();
  
  const userId = ctx.from.id;
  const data = ctx.callbackQuery.data;
  
  // Check if user is logged in
  const token = await getUserToken(userId);
  if (!token) {
    await ctx.editMessageText(
      'Your session has expired. Please log in again with /login.',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  if (data === 'tx_page_info') {
    // Just acknowledge the callback for the page info button
    return;
  }
  
  if (data.startsWith('tx_page_')) {
    // Handle pagination
    try {
      const page = parseInt(data.split('_')[2], 10);
      await showTransactionsPage(ctx, page);
    } catch (error) {
      await ctx.editMessageText(
        'Invalid page number. Please try /transactions again.',
        { parse_mode: 'Markdown' }
      );
    }
    return;
  }
  
  if (data.startsWith('tx_')) {
    // Handle transaction details
    const txId = data.replace('tx_', '');
    await showTransactionDetails(ctx, txId);
    return;
  }
}

/**
 * Handle deep links for transaction details
 * @param {Object} ctx - Telegraf context
 */
async function handleDeepLink(ctx) {
  // Check if this is a deep link with transaction ID
  const args = ctx.startPayload;
  if (args && args.startsWith('tx_')) {
    const txId = args.replace('tx_', '');
    
    // Delete the automatic /start message
    try {
      await ctx.deleteMessage();
    } catch (error) {
      // If we can't delete the message, just continue
    }
    
    // Send a loading message
    const loadingMessage = await ctx.reply(
      'Loading transaction details... ⏳',
      { parse_mode: 'Markdown' }
    );
      
    await showTransactionDetailsById(ctx, txId, loadingMessage);
    return;
  }
}

/**
 * Show detailed information for a specific transaction by ID
 * @param {Object} ctx - Telegraf context
 * @param {string} txId - Transaction ID to display
 * @param {Object} loadingMessage - Optional loading message to update
 */
async function showTransactionDetailsById(ctx, txId, loadingMessage = null) {
  const userId = ctx.from.id;
  
  // Check if user is logged in
  const token = await getUserToken(userId);
  if (!token) {
    const message = 'You need to log in first to view transaction details.';
    
    if (loadingMessage) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMessage.message_id,
        null,
        message,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            Markup.button.callback('Login', 'login')
          ])
        }
      );
    } else {
      await ctx.reply(
        message,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            Markup.button.callback('Login', 'login')
          ])
        }
      );
    }
    return;
  }
  
  // Show typing indicator
  await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
  
  try {
    // Fetch transaction history and find the specific transaction
    const transactions = await getTransactionHistory(userId, 1, 100); // Get a larger set to find the transaction
    
    // Find the specific transaction
    let tx = null;
    for (const transaction of transactions) {
      if (transaction.id === txId) {
        tx = transaction;
        break;
      }
    }
    
    if (!tx) {
      const message = 'Transaction not found. Please try again later.';
      
      if (loadingMessage) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          loadingMessage.message_id,
          null,
          message,
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.reply(message, { parse_mode: 'Markdown' });
      }
      return;
    }
    
    // Format transaction details
    const createdAt = new Date(tx.createdAt);
    const formattedDate = formatDate(tx.createdAt);
    
    const details = [
      `*Transaction ID:* \`${tx.id}\``,
      `*Date:* ${formattedDate}`,
      `*Type:* ${(tx.type || 'Unknown').toUpperCase()}`, // Make TYPE uppercase
      `*Amount:* ${formatAmount(tx.amount || 0)} USDC`,
      `*Status:* ${(tx.status || 'Unknown').toUpperCase()}` // Make STATUS uppercase
    ];
    
    // Add source wallet info if available
    if (tx.sourceWallet) {
      const sourceAddress = tx.sourceWallet.address || 'N/A';
      details.push(`*Source Wallet:* \`${sourceAddress}\``);
    }
    
    // Add destination info based on type
    if (tx.destinationAccount) {
      const destAccount = tx.destinationAccount;
      if (destAccount.payeeDisplayName) {
        details.push(`*Destination Name:* ${destAccount.payeeDisplayName}`);
      }
      if (destAccount.payeeEmail) {
        details.push(`*Destination Email:* ${destAccount.payeeEmail}`);
      }
      if (destAccount.walletAddress) {
        details.push(`*Destination Wallet:* \`${destAccount.walletAddress}\``);
      }
    } else if (tx.payee) {
      const payee = tx.payee;
      if (payee.displayName) {
        details.push(`*Payee Name:* ${payee.displayName}`);
      }
      if (payee.email) {
        details.push(`*Payee Email:* ${payee.email}`);
      }
    }
    
    if (tx.destinationWallet && !tx.destinationAccount) {
      const destAddress = tx.destinationWallet.address || 'N/A';
      details.push(`*Destination Wallet:* \`${destAddress}\``);
    }
    
    // Add transaction hash if available
    if (tx.transactionHash) {
      const txHash = tx.transactionHash;
      details.push(`*Transaction Hash:* \`${txHash}\``);
    }
    
    // Add notes if available
    if (tx.notes) {
      details.push(`*Notes:* ${tx.notes}`);
    }
    
    // Create back button
    const keyboard = [[Markup.button.callback('« Back to Transactions', 'tx_page_1')]];
    
    // Send detailed view
    const messageText = details.join('\n');
    
    if (loadingMessage) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMessage.message_id,
        null,
        messageText,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(keyboard)
        }
      );
    } else {
      await ctx.reply(
        messageText,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(keyboard)
        }
      );
    }
  } catch (error) {
    const errorMessage = `❌ Error: ${error.message}\n\nPlease try again or contact support.`;
    
    if (loadingMessage) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMessage.message_id,
        null,
        errorMessage,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply(
        errorMessage,
        { parse_mode: 'Markdown' }
      );
    }
  }
}

module.exports = {
  transactionsCommand,
  transactionCallbackHandler,
  handleDeepLink,
};