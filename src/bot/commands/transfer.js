///////////////////////////////////////////////////////
// transfer.js
///////////////////////////////////////////////////////

const { Scenes, Markup } = require('telegraf');
const logger = require('../../utils/logger');
const { getUserToken, makeApiRequest } = require('../../dependencies');
const { getFormattedWalletBalances } = require('../../services/walletService');
const { getPayees, addPayee } = require('../../services/payeeService');
const { sendToEmail, withdrawToWallet } = require('../../services/transferService');
const { v4: uuidv4 } = require('uuid');

// Import config items including NETWORK_NAMES
const { EMAIL_REGEX, NETWORK_NAMES } = require('../../config');

/**
 * For "wallet" method: extract the single wallet's lines from full balances (so we don't show them all).
 */
function extractSingleWalletInfo(formattedBalances, walletIdsByNetwork, selectedWalletId) {
  let sourceWalletName = 'Default Wallet';
  
  // 1) Find which network name is tied to selectedWalletId
  if (walletIdsByNetwork && typeof walletIdsByNetwork === 'object') {
    for (const [netKey, wId] of Object.entries(walletIdsByNetwork)) {
      if (wId === selectedWalletId) {
        sourceWalletName = NETWORK_NAMES[netKey] || netKey;
        break;
      }
    }
  }
  
  // 2) Look for that line in formattedBalances
  if (formattedBalances) {
    const lines = formattedBalances.split('\n');
    let inSection = false;
    let headingLine = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // If this line is the heading that matches our network name
      if (line.trim().startsWith('-') && line.includes(sourceWalletName)) {
        inSection = true;
        headingLine = line.trim();
        // The next line might be the USDC line
        if (i + 1 < lines.length && lines[i + 1].includes('USDC')) {
          return `${headingLine}\n     ${lines[i + 1].trim()}`;
        }
      } else if (inSection && line.includes('USDC')) {
        // If we found the heading previously, this is likely the balance
        return `${headingLine}\n     ${line.trim()}`;
      } else if (line.trim().startsWith('-') && line.includes('0x')) {
        // We've moved on to a new heading
        inSection = false;
      }
    }
  }
  
  // Fallback if not found
  return `- ${sourceWalletName}`;
}

/**
 * Builds a single-line row of inline buttons for all networks, marking the selected wallet with ✓.
 */
function buildSingleLineNetworkRow(walletIdsByNetwork, selectedWalletId) {
  const row = [];
  if (walletIdsByNetwork && typeof walletIdsByNetwork === 'object') {
    const netKeys = Object.keys(walletIdsByNetwork);
    for (const netKey of netKeys) {
      const wId = walletIdsByNetwork[netKey];
      const isSelected = wId === selectedWalletId;
      const displayName = NETWORK_NAMES[netKey] || netKey;
      const label = `${isSelected ? '✓ ' : ''}${displayName}`;
      row.push(Markup.button.callback(label, `select_wallet_early_${wId}`));
    }
  }
  return row;
}

