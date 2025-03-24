///////////////////////////////////////////////////////
// transfer.js
///////////////////////////////////////////////////////

const { Scenes, Markup } = require('telegraf');
const logger = require('../../utils/logger');
const { getUserToken, makeApiRequest } = require('../../dependencies');
const { getFormattedWalletBalances } = require('../../services/walletService');
const { getPayees, addPayee } = require('../../services/payeeService');
const { sendToEmail, withdrawToWallet } = require('../../services/transferService');
const { EMAIL_REGEX, NETWORK_NAMES } = require('../../config');

// Helper for the "wallet" method single-line extraction
function extractSingleWalletInfo(formattedBalances, walletIdsByNetwork, selectedWalletId) {
  let sourceWalletName = 'Default Wallet';
  
  if (walletIdsByNetwork && typeof walletIdsByNetwork === 'object') {
    for (const [netKey, wId] of Object.entries(walletIdsByNetwork)) {
      if (wId === selectedWalletId) {
        sourceWalletName = NETWORK_NAMES[netKey] || netKey;
        break;
      }
    }
  }
  
  if (formattedBalances) {
    const lines = formattedBalances.split('\n');
    let inSection = false;
    let headingLine = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('-') && line.includes(sourceWalletName)) {
        inSection = true;
        headingLine = line.trim();
        if (i + 1 < lines.length && lines[i + 1].includes('USDC')) {
          return `${headingLine}\n     ${lines[i + 1].trim()}`;
        }
      } else if (inSection && line.includes('USDC')) {
        return `${headingLine}\n     ${line.trim()}`;
      } else if (line.trim().startsWith('-') && line.includes('0x')) {
        inSection = false;
      }
    }
  }
  
  return `- ${sourceWalletName}`;
}

// Single-line row for all networks
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

const transferScene = new Scenes.WizardScene(
  'transfer-scene',
  
  // STEP 1
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
  
  // STEP 2
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
      // BATCH FLOW – Step A: Show payee selection with multi-select
      await startBatchPayeeSelection(ctx);
      return; // We'll remain in the same step until user is done selecting
    }
  },
  
  // STEP 3 – This handles Email or direct wallet flows, or continues the batch flow after sub-logic
  async (ctx) => {
    const recipientType = ctx.scene.session.data.recipient_type;
    
    // ... normal email/wallet method callback logic ...
    if (recipientType === 'email' || recipientType === 'wallet') {
      // (same as before)
      if (ctx.callbackQuery) {
        // handle payee_xxx, etc. (EMAIL)
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
          // Email flow single payee selection
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
          
          // get balances
          const [formattedBalances, walletIdsByNetwork] = await getFormattedWalletBalances(ctx.from.id);
          ctx.scene.session.data.walletIdsByNetwork = walletIdsByNetwork;
          // default wallet
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
          
          // show entire balances for email flow
          const row = buildSingleLineNetworkRow(walletIdsByNetwork, defaultWalletId);
          const keyboard = [];
          if (row.length) {
            keyboard.push(row);
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
          // Next step
          ctx.wizard.next();
          return;
        }
        if (action === 'back_to_payee_list') {
          await showPayeeSelection(ctx);
          return;
        }
        if (action.startsWith('select_wallet_early_')) {
          // user changed source wallet in email flow
          const walletId = action.replace('select_wallet_early_', '');
          ctx.scene.session.data.selected_wallet = walletId;
          await refreshEmailFlowWallet(ctx);
          return;
        }
        if (action === 'change_source_wallet') {
          await showWalletSelectionMenu(ctx);
          return;
        }
      }
      
      // If user typed text
      if (ctx.message && ctx.message.text) {
        const text = ctx.message.text.trim();
        try { await ctx.deleteMessage(ctx.message.message_id); } catch {}
        
        // If adding payee
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
        
        // If user typed a wallet address
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
          
          // single wallet info
          const singleInfo = extractSingleWalletInfo(
            formattedBalances,
            walletIdsByNetwork,
            defaultWalletId
          );
          // row
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
      
      // fallback if unhandled
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
    }
  },
  
  // STEP 4: (Email or wallet) – amount
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
      return ctx.scene.leave();
    }
  }
);

