const axios = require('axios');
const logger = require('../utils/logger');
const { 
  COPPERX_API_BASE_URL, 
  EMAIL_REGEX,
  OTP_MAX_RETRIES,
  OTP_EXPIRY_SECONDS
} = require('../config');
const { 
  makeApiRequest, 
  storeUserToken, 
  getUserToken, 
  clearUserToken,
  storeOrganizationId,
  clearOrganizationId,
  checkRateLimit
} = require('../dependencies');

// Store OTP sessions in memory or Redis
// Format: { email: { sid: string, createdAt: timestamp, retries: number } }
const otpSessions = {};

/**
 * Request an OTP for the given email from Copperx API
 * @param {string} email - User's email address
 * @returns {Promise<string>} Session ID for OTP verification
 */
async function requestEmailOtp(email) {
  // Check for existing session to prevent abuse
  if (otpSessions[email]) {
    const session = otpSessions[email];
    const now = Date.now();
    
    // Check if session has expired
    if (session.createdAt + (OTP_EXPIRY_SECONDS * 1000) > now) {
      logger.info(`Reusing existing OTP session for ${email} with sid: ${session.sid}`);
      return session.sid;
    }
  }
  
  const url = `${COPPERX_API_BASE_URL}/api/auth/email-otp/request`;
  const payload = { email };
  
  // Log the request
  logger.info(`API Request: POST ${url}`);
  logger.info(`Payload: ${JSON.stringify({ email })}`);
  
  try {
    // Check rate limit for OTP requests (implemented at a service level)
    const rateLimit = checkRateLimit(email, '/api/auth/email-otp/request');
    if (rateLimit.limited) {
      const resetInSeconds = Math.ceil((rateLimit.resetTime - Date.now()) / 1000);
      logger.warn(`Rate limit exceeded for email ${email} on OTP request. Reset in ${resetInSeconds}s`);
      throw new Error(`Too many OTP requests. Please try again in ${resetInSeconds} seconds.`);
    }
    
    const response = await axios.post(url, payload);
    
    // Log the response
    logger.info(`API Response Status: ${response.status}`);
    logger.info(`API Response: ${JSON.stringify(response.data)}`);
    
    if (response.status === 200) {
      const sid = response.data.sid;
      if (!sid) {
        logger.error('No sid in response data');
        logger.error(`Response data: ${JSON.stringify(response.data)}`);
        throw new Error('No session ID received from server');
      }
      
      // Store the session for possible reuse
      otpSessions[email] = {
        sid,
        createdAt: Date.now(),
        retries: 0
      };
      
      logger.info(`OTP requested successfully for ${email} with sid: ${sid}`);
      return sid;
    } else {
      let errorMsg = 'Failed to request OTP';
      try {
        const errorData = response.data;
        logger.error(`Error response data: ${JSON.stringify(errorData)}`);
        if ('message' in errorData) {
          errorMsg = errorData.message;
        }
      } catch (e) {
        logger.error(`Failed to parse error response: ${e}`);
        logger.error(`Error response content: ${response.data}`);
      }
      throw new Error(`Error: ${errorMsg}`);
    }
  } catch (error) {
    logger.error(`Request failed: ${error.message}`);
    
    // If axios error, extract response details
    if (error.response) {
      logger.error(`Error response status: ${error.response.status}`);
      logger.error(`Error response data: ${JSON.stringify(error.response.data)}`);
      
      // If there's an error message in the response, throw that
      if (error.response.data && error.response.data.message) {
        throw new Error(error.response.data.message);
      }
    }
    
    throw new Error(`Failed to connect to server: ${error.message}`);
  }
}

/**
 * Verify the OTP and authenticate the user
 * @param {string} email - User's email address
 * @param {string} otp - One-time password received by email
 * @param {number} userId - Telegram user ID for storing the token
 * @param {string} sid - Session ID received from OTP request
 * @returns {Promise<Object>} User profile data
 */
