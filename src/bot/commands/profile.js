const { Markup } = require('telegraf');
const logger = require('../../utils/logger');
const { getUserToken } = require('../../dependencies');
const { getUserProfile, formatUserProfile } = require('../../services/profileService');
const { getKycStatus, formatKycStatus } = require('../../services/kycService');

/**
 * Handle the /myprofile command
 * @param {Object} ctx - Telegraf context
 */
async function profileCommand(ctx) {
  const userId = ctx.from.id;
  
  // Send initial message that we'll update
  const message = await ctx.reply(
    'Fetching your profile information...',
    { parse_mode: 'Markdown' }
  );
  
  // Check if user is logged in
  const token = await getUserToken(userId);
  
  if (!token) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      message.message_id,
      null,
      'You need to log in first to view your profile.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          Markup.button.callback('Login', 'login')
        ])
      }
    );
    return;
  }
  
  try {
    // Get user profile using profileService
    const profile = await getUserProfile(userId);
    
    // Format the profile into a readable message
    const formattedProfile = formatUserProfile(profile);
    
    // Get KYC status using kycService
    const kycData = await getKycStatus(userId);
    
    let kycMessage = "";
    let kycStatus = "unknown";
    
    // Process KYC data if available
    if (kycData && kycData.data && kycData.data.length > 0) {
      const kycRecord = kycData.data[0];
      // Get KYC status
      const status = kycRecord.status?.toLowerCase() || 'unknown';
      
      // Add a brief KYC status line with emoji
      if (status === 'verified' || status === 'approved') {
        kycMessage = "\n\n✅ *KYC Status:* Approved";
      } else if (status === 'rejected') {
        kycMessage = "\n\n❌ *KYC Status:* Rejected";
      } else if (status === 'expired') {
        kycMessage = "\n\n⏰ *KYC Status:* Expired";
      } else {
        kycMessage = "\n\n⏳ *KYC Status:* Pending";
      }
    } else {
      kycMessage = "\n\n📝 *KYC Status:* Not started";
    }
    
    // Create buttons based on KYC status
    const buttons = [];
    
    // Always add View on Copperx button
    buttons.push([Markup.button.url('View on Copperx', 'https://payout.copperx.io/app/profile')]);
    
    // Add KYC button if not approved
    if (kycStatus !== 'verified' && kycStatus !== 'approved') {
      buttons.push([
        Markup.button.url('Complete KYC', 'https://app.copperx.io/kyc'),
        Markup.button.callback('KYC Details', 'view_kyc_details')
      ]);
    }
    
    // Update the message with the profile information and KYC status
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      message.message_id,
      null,
      formattedProfile + kycMessage,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons)
      }
    );
  } catch (error) {
    logger.error(`Error fetching profile: ${error.message}`);
    console.error(error);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      message.message_id,
      null,
      `❌ Error: ${error.message}\n\nPlease try again or contact support.`,
      { parse_mode: 'Markdown' }
    );
  }
}

/**
 * Handle the profile button callback
 * @param {Object} ctx - Telegraf context
 */
async function profileCallback(ctx) {
  await ctx.answerCbQuery();
  
  const userId = ctx.from.id;
  const action = ctx.callbackQuery.data;
  
  // Check if user is logged in
  const token = await getUserToken(userId);
  if (!token) {
    await ctx.editMessageText(
      'Your session has expired. Please log in again with /login.',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  if (action === 'view_profile') {
    try {
      // Show loading state
      await ctx.editMessageText(
        'Fetching your profile information...',
        { parse_mode: 'Markdown' }
      );
      
      // Get user profile
      const profile = await getUserProfile(userId);
      
      // Format the profile into a readable message
      const formattedProfile = formatUserProfile(profile);
      
      // Add button to view on website
      await ctx.editMessageText(
        formattedProfile,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            Markup.button.url('View on Website', 'https://payout.copperx.io/app/profile')
          ])
        }
      );
    } catch (error) {
      await ctx.editMessageText(
        `❌ Error: ${error.message}\n\nPlease try again or contact support.`,
        { parse_mode: 'Markdown' }
      );
    }
  } else if (action === 'view_kyc_details') {
    try {
      // Show loading state
      await ctx.editMessageText(
        'Fetching your KYC information...',
        { parse_mode: 'Markdown' }
      );
      
      // Get KYC status
      const kycData = await getKycStatus(userId);
      
      if (kycData && kycData.data && kycData.data.length > 0) {
        const kycRecord = kycData.data[0];
        const formattedKyc = formatKycStatus(kycRecord);
        
        // Get KYC verification URL if available
        const kycUrl = kycRecord.kycDetail?.kycUrl || '';
        
        // Create keyboard based on status
        const keyboard = [];
        
        if (kycUrl && kycRecord.status === 'inprogress') {
          keyboard.push([Markup.button.url('Complete Verification', kycUrl)]);
        }
        
        keyboard.push([Markup.button.callback('« Back to Profile', 'view_profile')]);
        
        // Show the KYC details
        await ctx.editMessageText(
          formattedKyc,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(keyboard)
          }
        );
      } else {
        // No KYC data found
        await ctx.editMessageText(
          "You haven't started KYC verification yet.",
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.url('Start KYC Verification', 'https://app.copperx.io/kyc')],
              [Markup.button.callback('« Back to Profile', 'view_profile')]
            ])
          }
        );
      }
    } catch (error) {
      await ctx.editMessageText(
        `❌ Error: ${error.message}\n\nPlease try again or contact support.`,
        { parse_mode: 'Markdown' }
      );
    }
  }
}

module.exports = {
  profileCommand,
  profileCallback
};