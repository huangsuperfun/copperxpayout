const logger = require('../utils/logger');
const { makeApiRequest } = require('../dependencies');
const { NETWORK_NAMES } = require('../config');

/**
 * Get the list of user wallets
 * @param {number} userId - Telegram user ID
 * @returns {Promise<Array>} List of wallets
 */
async function getWallets(userId) {
  try {
    const response = await makeApiRequest('GET', '/api/wallets', userId);
    
    // If response is already a list, return it
    if (Array.isArray(response)) {
      return response;
    }
    
    // If response has a data field containing the list
    if (response && typeof response === 'object' && 'data' in response) {
      return response.data;
    }
    
    // If we get here, something is wrong with the response format
    logger.error(`Unexpected wallet response format: ${JSON.stringify(response)}`);
    return [];
  } catch (error) {
    logger.error(`Error getting wallets: ${error.message}`);
    return [];
  }
}

/**
 * Get the balances of user wallets
 * @param {number} userId - Telegram user ID (used for authentication)
 * @returns {Promise<Array>} List of wallet balances
 */
async function getWalletBalances(userId) {
  try {
    // The userId is only used for authentication, not as a parameter
    const response = await makeApiRequest('GET', '/api/wallets/balances', userId);
    
    // Handle null response
    if (response === null) {
      logger.warn(`Empty response from wallet balances API for user ${userId}`);
      return [];
    }
    
    // If response is already a list, return it
    if (Array.isArray(response)) {
      return response;
    }
    
    // If response has a data field containing the list
    if (typeof response === 'object' && 'data' in response) {
      return response.data;
    }
    
    // If we get here, something is wrong with the response format
    logger.error(`Unexpected wallet response format: ${typeof response}`);
    return []; // Return empty list instead of raising exception
  } catch (error) {
    logger.error(`Error getting wallet balances: ${error.message}`);
    return []; // Return empty list on error
  }
}

/**
 * Set a wallet as the default
 * @param {number} userId - Telegram user ID
 * @param {string} walletId - ID of the wallet to set as default
 * @returns {Promise<Object>} Updated wallet data
 */
async function setDefaultWallet(userId, walletId) {
  try {
    const payload = { walletId };
    return await makeApiRequest('POST', '/api/wallets/default', userId, payload);
  } catch (error) {
    logger.error(`Error setting default wallet: ${error.message}`);
    throw error;
  }
}

/**
 * Get the human-readable network name from network ID
 * @param {string} networkId - Network ID as string
 * @returns {string} Human-readable network name
 */
function getNetworkName(networkId) {
  return NETWORK_NAMES[networkId] || `Unknown Network (${networkId})`;
}

/**
 * Format wallet balance data into a readable string
 * @param {Object} balance - Wallet balance data
 * @returns {string} Formatted string representation
 */
function formatWalletBalance(balance) {
  const walletName = balance.wallet?.name || 'Unknown Wallet';
  const currency = balance.currency || 'USDC';
  const amount = balance.amount || 0;
  const networkId = balance.wallet?.network;
  const networkName = getNetworkName(networkId);
  const isDefault = balance.wallet?.isDefault || false;
  
  const defaultMarker = isDefault ? '✅ DEFAULT' : '';
  
  return (
    `💰 *${walletName}* ${defaultMarker}\n` +
    `Network: ${networkName}\n` +
    `Balance: ${amount} ${currency}\n`
  );
}

/**
 * Format all wallet balances into a readable message
 * @param {Array} balances - List of wallet balance data
 * @returns {string} Formatted string representation
 */
function formatAllWalletBalances(balances) {
  if (!balances || balances.length === 0) {
    return "You don't have any wallets with balances yet.";
  }
  
  let result = '*Your Wallet Balances*\n\n';
  
  for (const balance of balances) {
    result += formatWalletBalance(balance) + '\n';
  }
  
  return result;
}