async function verifyEmailOtp(email, otp, userId, sid) {
  // Verify we have a valid session
  const session = otpSessions[email];
  if (!session || session.sid !== sid) {
    throw new Error('Invalid or expired session. Please request a new OTP.');
  }
  
  // Check if we've exceeded retry attempts
  if (session.retries >= OTP_MAX_RETRIES) {
    delete otpSessions[email];
    throw new Error('Too many failed attempts. Please request a new OTP.');
  }
  
  // Increment retry counter
  session.retries++;
  
  const url = `${COPPERX_API_BASE_URL}/api/auth/email-otp/authenticate`;
  const payload = {
    email,
    otp,
    sid
  };
  
  // Log the request (mask OTP)
  logger.info(`API Request: POST ${url}`);
  logger.info(`Payload: ${JSON.stringify({ email, otp: '[REDACTED]', sid })}`);
  
  try {
    // Check rate limit for authentication
    const rateLimit = checkRateLimit(email, '/api/auth/email-otp/authenticate');
    if (rateLimit.limited) {
      const resetInSeconds = Math.ceil((rateLimit.resetTime - Date.now()) / 1000);
      logger.warn(`Rate limit exceeded for email ${email} on OTP verification. Reset in ${resetInSeconds}s`);
      throw new Error(`Too many authentication attempts. Please try again in ${resetInSeconds} seconds.`);
    }
    
    const response = await axios.post(url, payload);
    
    // Log the response
    logger.info(`API Response Status: ${response.status}`);
    
    // Try to log response as JSON, fall back to text if not JSON
    let responseData;
    try {
      responseData = response.data;
      // More detailed logging of the response structure
      logger.info(`Response data structure: ${Object.keys(responseData).join(', ')}`);
      
      // Mask sensitive data in response
      if ('accessToken' in responseData) {
        logger.info(`Received access token: ${responseData.accessToken.substring(0, 10)}...`);
        const responseDataLog = { ...responseData };
        responseDataLog.accessToken = '[REDACTED]';
        if ('refreshToken' in responseDataLog) {
          responseDataLog.refreshToken = '[REDACTED]';
        }
        logger.info(`API Response: ${JSON.stringify(responseDataLog)}`);
      } else {
        logger.warn(`Access token not found in response data, keys: ${Object.keys(responseData).join(', ')}`);
        logger.info(`API Response: ${JSON.stringify(responseData)}`);
      }
    } catch (e) {
      logger.warn(`Could not parse response as JSON: ${e.message}`);
      logger.info(`API Response: ${response.data}`);
    }
    
    if (response.status !== 200) {
      let errorMsg = 'Invalid OTP';
      try {
        const errorData = response.data;
        logger.error(`Error response data: ${JSON.stringify(errorData)}`);
        if (typeof errorData === 'object') {
          if ('message' in errorData) {
            errorMsg = errorData.message;
          } else if ('property' in errorData) {
            errorMsg = `Validation error for ${errorData.property || 'unknown field'}`;
          }
        }
      } catch (e) {
        logger.error(`Failed to parse error response: ${e}`);
        logger.error(`Error response content: ${response.data}`);
      }
      throw new Error(`Authentication failed: ${errorMsg}`);
    }
    
    // Clear OTP session on successful authentication
    delete otpSessions[email];
    
    // Store the token
    const tokenData = response.data;
    
    // Handle potential nested token data structure
    let processedTokenData = tokenData;
    if (!tokenData.accessToken && tokenData.data && typeof tokenData.data === 'object' && tokenData.data.accessToken) {
      logger.info('Found token in nested data structure, extracting...');
      processedTokenData = tokenData.data;
    }
    
    // Add expiry information if not present
    if (!processedTokenData.expiresAt && !processedTokenData.expiresIn) {
      // Default expiry of 24 hours
      processedTokenData.expiresIn = 24 * 60 * 60;
      processedTokenData.expiresAt = new Date(Date.now() + processedTokenData.expiresIn * 1000).toISOString();
    } else if (!processedTokenData.expiresAt && processedTokenData.expiresIn) {
      processedTokenData.expiresAt = new Date(Date.now() + processedTokenData.expiresIn * 1000).toISOString();
    }
    
    // Ensure the token has required fields
    if (!processedTokenData.accessToken) {
      logger.error('Missing accessToken in authentication response');
      logger.error(`Response data: ${JSON.stringify(processedTokenData)}`);
      throw new Error('Authentication failed: Invalid token format');
    }
    
    await storeUserToken(userId, processedTokenData);
    
    logger.info(`Authentication successful for ${email}`);
    
    // Get user profile to extract organization ID
    try {
      const profile = await getUserProfile(userId);
      
      // Extract and store organization ID if available
      if (profile && 'organizationId' in profile) {
        const orgId = profile.organizationId;
        if (orgId) {
          await storeOrganizationId(userId, orgId);
          logger.info(`Stored organization ID ${orgId} for user ${userId}`);
          
          // Initialize Pusher subscription for this organization
          try {
            const PusherClient = require('../utils/pusherClient');
            const pusherClients = require('../bot/telegramBot').pusherClients;
            
            // Create a new pusher client for this user if not exists
            if (!pusherClients[userId]) {
              const accessToken = processedTokenData.accessToken;
              const pusherClient = new PusherClient(userId, accessToken, orgId);
              pusherClients[userId] = pusherClient;
              
              // Subscribe to organization channel
              const channelName = `private-org-${orgId}`;
              await pusherClient.subscribe(channelName);
              logger.info(`Subscribed to Pusher channel: ${channelName}`);
            }
          } catch (e) {
            logger.error(`Failed to initialize Pusher subscription: ${e.message}`);
          }
        }
      }
      
      return profile;
    } catch (e) {
      logger.error(`Error getting user profile: ${e.message}`);
      // Return a default profile if we can't get the real one
      return {
        firstName: 'User',
        lastName: '',
        email
      };
    }
  } catch (error) {
    logger.error(`Verification request failed: ${error.message}`);
    
    // If axios error, extract response details
    if (error.response) {
      logger.error(`Error response status: ${error.response.status}`);
      logger.error(`Error response data: ${JSON.stringify(error.response.data)}`);
      
      // If there's an error message in the response, throw that
      if (error.response.data && error.response.data.message) {
        throw new Error(error.response.data.message);
      }
    }
    
    throw error;
  }
}