/**
 * -------------
 * BATCH SEND LOGIC
 * -------------
 */

/**
 * Step A: Show payee list with multiple select
 */
async function startBatchPayeeSelection(ctx) {
  // We'll store an array of selected payee IDs
  ctx.scene.session.data.batchPayees = [];
  
  // Show the list
  await showBatchPayeeList(ctx, true);
}

/**
 * Show batch payee list, with each payee as a toggle
 */
async function showBatchPayeeList(ctx, firstTime = false) {
  const userId = ctx.from.id;
  try {
    if (firstTime) {
      if (ctx.scene.session.data.current_message_id) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.scene.session.data.current_message_id,
          null,
          'Loading your payees...'
        );
      } else {
        const msg = await ctx.reply('Loading your payees...');
        ctx.scene.session.data.current_message_id = msg.message_id;
      }
    }
    
    const payees = await getPayees(userId);
    let keyboard = [];
    
    // session batch array
    const selectedIds = ctx.scene.session.data.batchPayees || [];
    
    if (payees && payees.length > 0) {
      let row = [];
      for (let i = 0; i < payees.length; i++) {
        const payee = payees[i];
        const displayName = payee.nickName || payee.email;
        
        // If payee.id is in selectedIds => "✓" label
        const isSelected = selectedIds.includes(payee.id);
        const label = `${isSelected ? '✓ ' : ''}${displayName}`;
        row.push(Markup.button.callback(label, `toggle_batch_payee_${payee.id}`));
        
        // 2 columns
        if (row.length === 2 || i === payees.length - 1) {
          keyboard.push(row);
          row = [];
        }
      }
    }
    
    // "Done" button if user selected at least 1 payee
    const doneRow = [];
    if ((ctx.scene.session.data.batchPayees || []).length > 0) {
      doneRow.push(Markup.button.callback('Done', 'batch_selection_done'));
    }
    doneRow.push(Markup.button.callback('Cancel', 'cancel_transfer'));
    keyboard.push(doneRow);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      ctx.scene.session.data.current_message_id,
      null,
      `*Select Payees (Multiple)*\n\nTap each payee to toggle.\n\n${
        payees.length === 0 ? 'No payees found. Add some first!' : ''
      }`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      }
    );
  } catch (error) {
    logger.error(`Error in showBatchPayeeList: ${error.message}`);
  }
}

/**
 * On toggling a payee for batch
 */
transferScene.action(/^toggle_batch_payee_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const payeeId = ctx.match[1];
  const batchPayees = ctx.scene.session.data.batchPayees || [];
  
  // If already selected, remove it. Else, add it
  const idx = batchPayees.indexOf(payeeId);
  if (idx >= 0) {
    batchPayees.splice(idx, 1);
  } else {
    batchPayees.push(payeeId);
  }
  ctx.scene.session.data.batchPayees = batchPayees;
  
  // Re-show the list so the checkboxes update
  await showBatchPayeeList(ctx);
});

/**
 * When user clicks "Done" for batch selection
 */
transferScene.action('batch_selection_done', async (ctx) => {
  await ctx.answerCbQuery();
  
  // We proceed to ask for amounts for each selected payee in turn
  // We'll store them in an array => { email, payeeId, amount? }
  
  const userId = ctx.from.id;
  const payees = await getPayees(userId);
  // Filter only the selected payees
  const selectedPayeeIds = ctx.scene.session.data.batchPayees || [];
  const selectedPayees = payees.filter(p => selectedPayeeIds.includes(p.id));
  
  if (!selectedPayees || selectedPayees.length === 0) {
    // If user had none selected, just show the list again or exit
    await ctx.editMessageText(
      'No payees selected. Returning to selection...',
    );
    return showBatchPayeeList(ctx);
  }
  
  // We'll store the data in an array, each item = { id, email, nickname, amount? }
  ctx.scene.session.data.batchPayeeData = selectedPayees.map(p => ({
    id: p.id,
    email: p.email,
    nickname: p.nickName || p.email,
    amount: null
  }));
  
  // We'll also keep an index for which payee we're asking about
  ctx.scene.session.data.batchPayeeIndex = 0;
  
  // Next: ask user for the amount for the first payee
  await askNextBatchPayeeAmount(ctx, true);
});

