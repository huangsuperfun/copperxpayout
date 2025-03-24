const axios = require('axios');
const Redis = require('ioredis');
const logger = require('./utils/logger');
const { 
  COPPERX_API_BASE_URL, 
  TOKENS, 
  ORGANIZATION_IDS, 
  REDIS_URL,
  TOKEN_EXPIRY_SECONDS
} = require('./config');

// Initialize Redis client if URL is provided
let redisClient = null;
if (REDIS_URL) {
  try {
    redisClient = new Redis(REDIS_URL);
    redisClient.on('connect', () => {
      logger.info('Redis connection established');
    });
    redisClient.on('error', (err) => {
      logger.warn(`Redis error: ${err}. Using in-memory storage instead.`);
      redisClient = null;
    });
    // Test the connection
    redisClient.ping().catch(err => {
      logger.warn(`Failed to connect to Redis: ${err}. Using in-memory storage instead.`);
      redisClient = null;
    });
  } catch (err) {
    logger.warn(`Redis initialization error: ${err}. Using in-memory storage instead.`);
    redisClient = null;
  }
}

// Rate limiting for API requests
const rateLimits = {
  // Store rate limit data by userId and endpoint
  // Format: { userId_endpoint: { count: 0, resetTime: timestamp } }
};

// Rate limit configuration
const rateLimitConfig = {
  '/api/auth/email-otp/request': { limit: 5, windowMs: 60 * 1000 }, // 5 requests per minute
  '/api/auth/email-otp/authenticate': { limit: 10, windowMs: 60 * 1000 }, // 10 requests per minute
  '/api/transfers/send': { limit: 20, windowMs: 60 * 1000 }, // 20 requests per minute
  'default': { limit: 50, windowMs: 60 * 1000 } // Default for all other endpoints
};

/**
 * Check and update rate limit for a specific user and endpoint
 * @param {number} userId - Telegram user ID
 * @param {string} endpoint - API endpoint
 * @returns {Object} Rate limit status { limited: boolean, resetTime: timestamp, limit: number }
 */
function checkRateLimit(userId, endpoint) {
  // Get rate limit config for this endpoint or use default
  const config = rateLimitConfig[endpoint] || rateLimitConfig.default;
  const { limit, windowMs } = config;
  
  // Create a key combining userId and endpoint
  const key = `${userId}_${endpoint}`;
  
  const now = Date.now();
  
  // Initialize or get current rate limit data
  if (!rateLimits[key] || rateLimits[key].resetTime < now) {
    rateLimits[key] = { count: 0, resetTime: now + windowMs };
  }
  
  // Increment count
  rateLimits[key].count++;
  
  // Check if rate limited
  const isLimited = rateLimits[key].count > limit;
  
  // Return limit status
  return {
    limited: isLimited,
    resetTime: rateLimits[key].resetTime,
    limit,
    remaining: Math.max(0, limit - rateLimits[key].count)
  };
}

/**
 * Make an API request to Copperx API with rate limiting
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {string} endpoint - API endpoint
 * @param {number|null} userId - Telegram user ID (for authenticated requests)
 * @param {Object|null} payload - Request body
 * @param {Object|null} params - Query parameters
 * @returns {Promise<Object>} API response
 */
