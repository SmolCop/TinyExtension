// [Tiny Extension] background.js - Service Worker
const DEBUG = false;

function log(...args) {
  if (DEBUG) console.log('[Tiny Extension]', ...args);
}

log('Service worker initialized.');

/**
 * Determine a clean generic label for a roll when showActionName is false:
 * - Attack / To-Hit rolls -> "Attack"
 * - Damage rolls -> "Damage"
 * - Saving throws -> "Saving Throw"
 * - Ability / Skill checks -> "Check"
 * - Anything else -> "Roll"
 */
function getGenericActionName(roll) {
  if (!roll) return 'Roll';

  const title = (roll.title || roll.rawTitle || '').trim();

  // 0. Recharge rolls
  if (roll.isRecharge || /\brecharge\b/i.test(title)) {
    return 'Recharge';
  }

  // 1. Damage rolls
  if (roll.isDamage) {
    return 'Damage';
  }

  const formula = (roll.formula || '').trim();
  const isD20 = formula.includes('d20') || (/^\s*d20/i).test(formula);

  // 2. Saving throws
  if (/\b(saving throw|save|saves)\b/i.test(title) || /\b(str|dex|con|int|wis|cha)\s+save/i.test(title)) {
    return 'Saving Throw';
  }

  // 3. Ability / Skill checks
  const SKILL_REGEX = /\b(athletics|acrobatics|sleight of hand|stealth|arcana|history|investigation|nature|religion|animal handling|insight|medicine|perception|survival|deception|intimidation|performance|persuasion|initiative|check)\b/i;
  const ABILITY_CHECK_REGEX = /\b(strength|dexterity|constitution|intelligence|wisdom|charisma)\b/i;

  if (SKILL_REGEX.test(title) || ABILITY_CHECK_REGEX.test(title)) {
    return 'Check';
  }

  // 4. Attack / To-Hit rolls (d20 rolls that are not checks or saves)
  if (isD20 || /\b(attack|to hit|hit)\b/i.test(title) || Boolean(roll.isAdvantage || roll.isDisadvantage)) {
    return 'Attack';
  }

  // 5. Fallback for any other rolls
  return 'Roll';
}

// Listen for messages from popup.js or content-5etools.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderInfo = sender.tab ? `tab ${sender.tab.id} (${sender.tab.url})` : 'popup';
  log(`Background received "${message.action}" from ${senderInfo}:`, message);

  if (message.action === 'CHECK_OBR_TAB') {
    queryOwlbearTabs((tabs) => {
      if (!tabs || tabs.length === 0) {
        sendResponse({ hasObrTab: false, count: 0, isGm: false });
        return;
      }

      let completed = 0;
      let anyGm = false;
      tabs.forEach((tab) => {
        pingObrTab(tab, (res) => {
          completed++;
          if (res && res.isGm === true) {
            anyGm = true;
          }
          if (completed === tabs.length) {
            sendResponse({ hasObrTab: true, count: tabs.length, isGm: anyGm });
          }
        });
      });
    });
    return true; // Keep message channel open for async response
  }

  if (message.action === 'SEND_ROLL') {
    const rollPayload = message.roll;

    // Check settings before forwarding: Pause/Enable, Show Creature Name, Show Action Name, Send Descriptions
    chrome.storage.local.get({
      bridgeEnabled: true,
      showCreatureName: false,
      showActionName: false,
      sendDescriptions: true
    }, (settings) => {
      if (!settings.bridgeEnabled) {
        log('Bridge is paused via user toggle. Skipping roll forward.');
        sendResponse({ success: false, paused: true });
        return;
      }

      if (!settings.sendDescriptions) {
        if (rollPayload.isCondition) {
          log('Send descriptions is OFF. Skipping condition explanation.');
          sendResponse({ success: false, disabled: true });
          return;
        }
        rollPayload.sendDescriptions = false;
        rollPayload.description = '[REDACTED]';
        delete rollPayload.attackSource;
        delete rollPayload.range;
        delete rollPayload.saveAbility;
      }

      if (!settings.showCreatureName) {
        log('Show creature name is OFF. Replacing name with "DM".');
        rollPayload.character = 'DM';
      }

      if (!settings.showActionName && !rollPayload.isCondition) {
        const genericTitle = getGenericActionName(rollPayload);
        log(`Masking action name "${rollPayload.title}" -> "${genericTitle}".`);
        rollPayload.title = genericTitle;
        delete rollPayload.attackSource;
        delete rollPayload.range;
      }

      log('Processing roll to forward:', rollPayload);

      queryOwlbearTabs((tabs) => {
        if (!tabs || tabs.length === 0) {
          log('No Owlbear Rodeo tab found.');
          sendResponse({
            success: false,
            error: 'No active Owlbear Rodeo tab found. Please make sure an Owlbear Rodeo room (https://www.owlbear.rodeo/) is open.'
          });
          return;
        }

        log(`Forwarding roll to ${tabs.length} Owlbear Rodeo tab(s)...`);
        let completed = 0;
        let successCount = 0;
        const errors = [];

        tabs.forEach((tab) => {
          sendRollToTab(tab, rollPayload, (ok, err) => {
            completed++;
            if (ok) {
              successCount++;
            } else if (err) {
              errors.push(err);
            }

            if (completed === tabs.length) {
              sendResponse({
                success: successCount > 0,
                successCount,
                totalTabs: tabs.length,
                errors: errors.length > 0 ? errors : undefined
              });
            }
          });
        });
      });
    });
    return true; // Keep message channel open for async response
  }

  return false;
});

