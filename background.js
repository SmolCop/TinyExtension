// [Tiny Extension] background.js - Service Worker / Background Script
const DEBUG = false;

function log(...args) {
  if (DEBUG) console.log('[Tiny Extension]', ...args);
}

log('Service worker initialized.');

let memoryTargetObrTabId = null;

function isOwlbearUrl(url) {
  if (!url) return false;
  return /^https:\/\/([^/]+\.)?owlbear\.rodeo(\/|$)/i.test(url);
}

function getTargetObrTabId(callback) {
  if (chrome.storage && chrome.storage.session) {
    chrome.storage.session.get({ targetObrTabId: null }, (res) => {
      if (chrome.runtime.lastError) {
        callback(memoryTargetObrTabId);
        return;
      }
      callback(res && res.targetObrTabId ? res.targetObrTabId : null);
    });
    return;
  }
  callback(memoryTargetObrTabId);
}

function setTargetObrTabId(tabId, callback) {
  memoryTargetObrTabId = tabId || null;
  if (chrome.storage && chrome.storage.session) {
    chrome.storage.session.set({ targetObrTabId: memoryTargetObrTabId }, () => {
      if (callback) callback();
    });
    return;
  }
  if (callback) callback();
}

function selectBestObrTab(tabSummaries) {
  if (!tabSummaries || tabSummaries.length === 0) return null;
  const sorted = tabSummaries.slice().sort((a, b) => {
    const gmDiff = (b.isGm ? 1 : 0) - (a.isGm ? 1 : 0);
    if (gmDiff !== 0) return gmDiff;
    const aIsRoom = (a.url || '').includes('/room/') ? 1 : 0;
    const bIsRoom = (b.url || '').includes('/room/') ? 1 : 0;
    if (bIsRoom !== aIsRoom) return bIsRoom - aIsRoom;
    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  });
  return sorted[0];
}

function resolveObrTabsAndTarget(callback) {
  queryOwlbearTabs((rawTabs) => {
    if (!rawTabs || rawTabs.length === 0) {
      setTargetObrTabId(null, () => {
        callback({ tabs: [], targetObrTabId: null, targetTab: null });
      });
      return;
    }

    let completed = 0;
    const summaries = new Array(rawTabs.length);

    rawTabs.forEach((tab, idx) => {
      pingObrTab(tab, (res) => {
        summaries[idx] = {
          id: tab.id,
          title: tab.title || tab.url || `Room ${tab.id}`,
          url: tab.url || '',
          lastAccessed: tab.lastAccessed || 0,
          isGm: Boolean(res && res.isGm === true)
        };
        completed++;

        if (completed === rawTabs.length) {
          getTargetObrTabId((savedId) => {
            let targetTab = savedId ? summaries.find((t) => t.id === savedId) : null;
            if (!targetTab) {
              targetTab = selectBestObrTab(summaries);
              setTargetObrTabId(targetTab ? targetTab.id : null, () => {
                callback({
                  tabs: summaries,
                  targetObrTabId: targetTab ? targetTab.id : null,
                  targetTab: targetTab
                });
              });
            } else {
              callback({
                tabs: summaries,
                targetObrTabId: targetTab.id,
                targetTab: targetTab
              });
            }
          });
        }
      });
    });
  });
}

let cachedGrayscaleImageData = null;

async function getGrayscaleImageData() {
  if (cachedGrayscaleImageData) return cachedGrayscaleImageData;
  try {
    const url = chrome.runtime.getURL('icons/icon48.png');
    const resp = await fetch(url);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(48, 48);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, 48, 48);
    const imgData = ctx.getImageData(0, 0, 48, 48);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      d[i] = lum;
      d[i + 1] = lum;
      d[i + 2] = lum;
      d[i + 3] = Math.round(d[i + 3] * 0.55);
    }
    cachedGrayscaleImageData = imgData;
    return imgData;
  } catch (err) {
    log('Could not build grayscale icon:', err);
    return null;
  }
}

async function setToolbarState(isActive, titleText) {
  if (!chrome.action) return;
  if (chrome.action.setBadgeText) {
    chrome.action.setBadgeText({ text: '' });
  }
  if (chrome.action.setTitle) {
    chrome.action.setTitle({ title: titleText });
  }
  if (!chrome.action.setIcon) return;

  if (isActive) {
    chrome.action.setIcon({
      path: {
        16: 'icons/icon16.png',
        48: 'icons/icon48.png',
        128: 'icons/icon128.png'
      }
    });
  } else {
    const grayImageData = await getGrayscaleImageData();
    if (grayImageData) {
      chrome.action.setIcon({ imageData: { 48: grayImageData } });
    }
  }
}

function updateIconFromState(bridgeEnabled, targetTab, tabs) {
  if (!bridgeEnabled) {
    setToolbarState(false, 'Tiny Extension — Paused');
    return;
  }
  if (!tabs || tabs.length === 0) {
    setToolbarState(false, 'Tiny Extension — No Owlbear Tab');
    return;
  }
  const isGm = targetTab ? Boolean(targetTab.isGm) : tabs.some((t) => t.isGm);
  if (isGm) {
    setToolbarState(true, 'Tiny Extension — Ready (GM)');
  } else {
    setToolbarState(false, 'Tiny Extension — Player Mode (GM Only)');
  }
}

