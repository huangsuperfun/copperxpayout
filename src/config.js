// Load environment variables from .env file
require('dotenv').config();

// Telegram Bot Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN must be set in environment variables');
}

// Copperx API Configuration
const COPPERX_API_BASE_URL = process.env.COPPERX_API_BASE_URL || 'https://income-api.copperx.io';

// Pusher Configuration for notifications
const PUSHER_APP_KEY = process.env.PUSHER_KEY || 'e089376087cac1a62785';
const PUSHER_CLUSTER = process.env.PUSHER_CLUSTER || 'ap1';

// Redis Configuration (for token storage)
const REDIS_URL = process.env.REDIS_URL;

// Database Configuration (SQLite for minimal local storage)
const DB_URL = process.env.DB_URL || 'sqlite:./copperx_bot.db';

// In-memory token storage if Redis is not used
// Maps Telegram user_id to auth tokens
const TOKENS = {};

// In-memory organization ID storage if Redis is not used
// Maps Telegram user_id to organization IDs
const ORGANIZATION_IDS = {};

// Webhook settings for production deployment
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET_PATH = process.env.WEBHOOK_SECRET_PATH || '/webhook';

// Development mode flag
const DEBUG = ['true', '1', 't'].includes(process.env.DEBUG?.toLowerCase() || 'false');

// Network name mapping
const NETWORK_NAMES = {
  '137': 'Polygon',
  '42161': 'Arbitrum One',
  '8453': 'Base',
  '23434': 'Starknet'
};

// Email validation regex
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// Common networks
const NETWORKS = ['SOLANA', 'ETHEREUM', 'POLYGON', 'ARBITRUM'];

// Status mapping for user-friendly display
const STATUS_MAPPING = {
  'initiated': 'Initiated',
  'inprogress': 'In Progress',
  'on_hold': 'On Hold',
  'provider_manual_review': 'Under Manual Review',
  'approved': 'Approved',
  'rejected': 'Rejected',
  'expired': 'Expired'
};

module.exports = {
  TELEGRAM_BOT_TOKEN,
  COPPERX_API_BASE_URL,
  PUSHER_APP_KEY,
  PUSHER_CLUSTER,
  REDIS_URL,
  DB_URL,
  TOKENS,
  ORGANIZATION_IDS,
  WEBHOOK_URL,
  WEBHOOK_SECRET_PATH,
  DEBUG,
  NETWORK_NAMES,
  EMAIL_REGEX,
  NETWORKS,
  STATUS_MAPPING
};