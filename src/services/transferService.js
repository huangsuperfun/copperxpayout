const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { getUserToken, makeApiRequest } = require('../dependencies');

/**
 * Send funds to an email address
 * @param {number} userId - Telegram user ID
 * @param {string} email - Recipient email address
 * @param {string|number} amount - Amount to send
 * @param {string} network - Network to use for the transfer (optional)
 * @param {string} payeeId - Payee ID if available (optional)
 * @param {string} currency - Currency to use (defaults to USDV for email transfers)
 * @returns {Promise<Object>} Response from the API
 */
async function sendToEmail(userId, email, amount, network = null, payeeId = null, currency = 'USDV') {
  const token = await getUserToken(userId);
  if (!token) {
    throw new Error('User not authenticated');
  }
  
  try {
    // Convert amount to a format the API can handle
    // The API expects a string representation of a BigInt
    try {
      // Convert to float first to handle string inputs
      const amountFloat = parseFloat(amount);
      
      // Check if the amount meets the minimum requirement (0.1 USDC with 6 decimal places)
      const minAmountFloat = 0.1; // 0.1 USDC
      if (amountFloat < minAmountFloat) {
        throw new Error(`Amount must be at least ${minAmountFloat} USDC`);
      }
      
      let amountInt = Math.floor(amountFloat * 100000000);
      
      // Ensure the amount meets the minimum BigInt requirement (100000000)
      if (amountInt < 100000000) {
        amountInt = 100000000; // Set to minimum if below
      }
      
      // Convert to string
      const amountStr = amountInt.toString();
      
      // Create payload according to API documentation
      const payload = {
        email: email,
        amount: amountStr,
        purposeCode: "self",
        currency: currency // Use the provided currency parameter
      };
      
      // Add payeeId if available
      if (payeeId) {
        payload.payeeId = payeeId;
      }
      
      logger.info(`Sending transfer to email with payload: ${JSON.stringify(payload)}`);
      
      // Call make_api_request with the correct parameters
      const response = await makeApiRequest(
        'POST',
        '/api/transfers/send',
        userId,
        payload
      );
      
      return response;
    } catch (e) {
      throw new Error(`Invalid amount: ${e.message}`);
    }
  } catch (error) {
    logger.error(`Error sending to email: ${error.message}`);
    throw error;
  }
}

/**
 * Withdraw funds to an external wallet address
 * @param {number} userId - Telegram user ID
 * @param {number} amount - Amount to transfer
 * @param {string} currency - Currency code (always USDC)
 * @param {string} network - Blockchain network (e.g., SOLANA)
 * @param {string} walletAddress - Recipient wallet address
 * @returns {Promise<Object>} Transfer receipt/confirmation
 */
async function withdrawToWallet(userId, amount, currency, network, walletAddress) {
  try {
    // Convert amount to a format the API can handle
    // The API expects a string representation of a BigInt
    
    // Check if the amount meets the minimum requirement (0.1 USDC with 6 decimal places)
    const minAmountFloat = 0.1; // 0.1 USDC
    if (parseFloat(amount) < minAmountFloat) {
      throw new Error(`Amount must be at least ${minAmountFloat} USDC`);
    }
    
    // Multiply by 1,000,000 (assuming 6 decimal places for USDC)
    let amountInt = Math.floor(parseFloat(amount) * 100000000);
    
    // Ensure the amount meets the minimum BigInt requirement (100000000)
    if (amountInt < 100000000) {
      amountInt = 100000000; // Set to minimum if below
    }
    
    // Convert to string
    const amountStr = amountInt.toString();
    
    const payload = {
      walletAddress: walletAddress,
      amount: amountStr,
      currency: 'USDC', // Always USDC
      purposeCode: 'self' // Required enum value as per API docs
    };
    
    // Add network if provided and required by the API
    if (network) {
      payload.network = network;
    }
    
    logger.info(`Sending transfer to wallet with payload: ${JSON.stringify(payload)}`);
    
    // Call make_api_request with the correct parameters
    return await makeApiRequest(
      'POST', 
      '/api/transfers/wallet-withdraw', 
      userId, 
      payload
    );
  } catch (error) {
    logger.error(`Error withdrawing to wallet: ${error.message}`);
    throw error;
  }
}