function updateIconState() {
  chrome.storage.local.get({ bridgeEnabled: true }, (settings) => {
    if (!settings.bridgeEnabled) {
      setToolbarState(false, 'Tiny Extension — Paused');
      return;
    }
    resolveObrTabsAndTarget(({ tabs, targetTab }) => {
      updateIconFromState(true, targetTab, tabs);
    });
  });
}

function getMirrorScriptId(pattern) {
  return 'tiny-ext-mirror-' + String(pattern).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function syncCustomMirrorsOnStartup() {
  if (!chrome.scripting || !chrome.scripting.registerContentScripts) return;
  chrome.storage.local.get({ customMirrors: [] }, (res) => {
    const mirrors = Array.isArray(res.customMirrors) ? res.customMirrors : [];
    if (mirrors.length === 0) return;

    chrome.scripting.getRegisteredContentScripts((existing) => {
      const existingIds = new Set((existing || []).map((s) => s.id));
      const toRegister = [];
      mirrors.forEach((pattern) => {
        const id = getMirrorScriptId(pattern);
        if (!existingIds.has(id)) {
          toRegister.push({
            id: id,
            matches: [pattern],
            js: ['statblock-reader.js', 'content-5etools.js'],
            runAt: 'document_end',
            persistAcrossSessions: true
          });
        }
      });

      if (toRegister.length > 0) {
        chrome.scripting.registerContentScripts(toRegister, () => {
          if (chrome.runtime.lastError) {
            log('Mirror sync error:', chrome.runtime.lastError.message);
          }
        });
      }
    });
  });
}

/**
 * Determine a clean generic label for a roll when showActionName is false:
 * - Recharge rolls -> "Recharge"
 * - Damage rolls -> "Damage"
 * - Saving throws -> "Saving Throw"
 * - Ability / Skill checks -> "Check"
 * - Attack / To-Hit rolls -> "Attack"
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
    chrome.storage.local.get({ bridgeEnabled: true }, (settings) => {
      resolveObrTabsAndTarget(({ tabs, targetObrTabId, targetTab }) => {
        updateIconFromState(Boolean(settings.bridgeEnabled), targetTab, tabs);
        const anyGm = targetTab ? Boolean(targetTab.isGm) : tabs.some((t) => t.isGm);
        sendResponse({
          hasObrTab: tabs.length > 0,
          count: tabs.length,
          isGm: anyGm,
          tabs: tabs.map((t) => ({ id: t.id, title: t.title, isGm: t.isGm })),
          targetObrTabId: targetObrTabId
        });
      });
    });
    return true;
  }

  if (message.action === 'SET_TARGET_OBR_TAB') {
    const nextTabId = Number(message.tabId) || null;
    setTargetObrTabId(nextTabId, () => {
      updateIconState();
      sendResponse({ success: true, targetObrTabId: nextTabId });
    });
    return true;
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

      resolveObrTabsAndTarget(({ tabs, targetTab }) => {
        if (!tabs || tabs.length === 0 || !targetTab) {
          log('No Owlbear Rodeo tab found.');
          sendResponse({
            success: false,
            error: 'No active Owlbear Rodeo tab found. Please make sure an Owlbear Rodeo room (https://www.owlbear.rodeo/) is open.'
          });
          return;
        }

        log(`Forwarding roll to single target Owlbear Rodeo tab ${targetTab.id}...`);
        sendRollToTab(targetTab, rollPayload, (ok, err) => {
          sendResponse({
            success: ok,
            successCount: ok ? 1 : 0,
            targetTabId: targetTab.id,
            errors: err ? [err] : undefined
          });
        });
      });
    });
    return true;
  }

  return false;
});

/**
 * Sends roll message to a single target tab, with automatic content script injection fallback
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
    matchingTabs.sort((a, b) => {
      const aIsRoom = (a.url || '').includes('/room/') ? 1 : 0;
      const bIsRoom = (b.url || '').includes('/room/') ? 1 : 0;
      if (bIsRoom !== aIsRoom) return bIsRoom - aIsRoom;
      return (b.lastAccessed || 0) - (a.lastAccessed || 0);
    });
    callback(matchingTabs);
  });
}

// Icon state & lifecycle listeners
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.bridgeEnabled) {
    updateIconState();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if ((changeInfo.status === 'complete' || changeInfo.url) && tab && isOwlbearUrl(tab.url)) {
    updateIconState();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  getTargetObrTabId((savedId) => {
    if (savedId === tabId) {
      setTargetObrTabId(null, () => updateIconState());
    } else {
      updateIconState();
    }
  });
});

chrome.runtime.onStartup.addListener(() => {
  updateIconState();
  syncCustomMirrorsOnStartup();
});

chrome.runtime.onInstalled.addListener(() => {
  updateIconState();
  syncCustomMirrorsOnStartup();
});

updateIconState();