/**
 * Get the user's profile information
 * @param {number} userId - Telegram user ID
 * @returns {Promise<Object>} User profile data
 */
async function getUserProfile(userId) {
  const tokenData = await getUserToken(userId);
  if (!tokenData) {
    throw new Error('Not authenticated');
  }
  
  // Extract the access token from the token data
  const accessToken = tokenData.accessToken;
  if (!accessToken) {
    throw new Error('Invalid token format');
  }
  
  const url = `${COPPERX_API_BASE_URL}/api/auth/me`;
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };
  
  logger.info(`Getting user profile with token: Bearer ${accessToken.substring(0, 10)}...`);
  
  try {
    const response = await axios.get(url, { headers });
    
    // Log the response status
    logger.info(`Profile API Response Status: ${response.status}`);
    
    return response.data;
  } catch (error) {
    // Log the error response
    logger.error(`Profile API Error: ${error.message}`);
    if (error.response) {
      try {
        logger.error(`Profile API Error Response: ${JSON.stringify(error.response.data)}`);
      } catch (e) {
        logger.error(`Profile API Error Response: ${error.response.data}`);
      }
      
      // If unauthorized (token expired), try to refresh token and retry
      if (error.response.status === 401 && tokenData.refreshToken) {
        try {
          logger.info(`Attempting to refresh token and retry profile fetch`);
          const { refreshToken } = require('../dependencies');
          const newTokenData = await refreshToken(userId, tokenData.refreshToken);
          
          if (newTokenData && newTokenData.accessToken) {
            // Retry with new token
            const retryHeaders = {
              'Authorization': `Bearer ${newTokenData.accessToken}`,
              'Content-Type': 'application/json'
            };
            
            const retryResponse = await axios.get(url, { headers: retryHeaders });
            return retryResponse.data;
          }
        } catch (refreshError) {
          logger.error(`Failed to refresh token and retry: ${refreshError.message}`);
        }
      }
    }
    
    // Return a default profile if we can't get the real one
    logger.warn('Returning default profile due to API error');
    return {
      firstName: 'User',
      lastName: '',
      email: ''
    };
  }
}

/**
 * Format user profile data into a readable message
 * @param {Object} profile - User profile data
 * @returns {string} Formatted profile message
 */
async function formatUserProfile(profile) {
  // Extract profile information
  const firstName = profile.firstName || '';
  const lastName = profile.lastName || '';
  const email = profile.email || '';
  const role = profile.role || '';
  const status = profile.status || '';
  const userType = profile.type || '';
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
  
  // Add role and status
  if (role) {
    result += `*Role:* ${capitalizeFirstLetter(role)}\n`;
  }
  
  if (status) {
    result += `*Status:* ${capitalizeFirstLetter(status)}\n`;
  }
  
  if (userType) {
    result += `*Account Type:* ${capitalizeFirstLetter(userType)}\n`;
  }
  
  // Add wallet address if available
  if (walletAddress) {
    result += `\n*Wallet Address:*\n\`${walletAddress}\`\n`;
  }
  
  return result;
}

/**
 * Check the KYC/KYB status of the user
 * @param {number} userId - Telegram user ID
 * @returns {Promise<Object>} KYC status information
 */
async function checkKycStatus(userId) {
  return await makeApiRequest('GET', '/api/kycs', userId);
}

/**
 * Log the user out
 * @param {number} userId - Telegram user ID
 */
async function logout(userId) {
  // Clear auth token
  await clearUserToken(userId);
  
  // Clear organization ID
  await clearOrganizationId(userId);
  
  // Disconnect from Pusher if connected
  try {
    const { pusherClients } = require('../bot/telegramBot');
    const pusherClient = pusherClients[userId];
    if (pusherClient) {
      pusherClient.disconnect();
      delete pusherClients[userId];
    }
  } catch (error) {
    logger.error(`Error disconnecting from Pusher: ${error.message}`);
  }
  
  logger.info(`User ${userId} logged out successfully`);
}

/**
 * Validate email format
 * @param {string} email - Email to validate
 * @returns {boolean} Whether the email is valid
 */
function validateEmail(email) {
  return EMAIL_REGEX.test(email);
}

/**
 * Capitalize the first letter of a string
 * @param {string} str - Input string
 * @returns {string} String with first letter capitalized
 */
function capitalizeFirstLetter(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

module.exports = {
  requestEmailOtp,
  verifyEmailOtp,
  getUserProfile,
  formatUserProfile,
  checkKycStatus,
  logout,
  validateEmail
};