async function makeApiRequest(method, endpoint, userId = null, payload = null, params = null) {
  const url = `${COPPERX_API_BASE_URL}${endpoint}`;
  const headers = { 'Content-Type': 'application/json' };
  
  // Check rate limit if userId is provided
  if (userId !== null) {
    const rateLimit = checkRateLimit(userId, endpoint);
    if (rateLimit.limited) {
      const resetInSeconds = Math.ceil((rateLimit.resetTime - Date.now()) / 1000);
      logger.warn(`Rate limit exceeded for user ${userId} on endpoint ${endpoint}. Reset in ${resetInSeconds}s`);
      throw new Error(`Rate limit exceeded. Please try again in ${resetInSeconds} seconds.`);
    }
    
    // Add authorization header if userId is provided
    const tokenData = await getUserToken(userId);
    if (tokenData) {
      // Extract the access token from the token data
      const accessToken = tokenData.accessToken;
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
        logger.debug(`Using token for user ${userId}: ${accessToken.substring(0, 10)}...`);
      } else {
        logger.warn(`Invalid token format for user ${userId}`);
      }
      
      // Check if token is expired or close to expiry
      if (tokenData.expiresAt && new Date(tokenData.expiresAt) < new Date(Date.now() + 5 * 60 * 1000)) {
        logger.info(`Token for user ${userId} is expired or about to expire. Attempting refresh.`);
        try {
          const newTokenData = await refreshToken(userId, tokenData.refreshToken);
          if (newTokenData && newTokenData.accessToken) {
            // Update the request with the new token
            headers['Authorization'] = `Bearer ${newTokenData.accessToken}`;
          }
        } catch (err) {
          logger.error(`Failed to refresh token: ${err.message}`);
          // Continue with the old token and let the API handle any auth errors
        }
      }
    }
  }
  
  // Log the request details
  logger.info(`API Request: ${method} ${url}`);
  logger.info(`Headers: ${JSON.stringify(maskSensitiveData(headers))}`);
  
  if (params) {
    logger.info(`Query params: ${JSON.stringify(params)}`);
  }
  
  if (payload) {
    // Mask sensitive fields in the payload log
    const payloadLog = typeof payload === 'object' ? {...payload} : payload;
    if (typeof payloadLog === 'object') {
      for (const sensitiveField of ['password', 'token', 'secret', 'key', 'otp']) {
        if (sensitiveField in payloadLog) {
          payloadLog[sensitiveField] = '[REDACTED]';
        }
      }
    }
    logger.info(`Request payload: ${JSON.stringify(payloadLog)}`);
  }
  
  try {
    const startTime = Date.now();
    
    const config = {
      method,
      url,
      headers,
      params
    };
    
    if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) && payload) {
      config.data = payload;
    }
    
    const response = await axios(config);
    
    // Calculate request duration
    const duration = (Date.now() - startTime) / 1000;
    
    // Log the response details
    logger.info(`API Response: ${method} ${url} - Status: ${response.status} - Duration: ${duration.toFixed(2)}s`);
    
    // Log response data (truncated for large responses)
    const responseStr = JSON.stringify(response.data);
    if (responseStr.length > 1000) {
      logger.info(`Response data (truncated): ${responseStr.substring(0, 1000)}...`);
    } else {
      logger.info(`Response data: ${responseStr}`);
    }
    
    return response.data;
  } catch (error) {
    logger.error(`Request error: ${error.message}`);
    logger.error(`Request details: ${method} ${url}`);
    
    // Extract and log response error details if available
    if (error.response) {
      const status = error.response.status;
      let errorData;
      
      try {
        errorData = error.response.data;
        logger.error(`API Error (${status}): ${JSON.stringify(errorData)}`);
      } catch (e) {
        errorData = error.response.data;
        logger.error(`API Error (${status}): ${errorData}`);
      }
      
      // Check if token is expired (401 Unauthorized)
      if (status === 401 && userId) {
        logger.info(`Unauthorized error for user ${userId}. Clearing token.`);
        clearUserToken(userId);
      }
      
      throw new Error(errorData.message || `API Error: ${status}`);
    }
    
    throw new Error(`Connection error: ${error.message}`);
  }
}

/**
 * Store user token in Redis or memory with expiry time
 * @param {number} userId - Telegram user ID
 * @param {Object} tokenData - Token data from authentication
 */
async function storeUserToken(userId, tokenData) {
  // Calculate token expiry if not provided in token data
  if (!tokenData.expiresAt && tokenData.expiresIn) {
    tokenData.expiresAt = new Date(Date.now() + tokenData.expiresIn * 1000).toISOString();
  }
  
  // Use default expiry time if none calculated
  const expirySeconds = tokenData.expiresIn || TOKEN_EXPIRY_SECONDS || 86400; // Default 24 hours
  
  if (redisClient) {
    try {
      // Convert token data to JSON string for Redis storage
      const tokenJson = JSON.stringify(tokenData);
      
      // Store token with key pattern "token:{userId}"
      await redisClient.setex(`token:${userId}`, expirySeconds, tokenJson);
      logger.info(`Token stored in Redis for user ${userId} with expiry ${expirySeconds}s`);
    } catch (err) {
      logger.error(`Error storing token in Redis: ${err.message}`);
      // Fallback to in-memory storage
      TOKENS[userId] = tokenData;
    }
  } else {
    // Fallback to in-memory storage
    TOKENS[userId] = tokenData;
    logger.info(`Token stored in memory for user ${userId}`);
  }
}

