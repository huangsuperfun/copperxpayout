const { Markup } = require('telegraf');
const logger = require('../../utils/logger');
const { getUserToken } = require('../../dependencies');
const { getKycStatus, formatKycStatus } = require('../../services/kycService');

/**
 * Handle the /kyc command to show KYC verification status
 * @param {Object} ctx - Telegraf context
 */
async function kycCommand(ctx) {
  const userId = ctx.from.id;
  
  // Check if user is logged in
  const token = await getUserToken(userId);
  if (!token) {
    await ctx.reply(
      'You need to log in first to check your KYC status.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          Markup.button.callback('Login', 'login')
        ])
      }
    );
    return;
  }
  
  // Show loading message
  const loadingMessage = await ctx.reply(
    'Loading your KYC verification status...',
    { parse_mode: 'Markdown' }
  );
  
  try {
    // Get KYC status
    const kycData = await getKycStatus(userId);
    
    if (!kycData || !kycData.data || !kycData.data.length) {
      // No KYC data found
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMessage.message_id,
        null,
        "You haven't started KYC verification yet.",
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            Markup.button.callback('Start KYC Verification', 'start_kyc')
          ])
        }
      );
      return;
    }
    
    // Get the latest KYC record
    const kycRecord = kycData.data[0];
    
    // Format the KYC status
    const formattedStatus = formatKycStatus(kycRecord);
    
    // Create keyboard based on status
    const status = kycRecord.status?.toLowerCase() || 'unknown';
    const keyboard = [];
    
    // Get verification URL if available
    const kycUrl = kycRecord.kycDetail?.kycUrl || 'https://app.copperx.io/kycs';
    
    // Add buttons based on status
    if (status === 'verified' || status === 'approved') {
      keyboard.push([Markup.button.url('View on Copperx', 'https://payout.copperx.io/app/profile')]);
    } else if (status === 'rejected') {
      keyboard.push([
        Markup.button.url('Contact Support', 'https://support.copperx.io'),
        Markup.button.url('Try Again', kycUrl)
      ]);
    } else if (status === 'expired') {
      keyboard.push([Markup.button.url('Complete Verification Again', kycUrl)]);
    } else {
      // For pending states
      keyboard.push([
        Markup.button.url('Complete Verification', kycUrl),
        Markup.button.callback('Check Status', 'check_kyc_status')
      ]);
    }
    
    // Send the formatted status
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMessage.message_id,
      null,
      formattedStatus,
      {
        parse_mode: 'Markdown',
        ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {})
      }
    );
  } catch (error) {
    logger.error(`Error getting KYC status: ${error.message}`);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMessage.message_id,
      null,
      `❌ Error checking KYC status: ${error.message}\n\nPlease try again or contact support.`,
      { parse_mode: 'Markdown' }
    );
  }
}

module.exports = {
  kycCommand
};