// Our scene
const transferScene = new Scenes.WizardScene(
  'transfer-scene',
  
  // STEP 1: Check login, ask how to send
  async (ctx) => {
    const userId = ctx.from.id;
    const token = await getUserToken(userId);
    if (!token) {
      await ctx.reply(
        'You need to log in first to send funds.',
        Markup.inlineKeyboard([
          Markup.button.callback('Login', 'login')
        ])
      );
      return ctx.scene.leave();
    }
    
    ctx.scene.session.data = {};
    const message = await ctx.reply(
      'How would you like to send funds?',
      Markup.inlineKeyboard([
        [
          Markup.button.callback('Send to Email', 'email'),
          Markup.button.callback('Send to Wallet Address', 'wallet')
        ],
        [
          Markup.button.callback('Batch Send to Multiple Recipients', 'batch')
        ],
        [
          Markup.button.callback('Cancel', 'cancel_transfer')
        ]
      ])
    );
    ctx.scene.session.data.current_message_id = message.message_id;
    return ctx.wizard.next();
  },
  
  // STEP 2: Store chosen method
  async (ctx) => {
    if (!ctx.callbackQuery) {
      if (ctx.scene.session.data.current_message_id) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.scene.session.data.current_message_id,
          null,
          'Please select an option from the buttons above.'
        );
      } else {
        await ctx.reply('Please select an option from the buttons above.');
      }
      return;
    }
    await ctx.answerCbQuery();
    
    const action = ctx.callbackQuery.data;
    if (action === 'cancel_transfer') {
      await ctx.editMessageText('Transfer cancelled.');
      return ctx.scene.leave();
    }
    
    ctx.scene.session.data.recipient_type = action;
    if (action === 'email') {
      await showPayeeSelection(ctx);
      return ctx.wizard.next();
    } else if (action === 'wallet') {
      await ctx.editMessageText(
        'Please enter the wallet address to send funds to:',
        Markup.inlineKeyboard([
          [Markup.button.callback('Cancel', 'cancel_transfer')]
        ])
      );
      ctx.scene.session.data.current_message_id = ctx.callbackQuery.message.message_id;
      return ctx.wizard.next();
    } else if (action === 'batch') {
      await getPayeesForBatchSelection(ctx);
      return ctx.wizard.next();
    }
  },
  
  // STEP 3: Payee/wallet input
  async (ctx) => {
    const recipientType = ctx.scene.session.data.recipient_type;
    
    if (ctx.callbackQuery) {
      const action = ctx.callbackQuery.data;
      await ctx.answerCbQuery();
      
      if (action === 'cancel_transfer') {
        await ctx.editMessageText('Transfer cancelled.');
        return ctx.scene.leave();
      }
      if (action === 'back_to_transfer_options') {
        ctx.wizard.selectStep(0);
        return ctx.wizard.steps[0](ctx);
      }
      if (action === 'add_new_payee') {
        await ctx.editMessageText(
          'Please enter the email address for the new payee:',
          Markup.inlineKeyboard([
            [Markup.button.callback('Cancel', 'cancel_transfer')]
          ])
        );
        ctx.scene.session.data.adding_payee = true;
        ctx.scene.session.data.adding_payee_step = 'email';
        ctx.scene.session.data.current_message_id = ctx.callbackQuery.message.message_id;
        return;
      }
      
      if (action.startsWith('payee_')) {
        // Email method payee selected
        await ctx.editMessageText('Loading payee details...');
        
        const payeeId = action.replace('payee_', '');
        const payees = await getPayees(ctx.from.id);
        const selectedPayee = payees.find(p => p.id === payeeId);
        if (!selectedPayee) {
          await ctx.editMessageText(
            'Selected payee not found. Please try again.',
            Markup.inlineKeyboard([
              [Markup.button.callback('« Back to Payee List', 'back_to_payee_list')]
            ])
          );
          return;
        }
        ctx.scene.session.data.selected_payee = selectedPayee;
        
        // Get balances
        const [formattedBalances, walletIdsByNetwork] = await getFormattedWalletBalances(ctx.from.id);
        ctx.scene.session.data.walletIdsByNetwork = walletIdsByNetwork;
        
        // Determine default wallet
        let defaultWalletId = null;
        if (walletIdsByNetwork && typeof walletIdsByNetwork === 'object') {
          const netKeys = Object.keys(walletIdsByNetwork);
          if (netKeys.length) {
            for (const n of netKeys) {
              if (walletIdsByNetwork[n]?.isDefault) {
                defaultWalletId = walletIdsByNetwork[n];
                break;
              }
            }
            if (!defaultWalletId) {
              defaultWalletId = walletIdsByNetwork[netKeys[0]];
            }
          }
        }
        ctx.scene.session.data.selected_wallet = defaultWalletId;
        
        // For email: we show the ENTIRE formattedBalances
        // Build single-line row of networks
        const row = buildSingleLineNetworkRow(walletIdsByNetwork, defaultWalletId);
        
        const keyboard = [];
        if (row.length) {
          keyboard.push(row); // single row
        }
        keyboard.push([Markup.button.callback('Cancel', 'cancel_transfer')]);
        
        await ctx.editMessageText(
          `*Selected Recipient:* ${selectedPayee.nickName || selectedPayee.email}\n` +
          `*Email:* ${selectedPayee.email}\n\n` +
          `*Your Wallet Balances*\n${formattedBalances}\n\n` +
          `Please enter the amount you want to send (in USDC):`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(keyboard)
          }
        );
        ctx.scene.session.data.current_message_id = ctx.callbackQuery.message.message_id;
        ctx.wizard.next();
        return;
      }
      
      if (action === 'back_to_payee_list') {
        await showPayeeSelection(ctx);
        return;
      }
      
      if (action.startsWith('select_wallet_early_')) {
        // user switched wallet in the "email" context
        const walletId = action.replace('select_wallet_early_', '');
        ctx.scene.session.data.selected_wallet = walletId;
        await refreshEmailFlowWallet(ctx);
        return;
      }
      if (action === 'change_source_wallet') {
        // In wallet method
        await showWalletSelectionMenu(ctx);
        return;
      }
    }
    
    // If user typed text (e.g. new payee email or wallet address)
    if (ctx.message && ctx.message.text) {
      const text = ctx.message.text.trim();
      try {
        await ctx.deleteMessage(ctx.message.message_id);
      } catch {}
      
      if (ctx.scene.session.data.adding_payee) {
        if (ctx.scene.session.data.adding_payee_step === 'email') {
          if (!EMAIL_REGEX.test(text)) {
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              ctx.scene.session.data.current_message_id,
              null,
              'Invalid email format. Please enter a valid email address:',
              Markup.inlineKeyboard([
                [Markup.button.callback('Cancel', 'cancel_transfer')]
              ])
            );
            return;
          }
          ctx.scene.session.data.new_payee_email = text;
          ctx.scene.session.data.adding_payee_step = 'nickname';
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            ctx.scene.session.data.current_message_id,
            null,
            `Email: ${text}\n\nPlease enter a nickname for this payee (or send /skip to use the email as nickname):`,
            Markup.inlineKeyboard([
              [Markup.button.callback('Cancel', 'cancel_transfer')]
            ])
          );
          return;
        }
        if (ctx.scene.session.data.adding_payee_step === 'nickname') {
          const email = ctx.scene.session.data.new_payee_email;
          let nickname;
          if (text === '/skip') {
            nickname = email.split('@')[0];
          } else {
            nickname = text;
          }
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            ctx.scene.session.data.current_message_id,
            null,
            'Adding new payee...'
          );
          try {
            const newPayee = await addPayee(ctx.from.id, email, nickname);
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              ctx.scene.session.data.current_message_id,
              null,
              `✅ Payee added successfully!\n\nEmail: ${email}\nNickname: ${nickname}`,
              { parse_mode: 'Markdown' }
            );
            setTimeout(async () => {
              await ctx.telegram.editMessageText(
                ctx.chat.id,
                ctx.scene.session.data.current_message_id,
                null,
                'Loading payee selection...',
                { parse_mode: 'Markdown' }
              );
              await showPayeeSelection(ctx);
            }, 1000);
            delete ctx.scene.session.data.adding_payee;
            delete ctx.scene.session.data.adding_payee_step;
            delete ctx.scene.session.data.new_payee_email;
          } catch (error) {
            logger.error(`Error adding payee: ${error.message}`);
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              ctx.scene.session.data.current_message_id,
              null,
              `❌ Error adding payee: ${error.message}\n\nPlease try again.`,
              {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                  [Markup.button.callback('« Back to Payee List', 'back_to_payee_list')]
                ])
              }
            );
          }
          return;
        }
      }
      
      // If user typed a wallet address (wallet flow)
      if (recipientType === 'wallet') {
        ctx.scene.session.data.wallet_address = text;
        if (ctx.scene.session.data.current_message_id) {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            ctx.scene.session.data.current_message_id,
            null,
            'Loading wallet balances...'
          );
        }
        
        const [formattedBalances, walletIdsByNetwork] = await getFormattedWalletBalances(ctx.from.id);
        ctx.scene.session.data.walletIdsByNetwork = walletIdsByNetwork;
        
        // pick default
        let defaultWalletId = null;
        if (walletIdsByNetwork && typeof walletIdsByNetwork === 'object') {
          const netKeys = Object.keys(walletIdsByNetwork);
          if (netKeys.length) {
            for (const n of netKeys) {
              if (walletIdsByNetwork[n]?.isDefault) {
                defaultWalletId = walletIdsByNetwork[n];
                break;
              }
            }
            if (!defaultWalletId) {
              defaultWalletId = walletIdsByNetwork[netKeys[0]];
            }
          }
        }
        ctx.scene.session.data.selected_wallet = defaultWalletId;
        
        if (!text.startsWith('0x') || text.length < 42) {
          if (ctx.scene.session.data.current_message_id) {
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              ctx.scene.session.data.current_message_id,
              null,
              `❌ Invalid wallet address format. Address should start with '0x' and be at least 42 characters long.\n\nPlease enter a valid wallet address:`,
              {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                  [Markup.button.callback('« Back', 'back_to_transfer_options')],
                  [Markup.button.callback('Cancel', 'cancel_transfer')]
                ])
              }
            );
          }
          return;
        }
        
        // For wallet method: show only the single wallet's info
        const singleInfo = extractSingleWalletInfo(
          formattedBalances,
          walletIdsByNetwork,
          defaultWalletId
        );
        // Build single-line row
        const row = buildSingleLineNetworkRow(walletIdsByNetwork, defaultWalletId);
        const keyboard = [];
        if (row.length) keyboard.push(row);
        keyboard.push([Markup.button.callback('Cancel', 'cancel_transfer')]);
        
        try {
          if (ctx.scene.session.data.current_message_id) {
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              ctx.scene.session.data.current_message_id,
              null,
              `*Selected Wallet Address:*\n\`${text}\`\n\n` +
              `*Your Source Wallet Balances*\n${singleInfo}\n\n` +
              `Please enter the amount you want to send (in USDC):`,
              {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(keyboard)
              }
            );
          } else {
            const sentMsg = await ctx.reply(
              `*Selected Wallet Address:*\n\`${text}\`\n\n` +
              `*Your Source Wallet Balances*\n${singleInfo}\n\n` +
              `Please enter the amount you want to send (in USDC):`,
              {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(keyboard)
              }
            );
            ctx.scene.session.data.current_message_id = sentMsg.message_id;
          }
        } catch (error) {
          logger.error(`Error updating message: ${error.message}`);
          const sentMsg = await ctx.reply(
            `*Selected Wallet Address:*\n\`${text}\`\n\n` +
            `*Your Source Wallet Balances*\n${singleInfo}\n\n` +
            `Please enter the amount you want to send (in USDC):`,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard(keyboard)
            }
          );
          ctx.scene.session.data.current_message_id = sentMsg.message_id;
        }
        
        ctx.wizard.next();
        return;
      }
    }
    
    // Handle batch payee amount input
    if (ctx.scene.session.data.waiting_for_batch_amount && ctx.message && ctx.message.text) {
      const amountText = ctx.message.text.trim();
      try { await ctx.deleteMessage(ctx.message.message_id); } catch {}
      
      let amount;
      try {
        amount = parseFloat(amountText);
        if (isNaN(amount)) throw new Error('Not a number');
        if (amount <= 0) throw new Error('Amount must be greater than 0');
      } catch (error) {
        if (ctx.scene.session.data.current_message_id) {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            ctx.scene.session.data.current_message_id,
            null,
            `❌ Invalid amount: ${error.message}. Please enter a valid number.`,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard([
                [Markup.button.callback('Cancel', 'cancel_transfer')]
              ])
            }
          );
          return;
        }
      }
      
      // Get the current payee
      const selectedPayees = ctx.scene.session.data.selected_batch_payees || [];
      const currentIndex = ctx.scene.session.data.current_batch_payee_index || 0;
      const currentPayee = selectedPayees[currentIndex];
      
      // Save the amount
      if (!ctx.scene.session.data.batch_payee_amounts) {
        ctx.scene.session.data.batch_payee_amounts = [];
      }
      
      ctx.scene.session.data.batch_payee_amounts.push({
        id: currentPayee.id,
        email: currentPayee.email,
        amount: amount
      });
      
      // Move to next payee
      ctx.scene.session.data.current_batch_payee_index = currentIndex + 1;
      ctx.scene.session.data.waiting_for_batch_amount = false;
      
      // No loading indication - immediately ask for the next payee amount or show confirmation
      await promptForPayeeAmount(ctx);
      return;
    }
    
    // Handle the same amount for all payees
    if (ctx.scene.session.data.waiting_for_batch_same_amount && ctx.message && ctx.message.text) {
      const amountText = ctx.message.text.trim();
      try { await ctx.deleteMessage(ctx.message.message_id); } catch {}
      
      let amount;
      try {
        amount = parseFloat(amountText);
        if (isNaN(amount)) throw new Error('Not a number');
        if (amount <= 0) throw new Error('Amount must be greater than 0');
      } catch (error) {
        if (ctx.scene.session.data.current_message_id) {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            ctx.scene.session.data.current_message_id,
            null,
            `❌ Invalid amount: ${error.message}. Please enter a valid number.`,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard([
                [Markup.button.callback('Cancel', 'cancel_transfer')]
              ])
            }
          );
          return;
        }
      }
      
      // Get all selected payees
      const selectedPayees = ctx.scene.session.data.selected_batch_payees || [];
      
      // Save the same amount for all payees
      ctx.scene.session.data.batch_payee_amounts = selectedPayees.map(payee => ({
        id: payee.id,
        email: payee.email,
        amount: amount
      }));
      
      // Skip to confirmation since we've set the amount for all
      ctx.scene.session.data.waiting_for_batch_same_amount = false;
      await showBatchConfirmation(ctx);
      return;
    }
    
    // If we arrive here unhandled
    if (ctx.scene.session.data.current_message_id) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.scene.session.data.current_message_id,
        null,
        'Please select a recipient or follow the instructions above.',
        Markup.inlineKeyboard([
          [Markup.button.callback('« Back', 'back_to_payee_list')]
        ])
      );
    } else {
      await ctx.reply('Please select a recipient or follow the instructions above.');
    }
  },
  
  // STEP 4: Enter amount
  async (ctx) => {
    if (ctx.callbackQuery) {
      const action = ctx.callbackQuery.data;
      await ctx.answerCbQuery();
      
      if (action === 'cancel_transfer') {
        await ctx.editMessageText('Transfer cancelled.');
        return ctx.scene.leave();
      }
      if (action === 'back_to_confirmation') {
        await showTransferConfirmation(ctx);
        return;
      }
      return;
    }
    
    if (!ctx.message || !ctx.message.text) {
      if (ctx.scene.session.data.current_message_id) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.scene.session.data.current_message_id,
          null,
          'Please enter the amount you want to send.',
          Markup.inlineKeyboard([
            [Markup.button.callback('Cancel', 'cancel_transfer')]
          ])
        );
      } else {
        await ctx.reply('Please enter the amount you want to send.');
      }
      return;
    }
    
    const amountText = ctx.message.text.trim();
    try { await ctx.deleteMessage(ctx.message.message_id); } catch {}
    
    if (ctx.scene.session.data.current_message_id) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.scene.session.data.current_message_id,
        null,
        'Processing amount...'
      );
    }
    
    let amount;
    try {
      amount = parseFloat(amountText);
      if (isNaN(amount)) throw new Error('Not a number');
      if (amount <= 0) throw new Error('Amount must be greater than 0');
    } catch (error) {
      if (ctx.scene.session.data.current_message_id) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.scene.session.data.current_message_id,
          null,
          `❌ Invalid amount: ${error.message}. Please enter a valid number.`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('Cancel', 'cancel_transfer')]
            ])
          }
        );
      } else {
        await ctx.reply(
          `❌ Invalid amount: ${error.message}. Please enter a valid number.`,
          Markup.inlineKeyboard([
            [Markup.button.callback('Cancel', 'cancel_transfer')]
          ])
        );
      }
      return;
    }
    
    ctx.scene.session.data.amount = amount;
    await showTransferConfirmation(ctx);
    return ctx.wizard.next();
  },
  
  // STEP 5: Confirm & execute
  async (ctx) => {
    if (!ctx.callbackQuery) {
      if (ctx.scene.session.data.current_message_id) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.scene.session.data.current_message_id,
          null,
          'Please select Confirm or Cancel.',
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('✅ Confirm', 'confirm_transfer'),
                Markup.button.callback('❌ Cancel', 'cancel_transfer')
              ]
            ])
          }
        );
      } else {
        await ctx.reply('Please select Confirm or Cancel.');
      }
      return;
    }
    const action = ctx.callbackQuery.data;
    await ctx.answerCbQuery();
    
    if (action === 'cancel_transfer') {
      await ctx.editMessageText('Transfer cancelled.');
      return ctx.scene.leave();
    }
    
    if (action === 'confirm_transfer') {
      await ctx.editMessageText('Processing your transfer...', { parse_mode: 'Markdown' });
      try {
        const userId = ctx.from.id;
        const { recipient_type, selected_payee, wallet_address, selected_wallet, amount } = ctx.scene.session.data;
        
        if (recipient_type === 'email') {
          // Send to Email
          const payee = selected_payee;
          const amountForApi = Math.floor(amount * 1e8).toString();
          const payload = {
            email: payee.email,
            amount: amountForApi,
            purposeCode: 'self',
            currency: 'USDC'
          };
          if (payee.id) payload.payeeId = payee.id;
          if (selected_wallet) payload.walletId = selected_wallet;
          
          logger.info(`Sending email transfer: ${JSON.stringify(payload)}`);
          const response = await makeApiRequest('POST','/api/transfers/send',userId,payload);
          if (response && response.id) {
            await ctx.editMessageText(
              `✅ *Transfer Successful!*\n\n` +
              `*Recipient:* ${payee.nickName || payee.email}\n` +
              `*Amount:* ${amount.toFixed(2)} USDC\n` +
              `*Transaction ID:* \`${response.id}\`\n\n` +
              `The recipient will be notified via email.`,
              { parse_mode: 'Markdown' }
            );
          } else {
            throw new Error('Invalid response from server');
          }
        } else if (recipient_type === 'wallet') {
          // Send to external Wallet
          const amountForApi = Math.floor(amount * 1e8).toString();
          const payload = {
            walletAddress: wallet_address,
            amount: amountForApi,
            purposeCode: 'self',
            currency: 'USDC'
          };
          if (selected_wallet) payload.walletId = selected_wallet;
          
          logger.info(`Sending wallet transfer: ${JSON.stringify(payload)}`);
          const response = await makeApiRequest(
            'POST',
            '/api/transfers/wallet-withdraw',
            userId,
            payload
          );
          if (response && response.id) {
            await ctx.editMessageText(
              `✅ *Transfer Successful!*\n\n` +
              `*Recipient Wallet:*\n\`${wallet_address}\`\n` +
              `*Amount:* ${amount.toFixed(2)} USDC\n` +
              `*Transaction ID:* \`${response.id}\`\n\n` +
              `The transaction has been submitted to the blockchain.`,
              { parse_mode: 'Markdown' }
            );
          } else {
            throw new Error('Invalid response from server');
          }
        }
        // After success, let them do new commands
        await ctx.reply('Transaction complete! You can now use /send or other commands any time.');
      } catch (error) {
        logger.error(`Transfer error: ${error.message}`);
        let errorMessage = 'An error occurred during the transfer.';
        if (
          error.message &&
          (error.message.includes('isBlockchainAddress') || error.message.includes('Validation failed'))
        ) {
          errorMessage = 'Invalid wallet address. Please check the address and try again.';
        } else if (error.message) {
          errorMessage = error.message;
        }
        await ctx.editMessageText(
          `❌ *Transfer Failed*\n\n${errorMessage}\n\nPlease try again later.`,
          { parse_mode: 'Markdown' }
        );
      }
      // End the scene so user can immediately do new commands
      return ctx.scene.leave();
    }
  }
);

