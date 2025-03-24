const { Markup } = require('telegraf');
const { Scenes } = require('telegraf');
const logger = require('../../utils/logger');
const { getUserToken } = require('../../dependencies');
const { 
  getPayees, 
  addPayee, 
  formatPayeeList,
  deletePayee,
  updatePayee
} = require('../../services/payeeService');
const { EMAIL_REGEX } = require('../../config');

/**
 * Handle the /payee command to show list of payees and manage them
 * @param {Object} ctx - Telegraf context
 */
async function payeeCommand(ctx) {
  const userId = ctx.from.id;
  
  // Check if user is logged in
  const token = await getUserToken(userId);
  if (!token) {
    await ctx.reply(
      'You need to log in first to view and manage your payees.',
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
    'Loading your payees...',
    { parse_mode: 'Markdown' }
  );
  
  try {
    // Get payees from the service
    const payees = await getPayees(userId);
    
    // Format payees list
    const payeeList = formatPayeeList(payees);
    
    // Create buttons
    const keyboard = [
      [Markup.button.callback('➕ Add New Payee', 'add_payee')],
    ];
    
    // Add button to delete payees if they exist
    if (payees && payees.length > 0) {
      keyboard.push([
        Markup.button.callback('🗑️ Delete Payee', 'delete_payee')
      ]);
    }
    
    // Send the formatted payee list
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMessage.message_id,
      null,
      payeeList,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      }
    );
  } catch (error) {
    logger.error(`Error fetching payees: ${error.message}`);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMessage.message_id,
      null,
      `❌ Error: ${error.message}\n\nPlease try again or contact support.`,
      { parse_mode: 'Markdown' }
    );
  }
}

/**
 * Handle payee-related callbacks
 * @param {Object} ctx - Telegraf context
 */
async function payeeCallback(ctx) {
  await ctx.answerCbQuery();
  
  const userId = ctx.from.id;
  const action = ctx.callbackQuery.data;
  
  // Check if user is logged in
  const token = await getUserToken(userId);
  if (!token) {
    await ctx.editMessageText(
      'Your session has expired. Please log in again with /login.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          Markup.button.callback('Login', 'login')
        ])
      }
    );
    return;
  }
  
  if (action === 'add_payee') {
    // Enter the scene for adding a new payee
    ctx.scene.enter('add-payee-scene');
  } else if (action === 'delete_payee') {
    // Show list of payees to delete
    await showPayeeSelectionForDelete(ctx, userId);
  } else if (action.startsWith('delete_payee_confirm_')) {
    // Handle deleting a specific payee
    const payeeId = action.replace('delete_payee_confirm_', '');
    await handlePayeeDeletion(ctx, userId, payeeId);
  } else if (action === 'back_to_payee_list') {
    // Go back to main payee list
    await showPayeeList(ctx, userId);
  } else if (action.startsWith('delete_payee_')) {
    // Show confirmation for deleting a payee
    const payeeId = action.replace('delete_payee_', '');
    await showDeleteConfirmation(ctx, userId, payeeId);
  }
}

/**
 * Show the list of payees with select buttons for deletion
 * @param {Object} ctx - Telegraf context
 * @param {number} userId - Telegram user ID
 */
async function showPayeeSelectionForDelete(ctx, userId) {
  try {
    // Show loading state
    await ctx.editMessageText(
      'Loading payees...',
      { parse_mode: 'Markdown' }
    );
    
    // Get payees
    const payees = await getPayees(userId);
    
    if (!payees || payees.length === 0) {
      await ctx.editMessageText(
        "You don't have any payees to delete.",
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('« Back', 'back_to_payee_list')]
          ])
        }
      );
      return;
    }
    
    // Create selection buttons
    const keyboard = payees.map(payee => {
      const displayName = payee.nickName ? 
        `${payee.nickName} - ${payee.email}` : 
        payee.email;
      
      return [Markup.button.callback(displayName, `delete_payee_${payee.id}`)];
    });
    
    // Add back button
    keyboard.push([Markup.button.callback('« Back', 'back_to_payee_list')]);
    
    await ctx.editMessageText(
      '*Select a payee to delete:*',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      }
    );
  } catch (error) {
    logger.error(`Error showing payee selection for delete: ${error.message}`);
    await ctx.editMessageText(
      `❌ Error: ${error.message}\n\nPlease try again or contact support.`,
      { 
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back', 'back_to_payee_list')]
        ])
      }
    );
  }
}