/**
 * Sends roll message to a tab, with automatic content script injection fallback
 * if the content script was not yet loaded (e.g. after extension reload without page refresh)
 */
function sendRollToTab(tab, rollPayload, callback) {
  chrome.tabs.sendMessage(tab.id, {
    action: 'DISPATCH_ROLL',
    roll: rollPayload
  }, (response) => {
    if (chrome.runtime.lastError) {
      const errMsg = chrome.runtime.lastError.message || '';
      log(`Initial dispatch to tab ${tab.id} (${tab.url}) failed: ${errMsg}`);

      // If the content script is missing on the tab, dynamically inject it and retry
      if (errMsg.includes('Receiving end does not exist') || errMsg.includes('Could not establish connection')) {
        log(`content-obr.js missing on tab ${tab.id}. Auto-injecting content script via chrome.scripting...`);
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content-obr.js']
        }, () => {
          if (chrome.runtime.lastError) {
            const injectErr = chrome.runtime.lastError.message;
            console.error(`[Tiny Extension] Dynamic injection into tab ${tab.id} failed:`, injectErr);
            callback(false, `Tab ${tab.id}: ${injectErr}. Please refresh the Owlbear Rodeo room.`);
            return;
          }

          log(`Successfully injected content-obr.js into tab ${tab.id}. Retrying roll dispatch...`);
          // Brief pause to allow content script event listeners to register
          setTimeout(() => {
            chrome.tabs.sendMessage(tab.id, {
              action: 'DISPATCH_ROLL',
              roll: rollPayload
            }, (retryResponse) => {
              if (chrome.runtime.lastError) {
                const retryErr = chrome.runtime.lastError.message;
                console.error(`[Tiny Extension] Retry dispatch to tab ${tab.id} failed:`, retryErr);
                callback(false, `Tab ${tab.id}: ${retryErr}. Please refresh the Owlbear Rodeo room.`);
              } else {
                log(`Tab ${tab.id} successfully acknowledged roll after auto-injection:`, retryResponse);
                callback(true, null, retryResponse);
              }
            });
          }, 80);
        });
        return;
      }

      callback(false, `Tab ${tab.id}: ${errMsg}`);
      return;
    }

    log(`Tab ${tab.id} acknowledged roll dispatch:`, response);
    callback(true, null, response);
  });
}

function pingObrTab(tab, callback) {
  chrome.tabs.sendMessage(tab.id, { action: 'PING' }, (response) => {
    if (chrome.runtime.lastError) {
      const errMsg = chrome.runtime.lastError.message || '';
      if (errMsg.includes('Receiving end does not exist') || errMsg.includes('Could not establish connection')) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content-obr.js']
        }, () => {
          if (chrome.runtime.lastError) {
            callback(null);
            return;
          }
          setTimeout(() => {
            chrome.tabs.sendMessage(tab.id, { action: 'PING' }, (retryResponse) => {
              callback(chrome.runtime.lastError ? null : retryResponse);
            });
          }, 80);
        });
        return;
      }
      callback(null);
      return;
    }
    callback(response);
  });
}

// Helper to find all open Owlbear Rodeo tabs (prioritizes active room tabs)
function queryOwlbearTabs(callback) {
  chrome.tabs.query({
    url: [
      "https://*.owlbear.rodeo/*",
      "https://owlbear.rodeo/*"
    ]
  }, (tabs) => {
    if (chrome.runtime.lastError) {
      console.error('[Tiny Extension] Error querying Owlbear tabs:', chrome.runtime.lastError);
      callback([]);
      return;
    }
    const matchingTabs = tabs || [];
    // Prioritize room tabs (/room/ or /game/) if present
    matchingTabs.sort((a, b) => {
      const aIsRoom = (a.url || '').includes('/room/') ? 1 : 0;
      const bIsRoom = (b.url || '').includes('/room/') ? 1 : 0;
      return bIsRoom - aIsRoom;
    });
    callback(matchingTabs);
  });
}