/**
 * Show the payee selection (Email flow).
 */
async function showPayeeSelection(ctx) {
  const userId = ctx.from.id;
  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText('Loading your payees...');
      ctx.scene.session.data.current_message_id = ctx.callbackQuery.message.message_id;
    } else if (ctx.scene.session.data.current_message_id) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.scene.session.data.current_message_id,
        null,
        'Loading your payees...'
      );
    } else {
      const loadingMsg = await ctx.reply('Loading your payees...');
      ctx.scene.session.data.current_message_id = loadingMsg.message_id;
    }
    
    const payees = await getPayees(userId);
    let keyboard = [];
    
    if (payees && payees.length) {
      let row = [];
      for (let i = 0; i < payees.length; i++) {
        const payee = payees[i];
        const displayName = payee.nickName || payee.email;
        row.push(Markup.button.callback(displayName, `payee_${payee.id}`));
        // 2 across
        if (row.length === 2 || i === payees.length - 1) {
          keyboard.push(row);
          row = [];
        }
      }
    }
    
    keyboard.push([Markup.button.callback('➕ Add New Payee', 'add_new_payee')]);
    keyboard.push([
      Markup.button.callback('« Back', 'back_to_transfer_options'),
      Markup.button.callback('❌ Cancel', 'cancel_transfer')
    ]);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      ctx.scene.session.data.current_message_id,
      null,
      `*Select a Recipient:*\n\n${payees.length === 0 ? 'You don\'t have any saved payees yet.' : ''}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      }
    );
  } catch (error) {
    logger.error(`Error showing payee selection: ${error.message}`);
    if (ctx.scene.session.data.current_message_id) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.scene.session.data.current_message_id,
        null,
        `❌ Error loading payees: ${error.message}\n\nPlease try again.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('« Back', 'back_to_transfer_options')]
          ])
        }
      );
    } else {
      await ctx.reply(
        `❌ Error loading payees: ${error.message}\n\nPlease try again.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('« Back', 'back_to_transfer_options')]
          ])
        }
      );
    }
  }
}

/**
 * Refresh the "email method" message after user changes wallet. 
 * In email method, we display the entire `formattedBalances`.
 */
async function refreshEmailFlowWallet(ctx) {
  const payee = ctx.scene.session.data.selected_payee;
  if (!payee) return;
  
  // Grab fresh data
  const [formattedBalances, walletIdsByNetwork] = await getFormattedWalletBalances(ctx.from.id);
  ctx.scene.session.data.walletIdsByNetwork = walletIdsByNetwork;
  
  // Build single-line row
  const row = buildSingleLineNetworkRow(walletIdsByNetwork, ctx.scene.session.data.selected_wallet);
  const keyboard = [];
  if (row.length) {
    keyboard.push(row);
  }
  keyboard.push([Markup.button.callback('Cancel', 'cancel_transfer')]);
  
  try {
    await ctx.editMessageText(
      `*Selected Recipient:* ${payee.nickName || payee.email}\n` +
      `*Email:* ${payee.email}\n\n` +
      `*Your Wallet Balances*\n${formattedBalances}\n\n` + // show ALL balances for email
      `Please enter the amount you want to send (in USDC):`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      }
    );
  } catch (error) {
    logger.error(`Error refreshing email flow wallet: ${error.message}`);
  }
}

/**
 * Show the wallet selection menu (for wallet flow only).
 */
async function showWalletSelectionMenu(ctx) {
  await ctx.editMessageText('Loading wallet options...');
  try {
    const walletIdsByNetwork = ctx.scene.session.data.walletIdsByNetwork;
    const selectedWalletId = ctx.scene.session.data.selected_wallet;
    const row = buildSingleLineNetworkRow(walletIdsByNetwork, selectedWalletId);
    
    const keyboard = [];
    if (row.length) keyboard.push(row);
    keyboard.push([Markup.button.callback('« Back', 'back_to_confirmation')]);
    
    await ctx.editMessageText(
      '*Select Source Wallet:*\n\nChoose the wallet to send funds from:',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      }
    );
  } catch (error) {
    logger.error(`Error showing wallet selection: ${error.message}`);
    await ctx.editMessageText(
      `❌ Error: ${error.message}\n\nPlease try again.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back', 'back_to_confirmation')]
        ])
      }
    );
  }
}