/**
 * Show confirmation dialog for deleting a payee
 * @param {Object} ctx - Telegraf context
 * @param {number} userId - Telegram user ID
 * @param {string} payeeId - ID of the payee to delete
 */
async function showDeleteConfirmation(ctx, userId, payeeId) {
  try {
    // Get payees to find the one to delete
    const payees = await getPayees(userId);
    const payeeToDelete = payees.find(p => p.id === payeeId);
    
    if (!payeeToDelete) {
      await ctx.editMessageText(
        "Payee not found. It may have been deleted already.",
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('« Back to Payee List', 'back_to_payee_list')]
          ])
        }
      );
      return;
    }
    
    // Show confirmation dialog
    const displayName = payeeToDelete.nickName ? 
      `${payeeToDelete.nickName} - ${payeeToDelete.email}` : 
      payeeToDelete.email;
    
    await ctx.editMessageText(
      `Are you sure you want to delete this payee?\n\n*${displayName}*`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('Yes, Delete', `delete_payee_confirm_${payeeId}`),
            Markup.button.callback('No, Cancel', 'back_to_payee_list')
          ]
        ])
      }
    );
  } catch (error) {
    logger.error(`Error showing delete confirmation: ${error.message}`);
    await ctx.editMessageText(
      `❌ Error: ${error.message}\n\nPlease try again or contact support.`,
      { 
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back', 'back_to_payee_list')]
        ])
      }
    );
  }
}

/**
 * Handle the deletion of a payee
 * @param {Object} ctx - Telegraf context
 * @param {number} userId - Telegram user ID
 * @param {string} payeeId - ID of the payee to delete
 */
async function handlePayeeDeletion(ctx, userId, payeeId) {
  try {
    // Show loading state
    await ctx.editMessageText(
      'Deleting payee...',
      { parse_mode: 'Markdown' }
    );
    
    // Delete the payee
    const success = await deletePayee(userId, payeeId);
    
    if (success) {
      // Show success message briefly
      await ctx.editMessageText(
        '✅ Payee deleted successfully!',
        { parse_mode: 'Markdown' }
      );
      
      // Then show updated payee list
      setTimeout(async () => {
        await showPayeeList(ctx, userId);
      }, 1500);
    } else {
      throw new Error('Failed to delete payee');
    }
  } catch (error) {
    logger.error(`Error deleting payee: ${error.message}`);
    await ctx.editMessageText(
      `❌ Error: ${error.message}\n\nPlease try again or contact support.`,
      { 
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back', 'back_to_payee_list')]
        ])
      }
    );
  }
}

/**
 * Show the main payee list
 * @param {Object} ctx - Telegraf context
 * @param {number} userId - Telegram user ID
 */
async function showPayeeList(ctx, userId) {
  try {
    // Show loading state
    await ctx.editMessageText(
      'Loading payees...',
      { parse_mode: 'Markdown' }
    );
    
    // Get payees
    const payees = await getPayees(userId);
    
    // Format payees list
    const payeeList = formatPayeeList(payees);
    
    // Create buttons
    const keyboard = [
      [Markup.button.callback('➕ Add New Payee', 'add_payee')],
    ];
    
    // Add button to delete payees if they exist
    if (payees && payees.length > 0) {
      keyboard.push([
        Markup.button.callback('🗑️ Delete Payee', 'delete_payee')
      ]);
    }
    
    await ctx.editMessageText(
      payeeList,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      }
    );
  } catch (error) {
    logger.error(`Error showing payee list: ${error.message}`);
    await ctx.editMessageText(
      `❌ Error: ${error.message}\n\nPlease try again or contact support.`,
      { parse_mode: 'Markdown' }
    );
  }
}