/**
 * Prompt user for the next payee’s amount
 */
async function askNextBatchPayeeAmount(ctx, loadingFirst = false) {
  const index = ctx.scene.session.data.batchPayeeIndex || 0;
  const payees = ctx.scene.session.data.batchPayeeData || [];
  
  if (index >= payees.length) {
    // We have amounts for all payees, go to summary
    return showBatchSummary(ctx);
  }
  
  const payee = payees[index];
  
  if (loadingFirst) {
    // Show a "Loading..." or something if needed
    await ctx.editMessageText(
      'Loading next payee input...'
    );
  }
  
  // Now prompt
  const message = await ctx.reply(
    `Please enter the amount (USDC) for *${payee.nickname}* (${payee.email})`,
    { parse_mode: 'Markdown' }
  );
  // Store that message ID so we can delete or update
  ctx.scene.session.data.current_message_id = message.message_id;
}

/**
 * After user inputs an amount for that payee
 */
async function handleBatchPayeeAmount(ctx, text) {
  const index = ctx.scene.session.data.batchPayeeIndex || 0;
  const payees = ctx.scene.session.data.batchPayeeData || [];
  const payee = payees[index];
  
  // loading
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
    amount = parseFloat(text);
    if (isNaN(amount)) throw new Error('Not a number');
    if (amount <= 0) throw new Error('Must be > 0');
  } catch (error) {
    // error
    if (ctx.scene.session.data.current_message_id) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.scene.session.data.current_message_id,
        null,
        `❌ Invalid amount (${error.message}). Enter a valid number.`,
        {
          parse_mode: 'Markdown'
        }
      );
    } else {
      await ctx.reply(`❌ Invalid amount (${error.message}). Enter a valid number.`);
    }
    return;
  }
  
  // store
  payee.amount = amount;
  // move index forward
  ctx.scene.session.data.batchPayeeIndex = index + 1;
  
  // Delete the old prompt
  if (ctx.scene.session.data.current_message_id) {
    try {
      await ctx.deleteMessage(ctx.scene.session.data.current_message_id);
    } catch {}
  }
  
  // ask next or summary
  await askNextBatchPayeeAmount(ctx);
}

/**
 * Called once we have amounts for all payees
 */
async function showBatchSummary(ctx) {
  const payees = ctx.scene.session.data.batchPayeeData || [];
  
  // Build summary
  let summary = '*Batch Send Summary*\n\n';
  let total = 0;
  for (const p of payees) {
    summary += `- *${p.nickname}* (${p.email}): ${p.amount.toFixed(2)} USDC\n`;
    total += p.amount;
  }
  summary += `\n*Total Payees:* ${payees.length}\n*Total Amount:* ${total.toFixed(2)} USDC\n\nConfirm to proceed?`;
  
  const keyboard = [
    [
      Markup.button.callback('✅ Confirm Batch', 'confirm_batch_send'),
      Markup.button.callback('❌ Cancel', 'cancel_transfer')
    ]
  ];
  
  // If there's an existing message, update it
  try {
    const msgId = ctx.scene.session.data.current_message_id;
    if (msgId) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        msgId,
        null,
        summary,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(keyboard)
        }
      );
    } else {
      const newMsg = await ctx.reply(summary, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      });
      ctx.scene.session.data.current_message_id = newMsg.message_id;
    }
  } catch (error) {
    logger.error(`Error showing batch summary: ${error.message}`);
    const newMsg = await ctx.reply(summary, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(keyboard)
    });
    ctx.scene.session.data.current_message_id = newMsg.message_id;
  }
}

/**
 * Confirming the batch
 */