/**
 * Show final confirmation
 */
async function showTransferConfirmation(ctx) {
  try {
    const { recipient_type, selected_payee, wallet_address, selected_wallet, amount, walletIdsByNetwork } = ctx.scene.session.data;
    let msg = '*Transfer Summary*\n\n';
    
    if (recipient_type === 'email') {
      msg += `*Recipient:* ${selected_payee.nickName || selected_payee.email}\n`;
      msg += `*Email:* ${selected_payee.email}\n`;
    } else if (recipient_type === 'wallet') {
      msg += `*Recipient Wallet:*\n\`${wallet_address}\`\n`;
    }
    
    // Show the name of the selected wallet's network
    let sourceWalletName = 'Default Wallet';
    if (walletIdsByNetwork && typeof walletIdsByNetwork === 'object') {
      for (const [netKey, wId] of Object.entries(walletIdsByNetwork)) {
        if (wId === selected_wallet) {
          sourceWalletName = NETWORK_NAMES[netKey] || netKey;
          break;
        }
      }
    }
    msg += `*Source Wallet:* ${sourceWalletName}\n`;
    msg += `*Amount:* ${amount.toFixed(2)} USDC\n\n`;
    msg += 'Do you want to proceed with this transfer?';
    
    const keyboard = [
      [
        Markup.button.callback('✅ Confirm', 'confirm_transfer'),
        Markup.button.callback('❌ Cancel', 'cancel_transfer')
      ]
    ];
    
    if (ctx.scene.session.data.current_message_id) {
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.scene.session.data.current_message_id,
          null,
          msg,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(keyboard)
          }
        );
      } catch (err) {
        logger.warn(`Could not edit message for confirmation: ${err.message}. Sending new message.`);
        const newMsg = await ctx.reply(msg, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(keyboard)
        });
        ctx.scene.session.data.current_message_id = newMsg.message_id;
      }
    } else {
      const sentMsg = await ctx.reply(msg, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      });
      ctx.scene.session.data.current_message_id = sentMsg.message_id;
    }
  } catch (error) {
    logger.error(`Error showing confirmation: ${error.message}`);
    try {
      const errorMsg = await ctx.reply(
        `❌ Error: ${error.message}\n\nPlease try again.`,
        { parse_mode: 'Markdown' }
      );
      ctx.scene.session.data.current_message_id = errorMsg.message_id;
    } catch (innerErr) {
      logger.error(`Failed to send error message: ${innerErr.message}`);
    }
  }
}