/**
 * Retrieve user token from Redis or memory
 * @param {number} userId - Telegram user ID
 * @returns {Promise<Object|null>} Token data if available, null otherwise
 */
async function getUserToken(userId) {
  if (redisClient) {
    try {
      // Retrieve from Redis
      const tokenJson = await redisClient.get(`token:${userId}`);
      
      if (!tokenJson) {
        return null;
      }
      
      try {
        // Parse JSON string back to dictionary
        const tokenData = JSON.parse(tokenJson);
        
        // Check if token is expired
        if (tokenData.expiresAt && new Date(tokenData.expiresAt) < new Date()) {
          logger.info(`Token for user ${userId} has expired`);
          
          // Try to refresh the token
          if (tokenData.refreshToken) {
            try {
              const newTokenData = await refreshToken(userId, tokenData.refreshToken);
              return newTokenData;
            } catch (err) {
              logger.error(`Failed to refresh expired token: ${err.message}`);
              // Clear expired token
              await clearUserToken(userId);
              return null;
            }
          } else {
            // Clear expired token
            await clearUserToken(userId);
            return null;
          }
        }
        
        return tokenData;
      } catch (e) {
        // Handle corrupt data
        logger.warn(`Corrupt token data in Redis for user ${userId}: ${e.message}`);
        await redisClient.del(`token:${userId}`);
        return null;
      }
    } catch (err) {
      logger.error(`Error retrieving token from Redis: ${err.message}`);
      // Fallback to in-memory storage
      return TOKENS[userId];
    }
  } else {
    // Fallback to in-memory storage
    const tokenData = TOKENS[userId];
    
    // Check if token is expired
    if (tokenData && tokenData.expiresAt && new Date(tokenData.expiresAt) < new Date()) {
      logger.info(`Token for user ${userId} has expired`);
      
      // Try to refresh the token
      if (tokenData.refreshToken) {
        try {
          const newTokenData = await refreshToken(userId, tokenData.refreshToken);
          return newTokenData;
        } catch (err) {
          logger.error(`Failed to refresh expired token: ${err.message}`);
          // Clear expired token
          clearUserToken(userId);
          return null;
        }
      } else {
        // Clear expired token
        clearUserToken(userId);
        return null;
      }
    }
    
    return tokenData;
  }
}

/**
 * Clear user token from Redis or memory
 * @param {number} userId - Telegram user ID
 */
async function clearUserToken(userId) {
  if (redisClient) {
    try {
      // Delete from Redis
      await redisClient.del(`token:${userId}`);
      logger.info(`Token cleared from Redis for user ${userId}`);
    } catch (err) {
      logger.error(`Error clearing token from Redis: ${err.message}`);
      // Fallback to in-memory clear
      if (userId in TOKENS) {
        delete TOKENS[userId];
      }
    }
  } else {
    // Fallback to in-memory storage
    if (userId in TOKENS) {
      delete TOKENS[userId];
      logger.info(`Token cleared from memory for user ${userId}`);
    }
  }
}

/**
 * Store user's organization ID in Redis or memory
 * @param {number} userId - Telegram user ID
 * @param {string} organizationId - Copperx organization ID
 */
async function storeOrganizationId(userId, organizationId) {
  if (redisClient) {
    try {
      // Store in Redis with same expiration as token
      const tokenTtl = await redisClient.ttl(`token:${userId}`);
      const expiry = tokenTtl > 0 ? tokenTtl : TOKEN_EXPIRY_SECONDS;
      
      await redisClient.setex(`org:${userId}`, expiry, organizationId);
      logger.info(`Organization ID stored in Redis for user ${userId} with expiry ${expiry}s`);
    } catch (err) {
      logger.error(`Error storing organization ID in Redis: ${err.message}`);
      // Fallback to in-memory storage
      ORGANIZATION_IDS[userId] = organizationId;
    }
  } else {
    // Store in memory
    ORGANIZATION_IDS[userId] = organizationId;
    logger.info(`Organization ID stored in memory for user ${userId}`);
  }
}

