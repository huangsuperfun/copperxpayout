# Installation and Setup Guide for Copperx Telegram Bot

This guide will walk you through the process of setting up and running the Copperx Telegram Bot from scratch.

## Prerequisites

Before you begin, make sure you have the following installed:

1. **Node.js** (version 16.0.0 or higher)
2. **npm** (comes with Node.js)
3. **Git** (for cloning the repository)

## Step 1: Clone the Repository

```bash
git clone https://github.com/your-username/copperx-telegram-bot.git
cd copperx-telegram-bot
```

If you don't have the repository, create a new directory and set up the files manually:

```bash
mkdir copperx-telegram-bot
cd copperx-telegram-bot
# Create the directory structure as outlined in the project
mkdir -p src/bot/commands src/bot/keyboards src/models src/services src/utils
```

## Step 2: Create Configuration Files

1. Create the package.json file:

```bash
npm init -y
```

2. Update the package.json content to match the provided structure.

3. Create a `.env` file in the root directory:

```bash
touch .env
```

4. Add your configuration to the `.env` file:

```
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_from_botfather
COPPERX_API_BASE_URL=https://income-api.copperx.io
PUSHER_KEY=e089376087cac1a62785
PUSHER_CLUSTER=ap1
DEBUG=true
LOG_LEVEL=info
```

Replace `your_telegram_bot_token_from_botfather` with the token you received from BotFather when creating your Telegram bot.

## Step 3: Install Dependencies

Install all required dependencies:

```bash
npm install telegraf dotenv axios ioredis pusher-js winston express uuid
```

For development, also install nodemon:

```bash
npm install --save-dev nodemon
```

## Step 4: Set Up the Bot with BotFather

If you haven't already created a bot on Telegram:

1. Open Telegram and search for `@BotFather`
2. Send the command `/newbot`
3. Follow the prompts to create a new bot
4. Copy the API token that BotFather gives you
5. Paste the token in your `.env` file as `TELEGRAM_BOT_TOKEN`

## Step 5: Run the Bot in Development Mode

Start the bot in development mode with automatic reloading:

```bash
npm run dev
```

If the script isn't defined in your package.json, run:

```bash
npx nodemon src/main.js
```

## Step 6: Test the Bot

1. Open Telegram
2. Search for your bot using the handle you created with BotFather
3. Start a conversation by sending `/start`
4. Test the main functionality:
   - `/login` - Authenticate with your Copperx account
   - `/balance` - Check your wallet balances
   - `/send` - Send funds to an email or wallet address
   - `/deposit` - Get deposit addresses
   - `/withdrawal` - Withdraw funds to a bank account
   - `/transactions` - View transaction history
   - `/myprofile` - View your profile
   - `/help` - Get help information

## Step 7: Deploy to Production (Optional)

For a production deployment:

1. Update the `.env` file with your production settings:

```
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
COPPERX_API_BASE_URL=https://income-api.copperx.io
PUSHER_KEY=e089376087cac1a62785
PUSHER_CLUSTER=ap1
DEBUG=false
WEBHOOK_URL=https://your-server-domain.com
WEBHOOK_SECRET_PATH=/webhook
PORT=3000
```

2. Set up a server with HTTPS (required for webhooks)

3. Deploy the code to your server

4. Install dependencies on the server:

```bash
npm install --production
```

5. Start the bot in production mode:

```bash
npm start
```

Or use a process manager like PM2:

```bash
npm install -g pm2
pm2 start src/main.js --name copperx-bot
```

## Troubleshooting

If you encounter issues:

1. **Bot not responding**: Check that your `TELEGRAM_BOT_TOKEN` is correct
2. **API connection errors**: Verify the `COPPERX_API_BASE_URL` and your network connection
3. **Webhook issues**: Ensure your server has a valid HTTPS certificate and is publicly accessible
4. **Permission errors**: Check file permissions and Node.js installation
5. **Logs**: Set `LOG_LEVEL=debug` in your `.env` file for more detailed logs

Review the logs for error messages. They are typically found in the console output or in `error.log` and `combined.log` files.

## Additional Information

- The bot uses polling in development mode and can switch to webhook mode in production
- Debug mode (`DEBUG=true`) enables additional commands like `/test_deposit`
- Redis is optional for token storage; without it, the bot uses in-memory storage