/**
 * Action for user to change wallet inline (wallet flow).
 * (If in email flow, we refresh with full balances; if in wallet flow, just show one.)
 */
transferScene.action(/^select_wallet_early_/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const walletId = ctx.callbackQuery.data.replace('select_wallet_early_', '');
  ctx.scene.session.data.selected_wallet = walletId;
  
  const recipientType = ctx.scene.session.data.recipient_type;
  if (recipientType === 'email') {
    // Refresh entire balances in email flow
    await refreshEmailFlowWallet(ctx);
    return;
  }
  
  // If wallet flow
  try {
    const [formattedBalances, walletIdsByNetwork] = await getFormattedWalletBalances(ctx.from.id);
    ctx.scene.session.data.walletIdsByNetwork = walletIdsByNetwork;
    
    const singleInfo = extractSingleWalletInfo(
      formattedBalances,
      walletIdsByNetwork,
      walletId
    );
    const walletAddress = ctx.scene.session.data.wallet_address;
    
    // Single-line row
    const row = buildSingleLineNetworkRow(walletIdsByNetwork, walletId);
    const keyboard = [];
    if (row.length) keyboard.push(row);
    keyboard.push([Markup.button.callback('Cancel', 'cancel_transfer')]);
    
    await ctx.editMessageText(
      `*Selected Wallet Address:*\n\`${walletAddress}\`\n\n` +
      `*Your Source Wallet Balances*\n${singleInfo}\n\n` +
      `Please enter the amount you want to send (in USDC):`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      }
    );
  } catch (err) {
    logger.error(`Error updating prompt after wallet selection: ${err.message}`);
    try {
      await ctx.editMessageText(
        `❌ Error: ${err.message}\n\nPlease try again.`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
  }
});