/**
 * Withdraw funds to a bank account
 * @param {number} userId - Telegram user ID
 * @param {number} amount - Amount to transfer
 * @param {string} currency - Currency code (e.g., USDC)
 * @param {Object} bankDetails - Bank account details
 * @returns {Promise<Object>} Transfer receipt/confirmation
 */
async function withdrawToBank(userId, amount, currency, bankDetails) {
  try {
    // Convert amount to a format the API can handle
    // The API expects a string representation of a BigInt
    
    // Check if the amount meets the minimum requirement (0.1 USDC with 6 decimal places)
    const minAmountFloat = 0.1; // 0.1 USDC
    if (parseFloat(amount) < minAmountFloat) {
      throw new Error(`Amount must be at least ${minAmountFloat} USDC`);
    }
    
    // Multiply by 1,000,000 (assuming 6 decimal places for USDC)
    let amountInt = Math.floor(parseFloat(amount) * 100000000);
    
    // Convert to string
    const amountStr = amountInt.toString();
    
    const payload = {
      ...bankDetails,
      amount: amountStr,
      currency: currency
    };
    
    return await makeApiRequest('POST', '/api/transfers/offramp', userId, payload);
  } catch (error) {
    logger.error(`Error withdrawing to bank: ${error.message}`);
    throw error;
  }
}

/**
 * Get transaction history
 * @param {number} userId - Telegram user ID
 * @param {number} page - Page number for pagination
 * @param {number} limit - Number of transactions per page
 * @returns {Promise<Array>} List of transactions
 */
async function getTransactionHistory(userId, page = 1, limit = 10) {
  try {
    const params = { page, limit };
    const response = await makeApiRequest('GET', '/api/transfers', userId, null, params);
    return response?.data || [];
  } catch (error) {
    logger.error(`Error getting transaction history: ${error.message}`);
    throw error;
  }
}

/**
 * Format a transaction into a readable string
 * @param {Object} transaction - Transaction data
 * @returns {string} Formatted string representation
 */
function formatTransaction(transaction) {
  const txId = transaction.id || 'Unknown';
  const txType = transaction.type || 'Unknown';
  const status = transaction.status || 'Unknown';
  const amount = transaction.amount || 0;
  const currency = transaction.currency || 'USDC';
  const createdAt = transaction.createdAt || 'Unknown date';
  
  // Determine transaction emoji based on type
  let emoji = '➡️'; // default
  if (txType.toLowerCase() === 'deposit') {
    emoji = '⬇️';
  } else if (txType.toLowerCase() === 'withdrawal') {
    emoji = '⬆️';
  }
  
  // Format recipient/sender info based on transaction type
  let recipientInfo = '';
  if ('email' in transaction) {
    recipientInfo = `Email: ${transaction.email}`;
  } else if ('walletAddress' in transaction) {
    // Abbreviate wallet address for readability
    const wallet = transaction.walletAddress;
    const abbreviated = wallet.length > 10 ? `${wallet.substring(0, 6)}...${wallet.substring(wallet.length - 4)}` : wallet;
    recipientInfo = `Wallet: ${abbreviated}`;
  }
  
  return (
    `${emoji} *${txType.charAt(0).toUpperCase() + txType.slice(1)}* (${status})\n` +
    `ID: ${txId}\n` +
    `Amount: ${amount} ${currency}\n` +
    `${recipientInfo}\n` +
    `Date: ${createdAt}\n`
  );
}

/**
 * Format transaction history into a readable message
 * @param {Array} transactions - List of transaction data
 * @returns {string} Formatted string representation
 */
function formatTransactionHistory(transactions) {
  if (!transactions || transactions.length === 0) {
    return "You don't have any transactions yet.";
  }
  
  let result = '*Your Recent Transactions*\n\n';
  
  for (const tx of transactions) {
    result += formatTransaction(tx) + '\n';
  }
  
  return result;
}

/**
 * Send same amount to multiple email addresses
 * @param {number} userId - Telegram user ID
 * @param {Array} payees - List of payee information (email and payee_id)
 * @param {string|number} amount - Amount to send to each payee
 * @param {string} currency - Currency to use for the transfers (default: USDV)
 * @returns {Promise<Object>} Response from the API
 */