/**
 * Get user's organization ID from Redis or memory
 * @param {number} userId - Telegram user ID
 * @returns {Promise<string|null>} Organization ID if available, null otherwise
 */
async function getOrganizationId(userId) {
  if (redisClient) {
    try {
      // Get from Redis
      const orgId = await redisClient.get(`org:${userId}`);
      return orgId;
    } catch (err) {
      logger.warn(`Error getting organization ID from Redis: ${err.message}`);
      // Fallback to in-memory storage
      return ORGANIZATION_IDS[userId];
    }
  } else {
    // Get from memory
    return ORGANIZATION_IDS[userId];
  }
}

/**
 * Clear user's organization ID from Redis or memory
 * @param {number} userId - Telegram user ID
 */
async function clearOrganizationId(userId) {
  if (redisClient) {
    try {
      // Delete from Redis
      await redisClient.del(`org:${userId}`);
      logger.info(`Organization ID cleared from Redis for user ${userId}`);
    } catch (err) {
      logger.error(`Error clearing organization ID from Redis: ${err.message}`);
      // Fallback to in-memory clear
      if (userId in ORGANIZATION_IDS) {
        delete ORGANIZATION_IDS[userId];
      }
    }
  } else {
    // Delete from memory
    if (userId in ORGANIZATION_IDS) {
      delete ORGANIZATION_IDS[userId];
      logger.info(`Organization ID cleared from memory for user ${userId}`);
    }
  }
}

/**
 * Refresh an expired access token
 * @param {number} userId - Telegram user ID
 * @param {string} refreshToken - Refresh token
 * @returns {Promise<Object|null>} New token data if refresh successful, null otherwise
 */
async function refreshToken(userId, refreshToken) {
  if (!refreshToken) {
    logger.warn(`No refresh token available for user ${userId}`);
    return null;
  }
  
  try {
    logger.info(`Attempting to refresh token for user ${userId}`);
    
    const response = await axios.post(
      `${COPPERX_API_BASE_URL}/api/auth/refresh`,
      { refreshToken },
      { headers: { 'Content-Type': 'application/json' } }
    );
    
    if (response.status === 200 && response.data.accessToken) {
      logger.info(`Successfully refreshed token for user ${userId}`);
      
      // Store the new token
      const newTokenData = response.data;
      await storeUserToken(userId, newTokenData);
      
      return newTokenData;
    } else {
      logger.warn(`Failed to refresh token: Invalid response format`);
      return null;
    }
  } catch (error) {
    logger.error(`Token refresh failed: ${error.message}`);
    
    // If the refresh token is invalid or expired, clear user data
    if (error.response && error.response.status === 401) {
      logger.info(`Refresh token invalid or expired for user ${userId}. Clearing user data.`);
      await clearUserToken(userId);
      await clearOrganizationId(userId);
    }
    
    return null;
  }
}

/**
 * Mask sensitive data in objects for logging
 * @param {any} data - Data to mask
 * @returns {any} Masked data
 */
function maskSensitiveData(data) {
  if (typeof data === 'object' && data !== null) {
    if (Array.isArray(data)) {
      return data.map(item => maskSensitiveData(item));
    } else {
      const maskedData = {};
      for (const [key, value] of Object.entries(data)) {
        // Mask sensitive fields
        if (['password', 'token', 'accesstoken', 'refreshtoken', 'secret', 'key', 'otp', 'code'].includes(key.toLowerCase())) {
          maskedData[key] = '[REDACTED]';
        } else if (typeof value === 'object' && value !== null) {
          maskedData[key] = maskSensitiveData(value);
        } else {
          maskedData[key] = value;
        }
      }
      return maskedData;
    }
  } else {
    return data;
  }
}

module.exports = {
  makeApiRequest,
  storeUserToken,
  getUserToken,
  clearUserToken,
  storeOrganizationId,
  getOrganizationId,
  clearOrganizationId,
  refreshToken,
  maskSensitiveData,
  checkRateLimit
};