/**
 * If user clicks the "Change Source Wallet" button in the wallet flow
 */
transferScene.action('change_source_wallet_early', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const [formattedBalances, walletIdsByNetwork] = await getFormattedWalletBalances(ctx.from.id);
    ctx.scene.session.data.walletIdsByNetwork = walletIdsByNetwork;
    const selectedWalletId = ctx.scene.session.data.selected_wallet;
    const walletAddress = ctx.scene.session.data.wallet_address;
    
    const row = buildSingleLineNetworkRow(walletIdsByNetwork, selectedWalletId);
    const keyboard = [];
    if (row.length) keyboard.push(row);
    keyboard.push([Markup.button.callback('Cancel', 'back_to_amount_prompt')]);
    
    const singleInfo = extractSingleWalletInfo(
      formattedBalances,
      walletIdsByNetwork,
      selectedWalletId
    );
    
    await ctx.editMessageText(
      `*Selected Wallet Address:*\n\`${walletAddress}\`\n\n` +
      `*Your Source Wallet Balances*\n${singleInfo}\n\n` +
      `Please enter the amount you want to send (in USDC):`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      }
    );
  } catch (error) {
    logger.error(`Error showing inline wallet selection: ${error.message}`);
    try {
      await ctx.editMessageText(
        `❌ Error: ${error.message}\n\nPlease try again.`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
  }
});

// If user clicks "wallet_selection_header", we ignore
transferScene.action('wallet_selection_header', async (ctx) => {
  await ctx.answerCbQuery('Select a wallet from the options below');
});

/**
 * If user wants to go back to the "amount" prompt
 */
transferScene.action('back_to_amount_prompt', async (ctx) => {
  await ctx.answerCbQuery();
  const walletAddress = ctx.scene.session.data.wallet_address || '';
  
  try {
    const [formattedBalances, walletIdsByNetwork] = await getFormattedWalletBalances(ctx.from.id);
    ctx.scene.session.data.walletIdsByNetwork = walletIdsByNetwork;
    const singleInfo = extractSingleWalletInfo(
      formattedBalances,
      walletIdsByNetwork,
      ctx.scene.session.data.selected_wallet
    );
    
    const row = buildSingleLineNetworkRow(walletIdsByNetwork, ctx.scene.session.data.selected_wallet);
    const keyboard = [];
    if (row.length) keyboard.push(row);
    keyboard.push([Markup.button.callback('Cancel', 'cancel_transfer')]);
    
    await ctx.editMessageText(
      `*Selected Wallet Address:*\n\`${walletAddress}\`\n\n` +
      `*Your Source Wallet Balances*\n${singleInfo}\n\n` +
      `Please enter the amount you want to send (in USDC):`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      }
    );
  } catch (error) {
    logger.warn(`Could not edit message: ${error.message}`);
    try {
      const newMsg = await ctx.reply(
        `*Selected Wallet Address:*\n\`${walletAddress}\`\n\n` +
        `Please enter the amount you want to send (in USDC):`,
        { parse_mode: 'Markdown' }
      );
      ctx.scene.session.data.current_message_id = newMsg.message_id;
    } catch {}
  }
});

// Also handle the /cancel command inside the scene
transferScene.command('cancel', async (ctx) => {
  await ctx.reply('Transfer cancelled. You can start again with /send.');
  return ctx.scene.leave();
});

/**
 * Show payees for batch selection with multi-select capability
 */