async function sendBatchToEmails(userId, payees, amount, currency = 'USDV') {
  const token = await getUserToken(userId);
  if (!token) {
    throw new Error('User not authenticated');
  }
  
  try {
    // Convert amount to a format the API can handle
    try {
      // Convert to float first to handle string inputs
      const amountFloat = parseFloat(amount);
      
      // Check if the amount meets the minimum requirement (0.1 with 6 decimal places)
      const minAmountFloat = 0.1; // 0.1 minimum
      if (amountFloat < minAmountFloat) {
        throw new Error(`Amount must be at least ${minAmountFloat} ${currency}`);
      }
      
      
      let amountInt = Math.floor(amountFloat * 100000000);
      
      // Ensure the amount meets the minimum requirement (100000000)
      if (amountInt < 100000000) {
        amountInt = 100000000; // Set to minimum if below
      }
      
      // Convert to string
      const apiAmountStr = amountInt.toString();
      
      // Prepare the transfers array
      const transfers = [];
      
      for (const payee of payees) {
        const email = payee.email;
        const payeeId = payee.payee_id || payee.id;
        
        // Create transfer object
        const transfer = {
          email: email,
          amount: apiAmountStr,
          purposeCode: 'self',
          currency: currency
        };
        
        // Add payeeId if available
        if (payeeId) {
          transfer.payeeId = payeeId;
        }
        
        transfers.push(transfer);
      }
      
      // Create batch payload
      const payload = {
        transfers: transfers
      };
      
      logger.info(`Sending batch transfer with ${transfers.length} payees, each receiving ${amountFloat} ${currency}`);
      
      // Call make_api_request with the correct parameters
      const response = await makeApiRequest(
        'POST',
        '/api/transfers/batch',
        userId,
        payload
      );
      
      return response;
    } catch (e) {
      throw new Error(`Invalid amount: ${e.message}`);
    }
  } catch (error) {
    logger.error(`Error sending batch transfer: ${error.message}`);
    throw error;
  }
}

/**
 * Send batch of transfers to multiple emails with individual amounts
 * @param {number} userId - Telegram user ID
 * @param {Array} payees - Array of payee objects with payee_id, email, and amount
 * @returns {Promise<Object>} Batch transfer results
 */
async function sendBatchToEmailsWithAmounts(userId, payees) {
  const token = await getUserToken(userId);
  if (!token) {
    throw new Error('User not authenticated');
  }
  
  if (!Array.isArray(payees) || payees.length === 0) {
    throw new Error('No payees provided for batch transfer');
  }
  
  try {
    // Prepare the transfers array
    const transfers = [];
    
    for (const payee of payees) {
      const email = payee.email;
      let amount = payee.amount;
      const payeeId = payee.payee_id;
      const currency = payee.currency || 'USDV';
      
      // Validate required fields
      if (!email) {
        throw new Error('Missing email for one or more payees');
      }
      
      if (!amount) {
        throw new Error('Missing amount for one or more payees');
      }
      
      // Convert amount to a format the API can handle
      try {
        // Convert to float first to handle string inputs
        const amountFloat = parseFloat(amount);
        
        // Check minimum amount
        const minAmountFloat = 0.1; // 0.1 USDC/USDV
        if (amountFloat < minAmountFloat) {
          throw new Error(`Amount must be at least ${minAmountFloat} for each payee`);
        }
        
        // Multiply by 1,000,000 (6 decimal places)
        let amountInt = Math.floor(amountFloat * 100000000);
        
        // Ensure the amount meets the minimum requirement
        if (amountInt < 100000000) {
          amountInt = 100000000; // Set to minimum if below
        }
        
        // Convert to string
        amount = amountInt.toString();
      } catch (e) {
        throw new Error(`Invalid amount for payee ${email}: ${e.message}`);
      }
      
      // Create transfer object
      const transfer = {
        email: email,
        amount: amount,
        purposeCode: "self",
        currency: currency
      };
      
      // Add payeeId if available
      if (payeeId) {
        transfer.payeeId = payeeId;
      }
      
      transfers.push(transfer);
    }
    
    // Create batch payload
    const payload = {
      transfers: transfers
    };
    
    logger.info(`Sending batch transfer with ${transfers.length} payees`);
    
    // Call make_api_request with the correct parameters
    const response = await makeApiRequest(
      'POST',
      '/api/transfers/batch',
      userId,
      payload
    );
    
    return response;
  } catch (error) {
    logger.error(`Error sending batch transfers: ${error.message}`);
    throw error;
  }
}