// Create scene for adding a new payee
const addPayeeScene = new Scenes.WizardScene(
  'add-payee-scene',
  // Step 1: Ask for email
  async (ctx) => {
    // Store the message ID for later updates
    const message = await ctx.reply('Please enter the email address for the new payee:');
    ctx.scene.session.messageId = message.message_id;
    return ctx.wizard.next();
  },
  // Step 2: Validate email and ask for nickname
  async (ctx) => {
    // Check if user sent a command instead of email
    if (ctx.message.text.startsWith('/')) {
      await ctx.reply('Adding payee cancelled.');
      return ctx.scene.leave();
    }
    
    const email = ctx.message.text.trim();
    
    // Try to delete the user's message to keep the chat clean
    try {
      await ctx.deleteMessage(ctx.message.message_id);
    } catch (error) {
      // Ignore if we can't delete
      logger.warn(`Could not delete message: ${error.message}`);
    }
    
    // Validate email
    if (!EMAIL_REGEX.test(email)) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.scene.session.messageId,
        null,
        'Invalid email format. Please enter a valid email address:'
      );
      return; // Stay on this step
    }
    
    // Store email in session
    ctx.wizard.state.email = email;
    
    // Update prompt to ask for nickname
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      ctx.scene.session.messageId,
      null,
      `Email: ${email}\n\nPlease enter a nickname for this payee (or send /skip to use the email as nickname):`
    );
    
    return ctx.wizard.next();
  },
  // Step 3: Save the payee
  async (ctx) => {
    const userId = ctx.from.id;
    const email = ctx.wizard.state.email;
    
    // Try to delete the user's message to keep the chat clean
    try {
      await ctx.deleteMessage(ctx.message.message_id);
    } catch (error) {
      // Ignore if we can't delete
      logger.warn(`Could not delete message: ${error.message}`);
    }
    
    // Check if user wants to skip setting a nickname
    let nickname;
    if (ctx.message.text === '/skip') {
      nickname = email.split('@')[0]; // Use part before @ as default nickname
    } else {
      nickname = ctx.message.text.trim();
    }
    
    // Update the message to show loading
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      ctx.scene.session.messageId,
      null,
      'Adding new payee...'
    );
    
    try {
      // Add the payee
      const newPayee = await addPayee(userId, email, nickname);
      
      // Show success message in the same message
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.scene.session.messageId,
        null,
        `✅ Payee added successfully!\n\nEmail: ${email}\nNickname: ${nickname}`,
        { parse_mode: 'Markdown' }
      );
      
      // Show updated payee list after a short delay
      setTimeout(async () => {
        await payeeCommand(ctx);
      }, 1000);
      
    } catch (error) {
      logger.error(`Error adding payee: ${error.message}`);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.scene.session.messageId,
        null,
        `❌ Error adding payee: ${error.message}\n\nPlease try again.`,
        { parse_mode: 'Markdown' }
      );
    }
    
    return ctx.scene.leave();
  }
);

// Add scene middleware to handle /cancel command
addPayeeScene.command('cancel', async (ctx) => {
  // If we have a stored message ID, update that message
  if (ctx.scene.session.messageId) {
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.scene.session.messageId,
        null,
        'Adding payee cancelled.'
      );
    } catch (error) {
      // If we can't update the message (e.g., already edited), send a new one
      await ctx.reply('Adding payee cancelled.');
    }
  } else {
    await ctx.reply('Adding payee cancelled.');
  }
  return ctx.scene.leave();
});

module.exports = {
  payeeCommand,
  payeeCallback,
  addPayeeScene
};