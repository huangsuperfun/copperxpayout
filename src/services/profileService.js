const logger = require('../utils/logger');
const { makeApiRequest } = require('../dependencies');

/**
 * Get user profile information
 * @param {number} userId - Telegram user ID
 * @returns {Promise<Object>} User profile data
 */
async function getUserProfile(userId) {
  try {
    const response = await makeApiRequest('GET', '/api/auth/me', userId);
    return response;
  } catch (error) {
    logger.error(`Error fetching user profile: ${error.message}`);
    // Return a default profile in case of error
    return {
      firstName: 'User',
      lastName: '',
      email: ''
    };
  }
}

/**
 * Format user profile data into a readable string
 * @param {Object} profile - User profile data
 * @returns {string} Formatted profile string
 */
function formatUserProfile(profile) {
  if (!profile) {
    return "No profile information available.";
  }
  
  // Extract profile information
  const firstName = profile.firstName || '';
  const lastName = profile.lastName || '';
  const email = profile.email || '';
  const role = profile.role || '';
  const status = profile.status || '';
  const userType = profile.type || '';
  const countryCode = profile.countryCode || '';
  const walletAddress = profile.walletAddress || '';
  
  // Format the message
  let result = '*Your Profile*\n\n';
  
  // Add name
  if (firstName || lastName) {
    result += `*Name:* ${firstName} ${lastName}\n`;
  }
  
  // Add email
  if (email) {
    result += `*Email:* ${email}\n`;
  }
  
  // Add role, status, and type if available
  if (role) {
    result += `*Role:* ${role.charAt(0).toUpperCase() + role.slice(1)}\n`;
  }
  
  if (status) {
    result += `*Status:* ${status.charAt(0).toUpperCase() + status.slice(1)}\n`;
  }
  
  if (userType) {
    result += `*Account Type:* ${userType.charAt(0).toUpperCase() + userType.slice(1)}\n`;
  }
  
  // Add country code if available
  if (countryCode) {
    result += `*Country:* ${countryCode.toUpperCase()}\n`;
  }
  
  // Add wallet address if available
  if (walletAddress) {
    result += `\n*Wallet Address:*\n\`${walletAddress}\`\n`;
  }
  
  return result;
}

/**
 * Update specific user profile details
 * @param {number} userId - Telegram user ID
 * @param {Object} profileData - Profile data to update
 * @returns {Promise<Object>} Updated user profile
 */
async function updateUserProfile(userId, profileData) {
  try {
    const response = await makeApiRequest('PUT', '/api/auth/me', userId, profileData);
    return response;
  } catch (error) {
    logger.error(`Error updating user profile: ${error.message}`);
    throw error;
  }
}

/**
 * Get user's organization information
 * @param {number} userId - Telegram user ID
 * @returns {Promise<Object>} Organization data
 */
async function getUserOrganization(userId) {
  try {
    const response = await makeApiRequest('GET', '/api/organizations/me', userId);
    return response;
  } catch (error) {
    logger.error(`Error fetching user organization: ${error.message}`);
    throw error;
  }
}

/**
 * Format organization information into readable text
 * @param {Object} organization - Organization data
 * @returns {string} Formatted organization information
 */
function formatOrganizationInfo(organization) {
  if (!organization) {
    return "No organization information available.";
  }
  
  // Extract organization info
  const name = organization.name || '';
  const status = organization.status || '';
  const type = organization.type || '';
  const industry = organization.industry || '';
  
  // Format the message
  let result = '*Your Organization*\n\n';
  
  if (name) {
    result += `*Name:* ${name}\n`;
  }
  
  if (status) {
    result += `*Status:* ${status.charAt(0).toUpperCase() + status.slice(1)}\n`;
  }
  
  if (type) {
    result += `*Type:* ${type.charAt(0).toUpperCase() + type.slice(1)}\n`;
  }
  
  if (industry) {
    result += `*Industry:* ${industry.charAt(0).toUpperCase() + industry.slice(1)}\n`;
  }
  
  return result;
}

module.exports = {
  getUserProfile,
  formatUserProfile,
  updateUserProfile,
  getUserOrganization,
  formatOrganizationInfo
};