/**
 * Format amount for display
 * @param {string|number} amount - The amount to format
 * @returns {string} Formatted amount string
 */
function formatAmount(amount) {
  try {
    // Convert to float, divide by 1e8, and format with 2 decimal places
    return (parseFloat(amount) / 1e8).toFixed(2);
  } catch (error) {
    // Return as is if conversion fails
    return String(amount);
  }
}

/**
 * Get detailed transaction information by ID
 * @param {number} userId - Telegram user ID
 * @param {string} txId - Transaction ID
 * @returns {Promise<Object|null>} Transaction details or null if not found
 */
async function getTransactionById(userId, txId) {
  try {
    // Get transaction history with a larger limit to find the specific transaction
    const transactions = await getTransactionHistory(userId, 1, 100);
    
    // Find the transaction by ID
    const transaction = transactions.find(tx => tx.id === txId);
    
    return transaction || null;
  } catch (error) {
    logger.error(`Error getting transaction by ID: ${error.message}`);
    throw error;
  }
}

/**
 * Format transaction details for display
 * @param {Object} transaction - Transaction data
 * @returns {string} Formatted transaction details
 */
function formatTransactionDetails(transaction) {
  if (!transaction) {
    return "Transaction not found.";
  }
  
  // Extract basic info
  const txId = transaction.id || 'Unknown';
  const txType = (transaction.type || 'Unknown').toUpperCase();
  const status = (transaction.status || 'Unknown').toUpperCase();
  const amount = formatAmount(transaction.amount || 0);
  const currency = transaction.currency || 'USDC';
  const createdAt = transaction.createdAt || 'Unknown date';
  
  // Format created date
  let formattedDate = createdAt;
  try {
    const date = new Date(createdAt);
    formattedDate = date.toISOString().replace('T', ' ').substring(0, 19);
  } catch (error) {
    // Use original value if date parsing fails
  }
  
  // Build the details message
  let details = [
    `*Transaction ID:* \`${txId}\``,
    `*Date:* ${formattedDate}`,
    `*Type:* ${txType}`,
    `*Amount:* ${amount} ${currency}`,
    `*Status:* ${status}`
  ];
  
  // Add source wallet info if available
  if (transaction.sourceWallet) {
    const sourceAddress = transaction.sourceWallet.address || 'N/A';
    details.push(`*Source Wallet:* \`${sourceAddress}\``);
  }
  
  // Add destination info based on type
  if (transaction.destinationAccount) {
    const destAccount = transaction.destinationAccount;
    if (destAccount.payeeDisplayName) {
      details.push(`*Destination Name:* ${destAccount.payeeDisplayName}`);
    }
    if (destAccount.payeeEmail) {
      details.push(`*Destination Email:* ${destAccount.payeeEmail}`);
    }
    if (destAccount.walletAddress) {
      details.push(`*Destination Wallet:* \`${destAccount.walletAddress}\``);
    }
  } else if (transaction.payee) {
    const payee = transaction.payee;
    if (payee.displayName) {
      details.push(`*Payee Name:* ${payee.displayName}`);
    }
    if (payee.email) {
      details.push(`*Payee Email:* ${payee.email}`);
    }
  }
  
  if (transaction.destinationWallet && !transaction.destinationAccount) {
    const destAddress = transaction.destinationWallet.address || 'N/A';
    details.push(`*Destination Wallet:* \`${destAddress}\``);
  }
  
  // Add transaction hash if available
  if (transaction.transactionHash) {
    details.push(`*Transaction Hash:* \`${transaction.transactionHash}\``);
  }
  
  // Add notes if available
  if (transaction.notes) {
    details.push(`*Notes:* ${transaction.notes}`);
  }
  
  return details.join('\n');
}

module.exports = {
  sendToEmail,
  withdrawToWallet,
  withdrawToBank,
  getTransactionHistory,
  formatTransaction,
  formatTransactionHistory,
  sendBatchToEmails,
  sendBatchToEmailsWithAmounts,
  formatAmount,
  getTransactionById,
  formatTransactionDetails
};