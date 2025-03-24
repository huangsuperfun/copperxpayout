const logger = require('../utils/logger');
const { makeApiRequest } = require('../dependencies');
const { STATUS_MAPPING } = require('../config');

/**
 * Get KYC verification status
 * @param {number} userId - Telegram user ID
 * @returns {Promise<Object>} KYC status data
 */
async function getKycStatus(userId) {
  try {
    const response = await makeApiRequest('GET', '/api/kycs', userId);
    return response;
  } catch (error) {
    logger.error(`Error getting KYC status: ${error.message}`);
    // Return empty data instead of throwing
    return { data: [] };
  }
}

/**
 * Format KYC status information into human-readable form
 * @param {Object} kycRecord - KYC record data
 * @returns {string} Formatted KYC status message
 */
function formatKycStatus(kycRecord) {
  if (!kycRecord) {
    return "No KYC information available.";
  }
  
  // Extract status and details
  const status = kycRecord.status?.toLowerCase() || 'unknown';
  
  // Simplify status into main categories
  let displayStatus;
  let statusEmoji;
  
  if (status === 'verified' || status === 'approved') {
    displayStatus = 'Approved';
    statusEmoji = '✅';
  } else if (status === 'rejected') {
    displayStatus = 'Rejected';
    statusEmoji = '❌';
  } else if (status === 'expired') {
    displayStatus = 'Expired';
    statusEmoji = '⏰';
  } else {
    displayStatus = 'Pending';
    statusEmoji = '⏳';
  }
  
  // Get personal details
  const kycDetail = kycRecord.kycDetail || {};
  const firstName = kycDetail.firstName || '';
  const lastName = kycDetail.lastName || '';
  const email = kycDetail.email || '';
  const nationality = (kycDetail.nationality || '').toUpperCase();
  
  // Create message
  let message = `*KYC Verification Status*\n\n`;
  message += `*Current Status:* ${statusEmoji} ${displayStatus}\n\n`;
  
  message += `*Personal Details:*\n`;
  if (firstName || lastName) {
    message += `• Name: ${firstName} ${lastName}\n`;
  }
  if (email) {
    message += `• Email: ${email}\n`;
  }
  if (nationality) {
    message += `• Nationality: ${nationality}\n`;
  }
  
  // Format status updates with simplified categories
  const statusUpdates = kycRecord.statusUpdates || {};
  if (Object.keys(statusUpdates).length > 0) {
    message += `\n*Status History:*\n`;
    for (const [statusKey, timestamp] of Object.entries(statusUpdates)) {
      let historyStatus;
      let historyEmoji;
      
      const currentStatus = statusKey.toLowerCase();
      if (currentStatus === 'verified' || currentStatus === 'approved') {
        historyStatus = 'Approved';
        historyEmoji = '✅';
      } else if (currentStatus === 'rejected') {
        historyStatus = 'Rejected';
        historyEmoji = '❌';
      } else if (currentStatus === 'expired') {
        historyStatus = 'Expired';
        historyEmoji = '⏰';
      } else {
        historyStatus = 'Pending';
        historyEmoji = '⏳';
      }
      
      // Format timestamp
      let formattedDate;
      try {
        const dt = new Date(timestamp);
        formattedDate = dt.toLocaleString('en-US', { 
          month: 'short', 
          day: 'numeric', 
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'UTC'
        });
        formattedDate += ' UTC';
      } catch {
        formattedDate = timestamp;
      }
      
      message += `${historyEmoji} ${historyStatus}: ${formattedDate}\n`;
    }
  }
  
  // Add action message based on status
  if (displayStatus === 'Approved') {
    message += '\n✨ Your KYC verification is complete. You have full access to all features.';
  } else if (displayStatus === 'Rejected') {
    message += '\n❗️ Your KYC verification was rejected. Please contact support for assistance.';
  } else if (displayStatus === 'Expired') {
    message += '\n⚠️ Your KYC verification has expired. Please complete the verification process again.';
  } else {
    message += '\n📝 Your KYC verification is in progress. We will notify you once the review is complete.';
  }
  
  return message;
}

module.exports = {
  getKycStatus,
  formatKycStatus
};