/**
 * Get formatted wallet balances grouped by network
 * @param {number} userId - Telegram user ID
 * @returns {Promise<[string, Object]>} Formatted string representation of wallet balances and wallet IDs by network
 */
async function getFormattedWalletBalances(userId) {
  try {
    // First get the wallets to get the address
    const wallets = await getWallets(userId);
    
    if (!wallets || wallets.length === 0) {
      return ["You don't have any wallets yet.", {}];
    }
    
    // Store wallet addresses and IDs by network
    const walletAddresses = {};
    const walletIdsByNetwork = {};
    let defaultNetwork = null;
    
    for (const wallet of wallets) {
      const networkId = wallet.network;
      if (!networkId) {
        continue;
      }
      
      // Get wallet address
      const address = wallet.address || wallet.walletAddress;
      if (address) {
        walletAddresses[networkId] = address;
      }
      
      // Store wallet ID by network
      walletIdsByNetwork[networkId] = wallet.id;
      
      // Check if this is the default wallet
      if (wallet.isDefault === true) {
        defaultNetwork = networkId;
      }
    }
    
    // Get the balances
    const balancesResponse = await getWalletBalances(userId);
    
    if (!balancesResponse || balancesResponse.length === 0) {
      return ["*Your Wallet Balances*\n\nNo balances found for your wallets.", walletIdsByNetwork];
    }
    
    // Format the message
    let result = "*Your Wallet Balances*\n\n";
    
    // Process the response format
    for (const walletBalance of balancesResponse) {
      const networkId = walletBalance.network;
      const networkName = getNetworkName(networkId);
      const isDefault = walletBalance.isDefault === true || networkId === defaultNetwork;
      
      // Get wallet address for this network
      const address = walletAddresses[networkId] || '';
      
      // Truncate address for display (0x12...34)
      let truncatedAddress = '';
      if (address) {
        truncatedAddress = address.length > 10 
          ? `${address.substring(0, 6)}..${address.substring(address.length - 4)}`
          : address;
      }
      
      // Add network name with truncated address and default label
      if (isDefault) {
        result += `- *${networkName} - * \`${truncatedAddress}\` (Default)\n`;
      } else {
        result += `- *${networkName} - * \`${truncatedAddress}\`\n`;
      }
      
      // Get token balances for this network
      const tokenBalances = walletBalance.balances || [];
      
      if (!tokenBalances || tokenBalances.length === 0) {
        result += `     ↳ No tokens found\n`;
        continue;
      }
      
      for (const token of tokenBalances) {
        const symbol = token.symbol || 'Unknown';
        let balance = token.balance || '0';
        
        // Format the balance (remove trailing zeros if it's a whole number)
        try {
          if (parseFloat(balance) % 1 === 0) {
            balance = parseInt(balance).toString();
          }
        } catch (error) {
          // Keep as is if conversion fails
        }
        
        result += `     ↳ ${balance} ${symbol}\n`;
      }
    }
    
    return [result, walletIdsByNetwork];
  } catch (error) {
    logger.error(`Error formatting wallet balances: ${error.message}`);
    return ["Error retrieving wallet balances. Please try again later.", {}];
  }
}

/**
 * Get deposit address for a specific network
 * @param {number} userId - Telegram user ID
 * @param {string} networkId - Network ID
 * @returns {Promise<string|null>} Wallet address or null if not found
 */
async function getDepositAddress(userId, networkId) {
  try {
    const wallets = await getWallets(userId);
    
    if (!wallets || wallets.length === 0) {
      return null;
    }
    
    for (const wallet of wallets) {
      if (wallet.network === networkId) {
        return wallet.address || wallet.walletAddress || null;
      }
    }
    
    return null;
  } catch (error) {
    logger.error(`Error getting deposit address: ${error.message}`);
    return null;
  }
}

module.exports = {
  getWallets,
  getWalletBalances,
  setDefaultWallet,
  getNetworkName,
  formatWalletBalance,
  formatAllWalletBalances,
  getFormattedWalletBalances,
  getDepositAddress
};