async function getPayeesForBatchSelection(ctx) {
  const userId = ctx.from.id;
  try {
    await ctx.editMessageText('Loading your payees for batch send...');
    ctx.scene.session.data.current_message_id = ctx.callbackQuery.message.message_id;
    
    const payees = await getPayees(userId);
    let keyboard = [];
    
    if (payees && payees.length) {
      // Initialize selected payees array if it doesn't exist
      if (!ctx.scene.session.data.selected_batch_payees) {
        ctx.scene.session.data.selected_batch_payees = [];
      }
      
      // Create a keyboard with checkboxes to indicate selection
      for (let i = 0; i < payees.length; i++) {
        const payee = payees[i];
        const displayName = payee.nickName || payee.email;
        
        // Check if this payee is already selected
        const isSelected = ctx.scene.session.data.selected_batch_payees.some(p => p.id === payee.id);
        const selectSymbol = isSelected ? '✅ ' : '';
        
        keyboard.push([
          Markup.button.callback(`${selectSymbol}${displayName}`, `batch_select_${payee.id}`)
        ]);
      }
    }
    
    // Add continue button (only if at least one payee is selected)
    const hasSelected = (ctx.scene.session.data.selected_batch_payees || []).length > 0;
    
    keyboard.push([
      Markup.button.callback('« Back', 'back_to_transfer_options'),
      ...(hasSelected ? [Markup.button.callback('Continue »', 'batch_continue')] : [])
    ]);
    keyboard.push([Markup.button.callback('❌ Cancel', 'cancel_transfer')]);
    
    const selectedCount = (ctx.scene.session.data.selected_batch_payees || []).length;
    const selectText = selectedCount > 0 ? `(${selectedCount} selected)` : '';
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      ctx.scene.session.data.current_message_id,
      null,
      `*Select Recipients for Batch Send ${selectText}*\n\n${payees.length === 0 ? 'You don\'t have any saved payees yet.' : 'Tap on a payee to select/deselect'}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      }
    );
  } catch (error) {
    logger.error(`Error showing batch payee selection: ${error.message}`);
    if (ctx.scene.session.data.current_message_id) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.scene.session.data.current_message_id,
        null,
        `❌ Error loading payees: ${error.message}\n\nPlease try again.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('« Back', 'back_to_transfer_options')]
          ])
        }
      );
    } else {
      await ctx.reply(
        `❌ Error loading payees: ${error.message}\n\nPlease try again.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('« Back', 'back_to_transfer_options')]
          ])
        }
      );
    }
  }
}

/**
 * Prompt for the amount for a specific payee in the batch
 */
async function promptForPayeeAmount(ctx) {
  const selectedPayees = ctx.scene.session.data.selected_batch_payees || [];
  const currentIndex = ctx.scene.session.data.current_batch_payee_index || 0;
  
  if (currentIndex >= selectedPayees.length) {
    // All payees have been processed, show confirmation
    await showBatchConfirmation(ctx);
    return;
  }
  
  const currentPayee = selectedPayees[currentIndex];
  const displayName = currentPayee.nickName || currentPayee.email;
  
  // Show progress
  const progress = `(${currentIndex + 1}/${selectedPayees.length})`;
  
  // Create collected amounts summary if we have already collected some
  let collectedSummary = '';
  if (ctx.scene.session.data.batch_payee_amounts && ctx.scene.session.data.batch_payee_amounts.length > 0) {
    collectedSummary = '*Collected Amounts:*\n';
    let totalSoFar = 0;
    
    for (const payeeAmount of ctx.scene.session.data.batch_payee_amounts) {
      const payee = selectedPayees.find(p => p.id === payeeAmount.id);
      const name = payee ? (payee.nickName || payee.email) : payeeAmount.email;
      collectedSummary += `${name}: ${payeeAmount.amount.toFixed(2)} USDC\n`;
      totalSoFar += payeeAmount.amount;
    }
    
    collectedSummary += `\n*Total so far:* ${totalSoFar.toFixed(2)} USDC\n\n`;
  }
  
  // Get formatted wallet balances
  const [formattedBalances, walletIdsByNetwork] = await getFormattedWalletBalances(ctx.from.id);
  
  // Create keyboard with network buttons as shown in the screenshot
  const keyboard = [];
  
  // Network buttons row (showing all networks but they're not actually selectable)
  if (walletIdsByNetwork && typeof walletIdsByNetwork === 'object') {
    const netKeys = Object.keys(walletIdsByNetwork);
    const networkRow = [];
    
    for (const netKey of netKeys) {
      const displayName = NETWORK_NAMES[netKey] || netKey;
      const isSelected = walletIdsByNetwork[netKey] === ctx.scene.session.data.selected_wallet;
      // Make a checkmark on the selected one but all buttons do the same thing
      const label = `${isSelected ? '✓ ' : ''}${displayName}`;
      networkRow.push(Markup.button.callback(label, 'wallet_selection_header'));
    }
    
    if (networkRow.length > 0) {
      keyboard.push(networkRow);
    }
  }
  
  // Add "Use same amount for all" option only for first payee
  if (currentIndex === 0) {
    keyboard.push([Markup.button.callback('Use same amount for all', 'batch_same_amount')]);
  }
  
  // Cancel button
  keyboard.push([Markup.button.callback('Cancel', 'cancel_transfer')]);
  
  await ctx.telegram.editMessageText(
    ctx.chat.id,
    ctx.scene.session.data.current_message_id,
    null,
    `*Batch Send ${progress}*\n\n` +
    `*Recipient:* ${displayName}\n` +
    `*Email:* ${currentPayee.email}\n\n` +
    `*Your Wallet Balances*\n` +
    `${formattedBalances}\n\n` +
    `${collectedSummary}` +
    `Please enter the amount you want to send to this recipient (in USDC):`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(keyboard)
    }
  );
  
  // Set waiting flag to handle text input
  ctx.scene.session.data.waiting_for_batch_amount = true;
}

/**
 * Show final batch confirmation
 */
async function showBatchConfirmation(ctx) {
  try {
    const selectedPayees = ctx.scene.session.data.selected_batch_payees || [];
    const payeeAmounts = ctx.scene.session.data.batch_payee_amounts || [];
    
    if (selectedPayees.length === 0 || payeeAmounts.length === 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.scene.session.data.current_message_id,
        null,
        'No recipients or amounts specified. Please start over.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('« Back', 'back_to_transfer_options')]
          ])
        }
      );
      return;
    }
    
    // Find wallet name
    let sourceWalletName = 'Default Wallet';
    const selectedWallet = ctx.scene.session.data.selected_wallet;
    const walletIdsByNetwork = ctx.scene.session.data.walletIdsByNetwork;
    
    if (walletIdsByNetwork && typeof walletIdsByNetwork === 'object') {
      for (const [netKey, wId] of Object.entries(walletIdsByNetwork)) {
        if (wId === selectedWallet) {
          sourceWalletName = NETWORK_NAMES[netKey] || netKey;
          break;
        }
      }
    }
    
    // Calculate total amount
    let totalAmount = 0;
    for (const amt of payeeAmounts) {
      totalAmount += amt.amount;
    }
    
    // Build summary message
    let msg = '*Batch Transfer Summary*\n\n';
    msg += `*Source Wallet:* ${sourceWalletName}\n`;
    msg += `*Number of Recipients:* ${selectedPayees.length}\n`;
    msg += `*Total Amount:* ${totalAmount.toFixed(2)} USDC\n\n`;
    msg += '*Recipients:*\n';
    
    for (let i = 0; i < selectedPayees.length; i++) {
      const payee = selectedPayees[i];
      const payeeAmount = payeeAmounts.find(pa => pa.id === payee.id);
      if (payeeAmount) {
        msg += `${i + 1}. ${payee.nickName || payee.email}: ${payeeAmount.amount.toFixed(2)} USDC\n`;
      }
    }
    
    msg += '\nDo you want to proceed with this batch transfer?';
    
    const keyboard = [
      [
        Markup.button.callback('✅ Confirm', 'confirm_batch_transfer'),
        Markup.button.callback('❌ Cancel', 'cancel_transfer')
      ]
    ];
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      ctx.scene.session.data.current_message_id,
      null,
      msg,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      }
    );
  } catch (error) {
    logger.error(`Error showing batch confirmation: ${error.message}`);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      ctx.scene.session.data.current_message_id,
      null,
      `❌ Error: ${error.message}\n\nPlease try again.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back', 'back_to_transfer_options')]
        ])
      }
    );
  }
}

/**
 * Process batch transfer
 */
