const logger = require('../utils/logger');
const { makeApiRequest } = require('../dependencies');

/**
 * Get list of payees
 * @param {number} userId - Telegram user ID
 * @param {number} page - Page number
 * @param {number} limit - Number of items per page
 * @returns {Promise<Array>} List of payees
 */
async function getPayees(userId, page = 1, limit = 10) {
  try {
    const params = { page, limit };
    const response = await makeApiRequest('GET', '/api/payees', userId, null, params);
    
    // Check if response is null or doesn't have 'data' key
    if (!response) {
      logger.warn(`Empty response from payees API for user ${userId}`);
      return [];
    }
    
    return response.data || [];
  } catch (error) {
    logger.error(`Error getting payees: ${error.message}`);
    return []; // Return empty list on error
  }
}

/**
 * Add a new payee
 * @param {number} userId - Telegram user ID
 * @param {string} email - Payee email address
 * @param {string} nickname - Display name for the payee
 * @returns {Promise<Object>} Newly created payee data
 */
async function addPayee(userId, email, nickname) {
  const payload = {
    nickName: nickname,
    email: email
  };
  
  logger.info(`Adding new payee with payload: ${JSON.stringify(payload)}`);
  
  try {
    return await makeApiRequest('POST', '/api/payees', userId, payload);
  } catch (error) {
    logger.error(`Error adding payee: ${error.message}`);
    throw error;
  }
}

/**
 * Get a payee by ID
 * @param {number} userId - Telegram user ID
 * @param {string} payeeId - Payee ID to retrieve
 * @returns {Promise<Object|null>} Payee data or null if not found
 */
async function getPayeeById(userId, payeeId) {
  try {
    const response = await makeApiRequest('GET', `/api/payees/${payeeId}`, userId);
    return response || null;
  } catch (error) {
    logger.error(`Error getting payee by ID: ${error.message}`);
    return null;
  }
}

/**
 * Update an existing payee
 * @param {number} userId - Telegram user ID
 * @param {string} payeeId - Payee ID to update
 * @param {Object} updateData - Updated payee data (email, nickName)
 * @returns {Promise<Object>} Updated payee data
 */
async function updatePayee(userId, payeeId, updateData) {
  try {
    return await makeApiRequest('PUT', `/api/payees/${payeeId}`, userId, updateData);
  } catch (error) {
    logger.error(`Error updating payee: ${error.message}`);
    throw error;
  }
}

/**
 * Delete a payee
 * @param {number} userId - Telegram user ID
 * @param {string} payeeId - Payee ID to delete
 * @returns {Promise<boolean>} Whether deletion was successful
 */
async function deletePayee(userId, payeeId) {
  try {
    await makeApiRequest('DELETE', `/api/payees/${payeeId}`, userId);
    return true;
  } catch (error) {
    logger.error(`Error deleting payee: ${error.message}`);
    return false;
  }
}

/**
 * Format payees for display
 * @param {Array} payees - List of payee objects
 * @returns {string} Formatted payee list for display
 */
function formatPayeeList(payees) {
  if (!payees || payees.length === 0) {
    return "You don't have any saved payees yet.";
  }
  
  let result = '*Your Saved Payees*\n\n';
  
  for (let i = 0; i < payees.length; i++) {
    const payee = payees[i];
    const email = payee.email;
    const nickname = payee.nickName;
    
    if (nickname) {
      result += `${i+1}. ${nickname} - ${email}\n`;
    } else {
      result += `${i+1}. ${email}\n`;
    }
  }
  
  return result;
}

module.exports = {
  getPayees,
  addPayee,
  getPayeeById,
  updatePayee,
  deletePayee,
  formatPayeeList
};