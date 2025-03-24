const { Scenes, Markup } = require('telegraf');
const logger = require('../../utils/logger');
const { getUserToken } = require('../../dependencies');
const { 
  requestEmailOtp, 
  verifyEmailOtp, 
  validateEmail 
} = require('../../services/authService');
const { getUserProfile, formatUserProfile } = require('../../services/profileService');
const { getKycStatus, formatKycStatus } = require('../../services/kycService');

// Scene states
const EMAIL = 'email';
const OTP = 'otp';

// Create a scene for login flow
const loginScene = new Scenes.WizardScene(
  'login-scene',
  // Step 1: Ask for email
  async (ctx) => {
    // Check if user is already logged in
    const userId = ctx.from.id;
    const token = await getUserToken(userId);
    
    if (token) {
      // User is already logged in, get their email
      try {
        // Get user profile to show their email
        const profile = await getUserProfile(userId);
        
        const email = profile.email || 'your account';
        
        await ctx.replyWithMarkdown(
          `You are already logged in as *${email}*.\n\n` +
          'If you want to log in with a different account, please /logout first.'
        );
        return ctx.scene.leave();
      } catch (error) {
        // If we can't get the profile but have a token, still inform the user
        await ctx.replyWithMarkdown(
          'You are already logged in. If you want to log in with a different account, please /logout first.'
        );
        return ctx.scene.leave();
      }
    }
    
    // Clear any existing user data
    ctx.scene.session.state = {};
    
    // Ask for email
    const message = await ctx.replyWithMarkdown(
      'Please enter your Copperx account email address:'
    );
    
    // Store the message for later updates
    ctx.scene.session.messageId = message.message_id;
    
    return ctx.wizard.next();
  },
  // Step 2: Handle email and request OTP
  async (ctx) => {
    // Try to delete user's message to keep the chat clean
    try {
      await ctx.deleteMessage();
    } catch (error) {
      // Ignore if we can't delete
    }
    
    // If this is a command (e.g., /cancel), end the scene
    if (ctx.message?.text?.startsWith('/')) {
      await ctx.replyWithMarkdown(
        'Login process cancelled. You can start again with /login.'
      );
      return ctx.scene.leave();
    }
    
    const email = ctx.message?.text?.trim();
    
    // Validate email format
    if (!email || !validateEmail(email)) {
      try {
        // Try to edit the original message
        if (ctx.scene.session.messageId) {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            ctx.scene.session.messageId,
            null,
            "That doesn't look like a valid email address. Please try again:",
            { parse_mode: 'Markdown' }
          );
        } else {
          const message = await ctx.replyWithMarkdown(
            "That doesn't look like a valid email address. Please try again:"
          );
          ctx.scene.session.messageId = message.message_id;
        }
      } catch (error) {
        // If we can't edit, send a new message
        const message = await ctx.replyWithMarkdown(
          "That doesn't look like a valid email address. Please try again:"
        );
        ctx.scene.session.messageId = message.message_id;
      }
      
      return; // Stay in this step
    }
    
    // Store email for later use
    ctx.scene.session.email = email;
    
    // Update message to show loading state
    try {
      if (ctx.scene.session.messageId) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.scene.session.messageId,
          null,
          `Requesting verification code for ${email}...`,
          { parse_mode: 'Markdown' }
        );
      } else {
        const message = await ctx.replyWithMarkdown(
          `Requesting verification code for ${email}...`
        );
        ctx.scene.session.messageId = message.message_id;
      }
    } catch (error) {
      // If we can't edit, send a new message
      const message = await ctx.replyWithMarkdown(
        `Requesting verification code for ${email}...`
      );
      ctx.scene.session.messageId = message.message_id;
    }
    
    try {
      // Request OTP and store session ID
      const sid = await requestEmailOtp(email);
      ctx.scene.session.sid = sid; // Store the session ID
      
      // Update message to prompt for OTP
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.scene.session.messageId,
        null,
        `A one-time code has been sent to ${email}.\n\n` +
        `Please enter the verification code:`,
        { parse_mode: 'Markdown' }
      );
      
      return ctx.wizard.next();
    } catch (error) {
      // Update message with error
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.scene.session.messageId,
        null,
        `❌ Error: ${error.message}\n\nPlease try again or contact support.`,
        { parse_mode: 'Markdown' }
      );
      
      return ctx.scene.leave();
    }
  },
  // Step 3: Handle OTP and verify
  async (ctx) => {
    const userId = ctx.from.id;
    
    // Try to delete user's message to keep the chat clean
    try {
      await ctx.deleteMessage();
    } catch (error) {
      // Ignore if we can't delete
    }
    
    // If this is a command (e.g., /cancel), end the scene
    if (ctx.message?.text?.startsWith('/')) {
      await ctx.replyWithMarkdown(
        'Login process cancelled. You can start again with /login.'
      );
      return ctx.scene.leave();
    }
    
    const otp = ctx.message?.text?.trim();
    const email = ctx.scene.session.email;
    const sid = ctx.scene.session.sid;
    
    if (!email || !sid) {
      try {
        if (ctx.scene.session.messageId) {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            ctx.scene.session.messageId,
            null,
            'Session expired. Please start again with /login.',
            { parse_mode: 'Markdown' }
          );
        } else {
          await ctx.replyWithMarkdown(
            'Session expired. Please start again with /login.'
          );
        }
      } catch (error) {
        await ctx.replyWithMarkdown(
          'Session expired. Please start again with /login.'
        );
      }
      
      return ctx.scene.leave();
    }
    
    // Update message to show verification in progress
    try {
      if (ctx.scene.session.messageId) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.scene.session.messageId,
          null,
          'Verifying your code...',
          { parse_mode: 'Markdown' }
        );
      } else {
        const loadingMessage = await ctx.replyWithMarkdown(
          'Verifying your code...'
        );
        ctx.scene.session.messageId = loadingMessage.message_id;
      }
    } catch (error) {
      // If we can't edit, send a new message
      const loadingMessage = await ctx.replyWithMarkdown(
        'Verifying your code...'
      );
      ctx.scene.session.messageId = loadingMessage.message_id;
    }
    
    try {
      // Verify OTP with the auth service
      await verifyEmailOtp(email, otp, userId, sid);
      
      // Update message to show fetching profile and KYC status
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.scene.session.messageId,
        null,
        '✅ Authentication successful!\n\n' +
        'Loading your profile and KYC status...',
        { parse_mode: 'Markdown' }
      );
      
      // Use profileService to get user details
      try {
        // Get user profile
        const profile = await getUserProfile(userId);
        
        // Format welcome name
        const walletAddress = profile.walletAddress || '';
        const accountType = profile.walletAccountType ? `${profile.walletAccountType.charAt(0).toUpperCase()}${profile.walletAccountType.slice(1)}` : '';
        const userType = profile.type ? `${profile.type.charAt(0).toUpperCase()}${profile.type.slice(1)}` : '';
        
        // Check KYC status
        const kycData = await getKycStatus(userId);
        let kycStatus = '';
        let kycButtons = [];
        
        if (kycData && kycData.data && kycData.data.length > 0) {
          const kycRecord = kycData.data[0];
          const status = kycRecord.status?.toLowerCase() || 'unknown';
          
          // Set KYC status message based on status categories
          if (status === 'verified' || status === 'approved') {
            kycStatus = '✅ *KYC Status:* Approved\n✨ You have full access to all features.';
          } else if (status === 'rejected') {
            kycStatus = '❌ *KYC Status:* Rejected\n❗️ Please contact support for assistance.';
            kycButtons = [[
              Markup.button.url('Contact Support', 'https://support.copperx.io'),
              Markup.button.url('Try Again', 'https://app.copperx.io/kyc')
            ]];
          } else if (status === 'expired') {
            kycStatus = '⏰ *KYC Status:* Expired\n⚠️ Please complete the verification process again.';
            kycButtons = [[Markup.button.url('Complete Verification', 'https://app.copperx.io/kyc')]];
          } else {
            kycStatus = '⏳ *KYC Status:* Pending\n📝 We will notify you once the review is complete.';
            kycButtons = [[
              Markup.button.url('Complete Verification', 'https://app.copperx.io/kyc'),
              Markup.button.callback('Check Status', 'check_kyc_status')
            ]];
          }
        } else {
          kycStatus = '📝 *KYC Status:* Not started';
          kycButtons = [[Markup.button.url('Start KYC Verification', 'https://app.copperx.io/kyc')]];
        }
        
        // Create welcome message with detailed information
        const welcomeMessage = 
          `✅ *Login Successful!*\n\n` +
          `Welcome to Copperx! Here's your account information:\n\n` +
          `*Account Details:*\n` +
          `• Email: \`${email}\`\n` +
          (accountType ? `• Account Type: ${accountType}\n` : '') +
          (userType ? `• User Type: ${userType}\n` : '') +
          `• Wallet Address: \`${walletAddress}\`\n\n` +
          `${kycStatus}\n\n` +
          `Use /help to see available commands.`;
        
        // Create buttons array
        const buttons = [
          [Markup.button.url('View Profile', 'https://payout.copperx.io/app/profile')]
        ];
        
        // Add KYC buttons if any
        if (kycButtons.length > 0) {
          buttons.push(...kycButtons);
        }
        
        // Update message with new format
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.scene.session.messageId,
          null,
          welcomeMessage,
          { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons)
          }
        );
        
        // Get user token again to ensure we have it
        const token = await getUserToken(userId);
        if (!token) {
          throw new Error('Failed to retrieve user authentication token');
        }
        
        // Connect to Pusher for real-time notifications
        try {
          // Use dynamic require to avoid circular dependency
          const telegramBot = require('../telegramBot');
          await telegramBot.connectToPusher(userId, token.accessToken, profile.organizationId);
          logger.info(`Connected to Pusher for user ${userId} with organization ${profile.organizationId}`);
        } catch (error) {
          // Log but continue if Pusher connection fails
          logger.error(`Error connecting to Pusher: ${error.message}`);
        }
        
        return ctx.scene.leave();
      } catch (error) {
        logger.error(`Error completing login: ${error.message}`);
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.scene.session.messageId,
          null,
          `❌ Error: ${error.message}\n\nPlease try again or contact support.`,
          { parse_mode: 'Markdown' }
        );
        return ctx.scene.leave();
      }
    } catch (error) {
      // Login failed
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.scene.session.messageId,
        null,
        `❌ Login failed: ${error.message}\n\nPlease try again.`,
        { parse_mode: 'Markdown' }
      );
      
      return;
    }
  }
);

// Add scene middleware to handle /cancel command
loginScene.command('cancel', async (ctx) => {
  await ctx.replyWithMarkdown(
    'Login process cancelled. You can start again with /login.'
  );
  return ctx.scene.leave();
});

module.exports = {
  loginScene
};