transferScene.action('confirm_batch_send', async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.scene.session.data.current_message_id) {
    await ctx.editMessageText('Processing your batch send...', { parse_mode: 'Markdown' });
  }
  
  try {
    // Build the request array
    const userId = ctx.from.id;
    const payees = ctx.scene.session.data.batchPayeeData || [];
    
    // The user wants to call /api/transfers/send-batch
    // According to your request body, it should look like:
    // {
    //   requests: [
    //     { requestId: "random-uuid", request: {...} },
    //     ...
    //   ]
    // }
    const { v4: uuidv4 } = require('uuid'); // Ensure you have installed 'uuid'
    
    const requests = payees.map(p => {
      const amountForApi = Math.floor(p.amount * 1e8).toString();
      return {
        requestId: uuidv4(),
        request: {
          email: p.email,
          amount: amountForApi,
          purposeCode: 'self',
          currency: 'USDC'
        }
      };
    });
    
    const payload = { requests };
    
    logger.info(`Sending batch with payload: ${JSON.stringify(payload)}`);
    // Suppose the API path is /api/transfers/send-batch
    const response = await makeApiRequest(
      'POST',
      '/api/transfers/send-batch',
      userId,
      payload
    );
    
    // Check if success
    if (response) {
      await ctx.editMessageText(
        '✅ *Batch Transfer Successful!*\n\nAll transfers have been submitted.',
        { parse_mode: 'Markdown' }
      );
    } else {
      throw new Error('Invalid response from server');
    }
    
    await ctx.reply('Batch transfer complete! You can now use /send or other commands any time.');
  } catch (error) {
    logger.error(`Batch transfer error: ${error.message}`);
    let errorMessage = error.message || 'Unknown error';
    await ctx.editMessageText(
      `❌ *Batch Transfer Failed*\n\n${errorMessage}\n\nPlease try again later.`,
      { parse_mode: 'Markdown' }
    );
  }
  
  return ctx.scene.leave();
});

/**
 * We'll listen for user text while in the same step (the "batch" subflow).
 * If the user is in the middle of paying amounts, handle that.
 */
transferScene.on('text', async (ctx) => {
  // Make sure we're in the batch flow
  if (!ctx.scene.session.data || !ctx.scene.session.data.batchPayeeData) {
    // The user typed text while not in the batch flow, so ignore or do something else
    return;
  }

  // Now we know batchPayeeData is defined
  const payees = ctx.scene.session.data.batchPayeeData;
  const index = ctx.scene.session.data.batchPayeeIndex || 0;
  if (index < payees.length) {
    // The user is in the middle of entering amounts
    const text = ctx.message.text.trim();
    try {
      await ctx.deleteMessage(ctx.message.message_id);
    } catch {}
    
    await handleBatchPayeeAmount(ctx, text); // your existing logic
  }
});

/**
 * showPayeeSelection is the normal email method selection
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
    
    if (payees && payees.length > 0) {
      let row = [];
      for (let i = 0; i < payees.length; i++) {
        const payee = payees[i];
        const displayName = payee.nickName || payee.email;
        row.push(Markup.button.callback(displayName, `payee_${payee.id}`));
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
        `❌ Error loading payees: ${error.message}\n\nPlease try again.`
      );
    } else {
      await ctx.reply(`❌ Error loading payees: ${error.message}\n\nPlease try again.`);
    }
  }
}

/**
 * refreshEmailFlowWallet – same as your existing logic
 */
async function refreshEmailFlowWallet(ctx) {
  const payee = ctx.scene.session.data.selected_payee;
  if (!payee) return;
  
  const [formattedBalances, walletIdsByNetwork] = await getFormattedWalletBalances(ctx.from.id);
  ctx.scene.session.data.walletIdsByNetwork = walletIdsByNetwork;
  
  const row = buildSingleLineNetworkRow(walletIdsByNetwork, ctx.scene.session.data.selected_wallet);
  const keyboard = [];
  if (row.length) keyboard.push(row);
  keyboard.push([Markup.button.callback('Cancel', 'cancel_transfer')]);
  
  try {
    await ctx.editMessageText(
      `*Selected Recipient:* ${payee.nickName || payee.email}\n` +
      `*Email:* ${payee.email}\n\n` +
      `*Your Wallet Balances*\n${formattedBalances}\n\n` +
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
 * showWalletSelectionMenu – same as your existing logic
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
      `❌ Error: ${error.message}\n\nPlease try again.`
    );
  }
}

/**
 * showTransferConfirmation – same as your existing logic
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
      } catch (error) {
        logger.warn(`Could not edit message for confirmation: ${error.message}. Sending new message.`);
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

transferScene.command('cancel', async (ctx) => {
  await ctx.reply('Transfer cancelled. You can start again with /send.');
  return ctx.scene.leave();
});

module.exports = {
  transferScene
};