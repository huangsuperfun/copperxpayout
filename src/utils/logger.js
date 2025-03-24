const winston = require('winston');
const { format, transports } = winston;

// Define log levels and colors
const customLevels = {
  levels: {
    error: 0, 
    warn: 1, 
    info: 2, 
    debug: 3
  },
  colors: {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    debug: 'blue'
  }
};

// Apply colors to winston
winston.addColors(customLevels.colors);

// Create custom format
const customFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.printf(info => {
    return `${info.timestamp} - ${info.level.toUpperCase()}: ${info.message}`;
  })
);

// Create logger instance
const logger = winston.createLogger({
  levels: customLevels.levels,
  format: customFormat,
  transports: [
    // Console transport for development
    new transports.Console({
      level: process.env.LOG_LEVEL || 'info',
      format: format.combine(
        format.colorize(),
        customFormat
      )
    }),
    // File transport for production
    new transports.File({ 
      filename: 'error.log', 
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    new transports.File({ 
      filename: 'combined.log',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    })
  ],
  exceptionHandlers: [
    new transports.File({ filename: 'exceptions.log' })
  ]
});

// Add request logging method
logger.logRequest = (req, res, next) => {
  const start = Date.now();
  
  // Once the request is finished
  res.on('finish', () => {
    const duration = Date.now() - start;
    const message = `${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`;
    
    // Log based on status code
    if (res.statusCode >= 500) {
      logger.error(message);
    } else if (res.statusCode >= 400) {
      logger.warn(message);
    } else {
      logger.info(message);
    }
  });
  
  next();
};

// Mask sensitive data in logs
logger.maskSensitiveData = (obj) => {
  if (!obj) return obj;
  
  const sensitiveFields = ['password', 'token', 'accessToken', 'refreshToken', 'secret', 'key', 'authorization'];
  const maskedObj = { ...obj };
  
  for (const field of sensitiveFields) {
    if (field in maskedObj) {
      if (typeof maskedObj[field] === 'string') {
        const value = maskedObj[field];
        maskedObj[field] = value.length > 8 ? 
          `${value.substring(0, 4)}...${value.substring(value.length - 4)}` : 
          '[REDACTED]';
      } else {
        maskedObj[field] = '[REDACTED]';
      }
    }
  }
  
  return maskedObj;
};

module.exports = logger;