async function processBatchTransfer(ctx) {
  try {
    await ctx.editMessageText('Processing your batch transfer...', { parse_mode: 'Markdown' });
    
    const userId = ctx.from.id;
    const selectedPayees = ctx.scene.session.data.selected_batch_payees || [];
    const payeeAmounts = ctx.scene.session.data.batch_payee_amounts || [];
    const selectedWallet = ctx.scene.session.data.selected_wallet;
    
    // Prepare the API payload
    const requests = [];
    
    for (const payee of selectedPayees) {
      const payeeAmount = payeeAmounts.find(pa => pa.id === payee.id);
      if (payeeAmount) {
        // Convert amount to API format (multiply by 1e8)
        const amountForApi = Math.floor(payeeAmount.amount * 1e8).toString();
        
        const requestId = uuidv4();
        const request = {
          email: payee.email,
          amount: amountForApi,
          purposeCode: 'self',
          currency: 'USDC'
        };
        
        if (payee.id) {
          request.payeeId = payee.id;
        }
        
        if (selectedWallet) {
          request.walletId = selectedWallet;
        }
        
        requests.push({
          requestId,
          request
        });
      }
    }
    
    const payload = { requests };
    
    logger.info(`Sending batch transfer with payload: ${JSON.stringify(payload)}`);
    
    const response = await makeApiRequest(
      'POST',
      '/api/transfers/send-batch',
      userId,
      payload
    );
    
    if (response) {
      // Handle the response based on its structure
      let resultMsg = `✅ *Batch Transfer Completed*\n\n`;
      
      // Check if response is an array of results
      if (Array.isArray(response)) {
        const successCount = response.filter(res => res.status === 'success').length;
        const failCount = response.length - successCount;
        
        resultMsg += `*Successful:* ${successCount} transfers\n`;
        if (failCount > 0) {
          resultMsg += `*Failed:* ${failCount} transfers\n\n`;
          resultMsg += 'Some transfers may have failed. Check your transaction history for details.';
        } else {
          resultMsg += '\nAll transfers were successful!';
        }
      } else if (response.status === 'success') {
        // Single success response
        resultMsg += 'All transfers were successful!';
      } else {
        // Handle other response formats
        resultMsg += 'Transfer completed. Check your transaction history for details.';
      }
      
      await ctx.editMessageText(resultMsg, { parse_mode: 'Markdown' });
      
      // After success, let them do new commands
      await ctx.reply('Batch transaction complete! You can now use /send or other commands any time.');
    } else {
      throw new Error('Invalid response from server');
    }
  } catch (error) {
    logger.error(`Batch transfer error: ${error.message}`);
    let errorMessage = 'An error occurred during the batch transfer.';
    if (error.message) {
      errorMessage = error.message;
    }
    await ctx.editMessageText(
      `❌ *Batch Transfer Failed*\n\n${errorMessage}\n\nPlease try again later.`,
      { parse_mode: 'Markdown' }
    );
  }
  
  // End the scene so user can immediately do new commands
  return ctx.scene.leave();
}

// Handle batch selection callbacks
transferScene.action(/^batch_select_/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const payeeId = ctx.callbackQuery.data.replace('batch_select_', '');
  
  // Initialize selected payees array if it doesn't exist
  if (!ctx.scene.session.data.selected_batch_payees) {
    ctx.scene.session.data.selected_batch_payees = [];
  }
  
  // Get the payees again to have full data
  const payees = await getPayees(ctx.from.id);
  const selectedPayee = payees.find(p => p.id === payeeId);
  
  if (!selectedPayee) {
    await ctx.answerCbQuery('Payee not found');
    return;
  }
  
  // Check if already selected
  const existingIndex = ctx.scene.session.data.selected_batch_payees.findIndex(p => p.id === payeeId);
  
  if (existingIndex >= 0) {
    // Remove if already selected
    ctx.scene.session.data.selected_batch_payees.splice(existingIndex, 1);
  } else {
    // Add if not selected
    ctx.scene.session.data.selected_batch_payees.push(selectedPayee);
  }
  
  // Refresh the display - No loading needed
  await getPayeesForBatchSelection(ctx);
});

// Continue with batch selection
transferScene.action('batch_continue', async (ctx) => {
  await ctx.answerCbQuery();
  
  try {
    const selectedPayees = ctx.scene.session.data.selected_batch_payees || [];
    if (selectedPayees.length === 0) {
      await ctx.editMessageText(
        'No recipients selected. Please select at least one recipient.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('« Back', 'back_to_transfer_options')]
          ])
        }
      );
      return;
    }
    
    // Initialize batch payee amounts array
    ctx.scene.session.data.batch_payee_amounts = [];
    ctx.scene.session.data.current_batch_payee_index = 0;
    
    // Get balances
    const [formattedBalances, walletIdsByNetwork] = await getFormattedWalletBalances(ctx.from.id);
    ctx.scene.session.data.walletIdsByNetwork = walletIdsByNetwork;
    
    // Determine default wallet
    let defaultWalletId = null;
    if (walletIdsByNetwork && typeof walletIdsByNetwork === 'object') {
      const netKeys = Object.keys(walletIdsByNetwork);
      if (netKeys.length) {
        for (const n of netKeys) {
          if (walletIdsByNetwork[n]?.isDefault) {
            defaultWalletId = walletIdsByNetwork[n];
            break;
          }
        }
        if (!defaultWalletId) {
          defaultWalletId = walletIdsByNetwork[netKeys[0]];
        }
      }
    }
    ctx.scene.session.data.selected_wallet = defaultWalletId;
    
    // Show the first payee
    await promptForPayeeAmount(ctx);
  } catch (error) {
    logger.error(`Error starting batch amount collection: ${error.message}`);
    await ctx.editMessageText(
      `❌ Error: ${error.message}\n\nPlease try again.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back', 'back_to_transfer_options')]
        ])
      }
    );
  }
});

// Use same amount for all payees
transferScene.action('batch_same_amount', async (ctx) => {
  await ctx.answerCbQuery();
  
  await ctx.telegram.editMessageText(
    ctx.chat.id,
    ctx.scene.session.data.current_message_id,
    null,
    'Please enter the amount you want to send to ALL selected recipients (in USDC):',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Cancel', 'cancel_transfer')]
      ])
    }
  );
  
  // Set waiting flag for same amount for all
  ctx.scene.session.data.waiting_for_batch_same_amount = true;
});

// Confirm batch transfer
transferScene.action('confirm_batch_transfer', async (ctx) => {
  await ctx.answerCbQuery();
  await processBatchTransfer(ctx);
});

module.exports = {
  transferScene
};