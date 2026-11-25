// [Tiny Extension] content-5etools.js - 5etools dice roller observer
const DEBUG = false;

function log(...args) {
  if (DEBUG) console.log('[Tiny Extension]', ...args);
}

// 5e standard damage types regex
const DAMAGE_TYPE_REGEX = /\b(acid|bludgeoning|cold|fire|force|lightning|necrotic|piercing|poison|psychic|radiant|slashing|thunder)\b/i;

function capitalizeWord(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function isFiveEToolsPage() {
  const host = (window.location.hostname || '').toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1') {
    return true;
  }
  if (document.querySelector('#pagecontent, .ve-stats, .out-roll-wrp, .out-roll-item')) {
    return true;
  }
  if (/5etools/i.test(document.title || '')) {
    return true;
  }
  const metaApp = document.querySelector('meta[name="application-name"]');
  if (metaApp && /5etools/i.test(metaApp.getAttribute('content') || '')) {
    return true;
  }
  return false;
}

// Click cache to bridge damage types, descriptions, and sibling damage rollers from statblocks into rollbox results
let cachedRollInfo = {
  damageType: '',
  attackName: '',
  description: '',
  attackSource: '',
  range: '',
  isDamage: false,
  isRecharge: false,
  siblingDamageElements: null,
  timestamp: 0
};

// Collection buffer for auto-triggered native 5etools damage rolls
let autoRollCollector = {
  active: false,
  baseRoll: null,
  expectedCount: 0,
  expectedTypes: [],
  collectedDamages: [],
  timer: null
};

function cacheClickedRollInfo(damageType, attackName, isDamage, description, siblingDamageElements, attackSource, range, isRecharge) {
  cachedRollInfo = {
    damageType: damageType || '',
    attackName: attackName || '',
    description: description || '',
    attackSource: attackSource || '',
    range: range || '',
    isDamage: Boolean(isDamage || damageType),
    isRecharge: Boolean(isRecharge),
    siblingDamageElements: (siblingDamageElements && siblingDamageElements.length > 0) ? siblingDamageElements : null,
    timestamp: Date.now()
  };
  log('Cached click roll info:', cachedRollInfo);
}

function getCachedRollInfo() {
  const age = Date.now() - cachedRollInfo.timestamp;
  if (age < 1500) { // 1500ms window covers normal render delays
    return cachedRollInfo;
  }
  return null;
}

/**
 * Inspect a single .roller / [data-packed-dice] element to extract packed JSON,
 * damage flag, formula, and damage type from its attributes and following sibling text.
 */
function inspectRollerElement(roller) {
  let packedData = null;
  let detectedDamageType = '';
  let isDamage = false;
  let isD20 = false;
  let formula = '';

  const packedAttr = roller.getAttribute('data-packed-dice');
  if (packedAttr) {
    try {
      packedData = JSON.parse(packedAttr);
      if (packedData.subType === 'damage') isDamage = true;
      if (packedData.subType === 'd20') isD20 = true;
      if (packedData.toRoll) {
        formula = String(packedData.toRoll).split(';')[0].trim();
        if (/d20/i.test(formula)) isD20 = true;
      }
      if (packedData.damageType) {
        detectedDamageType = capitalizeWord(packedData.damageType);
      }
    } catch (e) {}

    if (!detectedDamageType) {
      const match = packedAttr.match(DAMAGE_TYPE_REGEX);
      if (match) {
        detectedDamageType = capitalizeWord(match[1]);
        isDamage = true;
      }
    }
  }

  if (!formula) {
    formula = (roller.textContent || '').trim();
    if (/^\s*[+-]\s*\d+\s*$/.test(formula)) {
      isD20 = true;
    }
  }

  // Only scan following text for damage type if this is NOT a d20 To-Hit roller
  if (!isD20 && !detectedDamageType) {
    let textAfter = '';
    let sibling = roller.nextSibling;
    while (sibling && textAfter.length < 150) {
      if (sibling.nodeType === Node.ELEMENT_NODE && (sibling.classList?.contains('roller') || sibling.hasAttribute?.('data-packed-dice'))) {
        break;
      }
      textAfter += (sibling.textContent || '') + ' ';
      sibling = sibling.nextSibling;
    }

    const match = textAfter.match(DAMAGE_TYPE_REGEX);
    if (match) {
      detectedDamageType = capitalizeWord(match[1]);
      isDamage = true;
    }
  }

  const titleAttr = roller.getAttribute('title') || '';
  if (!isD20 && (/damage/i.test(titleAttr) || /damage/i.test(roller.textContent || ''))) {
    isDamage = true;
  }

  return { packedData, detectedDamageType, isDamage, isD20, formula };
}

/**
 * Strip explicit Save & Skill DCs (e.g. "DC 15 ") from description text.
 */
function stripDcsFromDescription(text) {
  if (!text) return '';
  return String(text)
    .replace(/\bDC\s*\d+\s*/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function isRechargeRoller(el, info) {
  const title = el.getAttribute('title') || '';
  const rollName = el.getAttribute('data-roll-name') || '';
  if (/\brecharge\b/i.test(title) || /\brecharge\b/i.test(rollName)) return true;
  if (info && info.packedData && /\brecharge\b/i.test(String(info.packedData.name || ''))) return true;
  if (el.closest('.rd__h, .entry-title-inner')) {
    const headingText = el.closest('.rd__h, .entry-title-inner').textContent || '';
    if (/\brecharge\b/i.test(headingText)) return true;
  }
  const prevText = el.previousSibling && el.previousSibling.textContent ? el.previousSibling.textContent : '';
  if (/\brecharge\s*$/i.test(prevText)) return true;
  return false;
}

/**
 * Find sibling damage roller DOM elements inside the same statblock action entry.
 * Broadly matches any non-d20, non-recharge sibling roller in the action container.
 */
function findSiblingDamageRollers(entryEl, clickedRoller) {
  if (!entryEl || !entryEl.querySelectorAll) return [];
  const rollers = entryEl.querySelectorAll('.roller, [data-packed-dice]');
  const damages = [];

  for (let i = 0; i < rollers.length; i++) {
    const el = rollers[i];
    if (el === clickedRoller || clickedRoller.contains(el) || el.contains(clickedRoller)) continue;

    const info = inspectRollerElement(el);
    if (info.isD20) continue;
    if (isRechargeRoller(el, info)) continue;
    if (!info.formula || !/\d*d\d+|\d+/.test(info.formula)) continue;

    damages.push({
      element: el,
      formula: info.formula,
      damageType: info.detectedDamageType || 'Damage'
    });
  }

  return damages;
}

function extractAttackMetadata(descText) {
  let attackSource = '';
  let range = '';
  if (!descText) return { attackSource, range };

  const srcMatch = descText.match(/\b((?:Melee|Ranged)\s+(?:Weapon|Spell)\s+Attack(?:\s+Roll)?)\b/i);
  if (srcMatch) attackSource = srcMatch[1];

  const rangeMatch = descText.match(/\b(?:reach|range)\s+([^.,;]+(?:\s*ft\.)?)/i);
  if (rangeMatch) range = rangeMatch[1].trim();

  return { attackSource, range };
}

/**
 * Lightweight click listener (capture phase) on rollable dice elements in statblocks
 * Captures damage type, action description, and sibling damage rollers for Auto-Roll Damage.
 */
function handleStatblockDiceClick(evt) {
  try {
    // Ignore programmatic clicks we dispatch to 5etools' damage rollers
    if (!evt.isTrusted) return;

    let target = evt.target;
    if (!target) return;
    if (target.nodeType !== Node.ELEMENT_NODE) {
      target = target.parentElement;
    }
    if (!target) return;

    const roller = target.closest('.roller, [data-packed-dice]');
    if (!roller) return;

    const info = inspectRollerElement(roller);
    const { detectedDamageType, isD20 } = info;
    const isRecharge = isRechargeRoller(roller, info);
    const isDamage = isRecharge ? false : info.isDamage;

    // Check for attack / action name
    let attackName = roller.getAttribute('data-roll-name') || '';
    if (!attackName && roller.parentElement) {
      const heading = roller.parentElement.querySelector('b, strong, .entry-title');
      if (heading) {
        attackName = heading.textContent.trim().replace(/[.:–—\s]+$/, '');
      }
    }

    // Locate parent action/trait container for description & sibling damages (2014 & 2024 statblocks)
    const statRoot = roller.closest('#pagecontent, .ve-stats, .stats');
    const entryBlock = roller.closest('.rd__b--3, .rd__b--4, .rd__b, .mon__stat-line');
    const paraBlock = roller.closest('p, li, .mon__stat-line');
    const trBlock = roller.closest('tr');
    const entryEl = paraBlock || entryBlock || (trBlock && !trBlock.querySelector('table') ? trBlock : null);

    // Extract sanitized description from statblock reader or parent entry (with DCs stripped)
    let description = '';
    if (attackName && typeof findStatblockActionDescription === 'function') {
      const matched = findStatblockActionDescription(attackName, statRoot);
      if (matched && matched.text) {
        description = matched.text;
      }
    }

    if (!description && entryEl && typeof extractCleanStatblockText === 'function') {
      let rawDesc = extractCleanStatblockText(entryEl);
      if (attackName && rawDesc.startsWith(attackName)) {
        rawDesc = rawDesc.slice(attackName.length).replace(/^[.:\s]+/, '').trim();
      }
      if (rawDesc) {
        description = rawDesc;
      }
    }

    description = stripDcsFromDescription(description);
    const { attackSource, range } = extractAttackMetadata(description);

    // If this is a To-Hit (d20) roller inside an action entry, capture sibling damage rollers
    let siblingDamageElements = [];
    if (!isDamage && isD20) {
      const searchContainers = [
        paraBlock,
        entryBlock,
        roller.parentElement,
        (trBlock && !trBlock.querySelector('table') ? trBlock : null)
      ].filter((el, idx, arr) => {
        if (!el || arr.indexOf(el) !== idx) return false;
        // Avoid scanning a section container that holds multiple distinct attack headings
        const headings = el.querySelectorAll ? el.querySelectorAll('.entry-title-inner') : [];
        return headings.length <= 1;
      });

      for (let c = 0; c < searchContainers.length; c++) {
        siblingDamageElements = findSiblingDamageRollers(searchContainers[c], roller);
        if (siblingDamageElements.length > 0) break;
      }
      log('Found sibling damages:', siblingDamageElements.map(d => ({ formula: d.formula, damageType: d.damageType })));
    }

    if (detectedDamageType || isDamage || isRecharge || attackName || description || siblingDamageElements.length > 0) {
      cacheClickedRollInfo(detectedDamageType, attackName, isDamage, description, siblingDamageElements, attackSource, range, isRecharge);
    }
  } catch (err) {
    log('Error in statblock click handler:', err);
  }
}

if (window.__5e2owl_5etools_injected) {
  log('5etools dice observer already active on this page.');
} else if (!isFiveEToolsPage()) {
  log('Skipping non-5etools localhost page.');
} else {
  window.__5e2owl_5etools_injected = true;
  log('5etools dice observer initialized on:', window.location.href);

  if (typeof readCurrentStatblock === 'function') {
    window.__read5eStatblock = readCurrentStatblock;
    if (DEBUG) {
      const pageContent = document.querySelector('#pagecontent');
      if (pageContent) {
        let lastLoggedMonster = '';
        const statObserver = new MutationObserver(() => {
          const parsed = readCurrentStatblock();
          if (parsed && parsed.name && parsed.name !== lastLoggedMonster) {
            lastLoggedMonster = parsed.name;
            log('Opened monster statblock:', parsed);
          }
        });
        statObserver.observe(pageContent, { childList: true, subtree: true });
      }
    }
  }

  // Register capture-phase click listener on document for statblock dice rolls
  document.addEventListener('click', handleStatblockDiceClick, true);

  // Mark any already existing roll items on page load so we do NOT re-broadcast historical rolls
  const existingItems = document.querySelectorAll('.out-roll-item');
  if (existingItems.length > 0) {
    log(`Ignoring ${existingItems.length} existing roll item(s) from previous rolls.`);
    existingItems.forEach((el) => {
      el.dataset.owlProcessed = 'true';
    });
  }

  // Handle a detected .out-roll-item node
  function processRollElement(item) {
    if (!item || item.dataset.owlProcessed === 'true') return;
    item.dataset.owlProcessed = 'true';

    // Allow a microtask tick for DOM children to fully populate if needed
    const roll = parseRollItem(item);
    if (!roll) {
      setTimeout(() => {
        const retryRoll = parseRollItem(item);
        if (retryRoll) {
          handleParsedRoll(retryRoll);
        } else {
          log('Skipped non-dice rollbox item:', item.textContent.trim());
        }
      }, 20);
      return;
    }

    handleParsedRoll(roll);
  }

  function handleParsedRoll(roll) {
    // Intercept auto-triggered native 5etools damage rolls during an active collection window
    if (autoRollCollector.active && roll.isDamage) {
      const idx = autoRollCollector.collectedDamages.length;
      const expectedType = autoRollCollector.expectedTypes[idx] || roll.damageType || 'Damage';
      autoRollCollector.collectedDamages.push({
        formula: roll.formula,
        breakdown: roll.breakdownText,
        parts: roll.parts,
        total: roll.total,
        damageType: expectedType,
        isCrit: Boolean(autoRollCollector.baseRoll && autoRollCollector.baseRoll.isCrit) || Boolean(roll.isCrit)
      });

      if (autoRollCollector.collectedDamages.length >= autoRollCollector.expectedCount) {
        if (autoRollCollector.timer) {
          clearTimeout(autoRollCollector.timer);
          autoRollCollector.timer = null;
        }
        flushAutoRollCollector();
      }
      return;
    }

    dispatchParsedRoll(roll);
  }

  function flushAutoRollCollector() {
    if (!autoRollCollector.active) return;
    const baseRoll = autoRollCollector.baseRoll;
    const collected = autoRollCollector.collectedDamages.slice();

    autoRollCollector.active = false;
    autoRollCollector.baseRoll = null;
    autoRollCollector.expectedCount = 0;
    autoRollCollector.expectedTypes = [];
    autoRollCollector.collectedDamages = [];
    autoRollCollector.timer = null;

    if (!baseRoll) return;
    if (collected.length > 0) {
      baseRoll.damages = collected;
    }
    sendRollToBackground(baseRoll);
  }

  function sendRollToBackground(roll) {
    log('Parsed 5etools roll:', roll);
    try {
      chrome.runtime.sendMessage({
        action: 'SEND_ROLL',
        roll: roll
      }, (response) => {
        if (chrome.runtime.lastError) {
          const errMsg = chrome.runtime.lastError.message;
          if (DEBUG) console.warn('[Tiny Extension] Error sending roll to background:', errMsg);
        } else {
          log('Bridge acknowledged roll delivery:', response);
        }
      });
    } catch (err) {
      if (DEBUG) console.warn('[Tiny Extension] Extension context disconnected:', err.message);
    }
  }

  function dispatchParsedRoll(roll) {
    chrome.storage.local.get({
      bridgeEnabled: true,
      autoRollDamage: true
    }, (settings) => {
      if (!settings.bridgeEnabled) {
        log('Bridge is paused via user toggle. Roll ignored.');
        return;
      }

      const damageTargets = roll.pendingDamageElements;
      delete roll.pendingDamageElements;

      // Trigger 5etools' native damage roller(s) and buffer results into one combined card
      if (settings.autoRollDamage && damageTargets && damageTargets.length > 0) {
        if (autoRollCollector.active) {
          flushAutoRollCollector();
        }

        autoRollCollector = {
          active: true,
          baseRoll: roll,
          expectedCount: damageTargets.length,
          expectedTypes: damageTargets.map(d => d.damageType || 'Damage'),
          collectedDamages: [],
          timer: setTimeout(flushAutoRollCollector, 250)
        };

        for (let i = 0; i < damageTargets.length; i++) {
          const dmgEl = damageTargets[i].element;
          if (dmgEl && typeof dmgEl.dispatchEvent === 'function') {
            dmgEl.dispatchEvent(new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              shiftKey: Boolean(roll.isCrit)
            }));
          }
        }
        return;
      }

      sendRollToBackground(roll);
    });
  }

  // Check an added DOM node and any of its descendants
  function scanNodeForRolls(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;

    if (node.classList && node.classList.contains('out-roll-item')) {
      processRollElement(node);
    }

    if (node.querySelectorAll) {
      const children = node.querySelectorAll('.out-roll-item');
      for (let i = 0; i < children.length; i++) {
        processRollElement(children[i]);
      }
    }
  }

  // Observe document.body for dynamic rollbox creation and roll additions
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (let i = 0; i < mutation.addedNodes.length; i++) {
          const addedNode = mutation.addedNodes[i];
          scanNodeForRolls(addedNode);
          scanNodeForConditions(addedNode);
        }
      }
    }
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });

  // Initial scan for open condition entries (Conditions & Diseases page or hover windows)
  scanNodeForConditions(document.body || document.documentElement);

  log('5etools MutationObserver is active and listening for dice rolls.');
}

const CONDITION_NAME_REGEX = /^(Blinded|Charmed|Deafened|Exhaustion|Frightened|Grappled|Incapacitated|Invisible|Paralyzed|Petrified|Poisoned|Prone|Restrained|Stunned|Unconscious|Concentration|Surprise)$/i;

/**
 * Scan a DOM node for 5etools condition containers (#pagecontent on conditionsdiseases or .hwin hover windows)
 * and inject an unobtrusive "Send to Owl20" button guarded by data-owl20-injected.
 */
function scanNodeForConditions(root) {
  if (!root || root.nodeType !== Node.ELEMENT_NODE) return;

  const candidates = [];
  if (root.id === 'pagecontent' || (root.classList && root.classList.contains('hwin'))) {
    candidates.push(root);
  }
  if (root.querySelectorAll) {
    const found = root.querySelectorAll('#pagecontent, .hwin');
    for (let i = 0; i < found.length; i++) {
      candidates.push(found[i]);
    }
  }

  for (let i = 0; i < candidates.length; i++) {
    tryInjectConditionButton(candidates[i]);
  }
}

function tryInjectConditionButton(container) {
  if (!container || container.getAttribute('data-owl20-injected') === 'true') return;
  if (container.querySelector('.initial-message')) return;

  const nameEl = container.querySelector('.stats-name');
  if (!nameEl) return;

  // Extract clean condition name without source badge
  const nameClone = nameEl.cloneNode(true);
  const sources = nameClone.querySelectorAll('.stats-source, .owl20-send-condition-btn');
  for (let i = 0; i < sources.length; i++) sources[i].remove();
  const conditionName = (nameClone.textContent || '').trim();
  if (!conditionName) return;

  const isConditionsPage = window.location.pathname.toLowerCase().includes('conditionsdiseases');
  const isConditionTitle = CONDITION_NAME_REGEX.test(conditionName);
  const isMonsterStatblock = Boolean(container.querySelector('.mon__wrp-size-type-align'));

  if (isMonsterStatblock || (!isConditionsPage && !isConditionTitle)) {
    return;
  }

  // Mark container so button is never duplicated
  container.setAttribute('data-owl20-injected', 'true');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'owl20-send-condition-btn';
  btn.textContent = 'Send to Owl20';
  btn.title = 'Send condition description to Owl20';
  btn.style.cssText = 'margin-left: 8px; padding: 2px 7px; font-size: 11px; font-weight: 600; line-height: 1.4; border-radius: 4px; border: 1px solid #bb99ff; background: #2b3044; color: #f0f2f5; cursor: pointer; vertical-align: middle;';

  btn.addEventListener('click', (evt) => {
    evt.preventDefault();
    evt.stopPropagation();

    chrome.storage.local.get({
      bridgeEnabled: true,
      sendDescriptions: true,
      showCreatureName: false
    }, (settings) => {
      if (!settings.bridgeEnabled || !settings.sendDescriptions) {
        log('Send to Owl20 clicked while bridge or sendDescriptions is disabled.');
        return;
      }

      const description = extractConditionDescription(container, conditionName);
      if (!description) return;

      const payload = {
        isCondition: true,
        character: !settings.showCreatureName ? 'DM' : 'Condition',
        title: conditionName,
        description: description
      };

      chrome.runtime.sendMessage({ action: 'SEND_ROLL', roll: payload }, (response) => {
        if (chrome.runtime.lastError) {
          if (DEBUG) console.warn('[Tiny Extension] Error sending condition:', chrome.runtime.lastError.message);
          return;
        }
        if (response && response.success) {
          const prevText = btn.textContent;
          btn.textContent = 'Sent!';
          setTimeout(() => {
            btn.textContent = prevText;
          }, 1200);
        }
      });
    });
  });

  // Place button next to the condition title
  const targetParent = nameEl.closest('th, .hwin__wrp-title, .stats-name-wrap') || nameEl.parentElement || nameEl;
  targetParent.appendChild(btn);
}

function extractConditionDescription(container, conditionName) {
  const rows = container.querySelectorAll('tr');
  const parts = [];

  if (rows.length > 0) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.querySelector('.stats-name, .ve-tbl-border, .stats-source-footer')) continue;
      const text = typeof extractCleanStatblockText === 'function'
        ? extractCleanStatblockText(row)
        : (row.textContent || '').trim();
      if (!text || text === conditionName) continue;
      if (/^Source:/i.test(text)) continue;
      parts.push(text);
    }
  } else {
    const bodyEl = container.querySelector('.rd__b, .hwin__wrp-stats, .ve-stats') || container;
    const text = typeof extractCleanStatblockText === 'function'
      ? extractCleanStatblockText(bodyEl)
      : (bodyEl.textContent || '').trim();
    if (text) parts.push(text);
  }

  return parts.join('\n').trim();
}

/**
 * Extract damage type and clean attack name
 */
function extractDamageInfo(rawTitleText, itemTooltip, formulaStr, isDamage) {
  let damageType = '';
  let cleanTitle = rawTitleText || '';

  const searchStr = `${rawTitleText} ${itemTooltip} ${formulaStr}`;
  const match = searchStr.match(DAMAGE_TYPE_REGEX);
  if (match) {
    damageType = capitalizeWord(match[1]);
  }

  if (isDamage) {
    // Strip damage types and trailing words like "damage" from the clean title
    cleanTitle = cleanTitle
      .replace(/\s*\(\s*(acid|bludgeoning|cold|fire|force|lightning|necrotic|piercing|poison|psychic|radiant|slashing|thunder)\s*(damage)?\s*\)/gi, '')
      .replace(/\s*[-:]\s*(acid|bludgeoning|cold|fire|force|lightning|necrotic|piercing|poison|psychic|radiant|slashing|thunder)\s*(damage)?/gi, '')
      .replace(/\b(acid|bludgeoning|cold|fire|force|lightning|necrotic|piercing|poison|psychic|radiant|slashing|thunder)\s*(damage)?\b/gi, '')
      .trim();

    cleanTitle = cleanTitle.replace(/^[-:–—\s]+|[-:–—\s]+$/g, '').trim();

    if (!cleanTitle) {
      cleanTitle = 'Damage';
    }
  }

  return { cleanTitle, damageType };
}

/**
 * Extract structured die groups and modifiers (Beyond20 `parts` format)
 * from 5etools' formula string and breakdown DOM span.
 */
function parseRollParts(formula, breakdownSpan, breakdownText, diceRolls) {
  if (!formula) return [];

  // 1. Collect all individual bracketed die values from breakdownSpan (preserving dropped flags & inner max/min spans)
  const dieValues = [];
  if (breakdownSpan && breakdownSpan.innerHTML) {
    const html = breakdownSpan.innerHTML;
    // Match either a dropped span containing [N] or any [ ... ] (which may wrap <span class="rll__max--muted">N</span>)
    const re = /(<span[^>]*class="[^"]*rll__dropped[^"]*"[^>]*>[\s\S]*?<\/span>)|\[([^\]]+)\]/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (m[1]) {
        const innerRe = /\[([^\]]+)\]/g;
        let innerM;
        while ((innerM = innerRe.exec(m[1])) !== null) {
          const num = parseInt(innerM[1].replace(/<[^>]+>/g, '').trim(), 10);
          if (!isNaN(num)) {
            dieValues.push({ roll: num, discarded: true });
          }
        }
      } else if (m[2]) {
        const num = parseInt(m[2].replace(/<[^>]+>/g, '').trim(), 10);
        if (!isNaN(num)) {
          dieValues.push({ roll: num, discarded: false });
        }
      }
    }
  } else if (breakdownText) {
    const re = /\[(\d+)\]/g;
    let m;
    while ((m = re.exec(breakdownText)) !== null) {
      dieValues.push({ roll: parseInt(m[1], 10), discarded: false });
    }
  }

  // 2. Walk formula terms (dice groups and flat modifiers)
  const parts = [];
  const tokenRe = /([+-]?)\s*(?:(\d*)d(\d+)((?:kh|kl|dh|dl)\d+)?|(\d+))/gi;
  const cleanFormula = String(formula).trim();
  let valCursor = 0;
  let tm;

  while ((tm = tokenRe.exec(cleanFormula)) !== null) {
    if (!tm[0]) break;
    const op = tm[1] === '-' ? '-' : '+';

    if (tm[3]) {
      // Dice group: NdM[kh/kl/dh/dl]
      const amount = tm[2] ? parseInt(tm[2], 10) : 1;
      const faces = parseInt(tm[3], 10);
      const modSuffix = tm[4] || '';
      const groupFormula = `${amount}d${faces}${modSuffix}`;
      let rolls = [];

      if (faces === 20 && Array.isArray(diceRolls) && diceRolls.length > 0 && parts.length === 0) {
        rolls = diceRolls.map((d) => ({
          roll: d.dieVal,
          faces: 20,
          discarded: Boolean(d.isDiscarded),
          critical: Boolean(d.isCrit) || d.dieVal === 20,
          critical_failure: Boolean(d.isFumble) || d.dieVal === 1
        }));
        valCursor += diceRolls.length;
      } else {
        for (let i = 0; i < amount && valCursor < dieValues.length; i++) {
          const dv = dieValues[valCursor++];
          rolls.push({
            roll: dv.roll,
            faces: faces,
            discarded: Boolean(dv.discarded),
            critical: dv.roll === faces,
            critical_failure: dv.roll === 1
          });
        }
      }

      parts.push({
        type: 'dice',
        amount: amount,
        faces: faces,
        formula: groupFormula,
        operator: op,
        rolls: rolls
      });
    } else if (tm[5]) {
      // Numeric modifier
      const value = parseInt(tm[5], 10);
      parts.push({
        type: 'modifier',
        value: value,
        operator: op,
        formula: `${op} ${value}`
      });
    }
  }

  return parts;
}

/**
 * Parse an .out-roll-item element according to 5etools render-dice.js structure
 */
function parseRollItem(item) {
  // Must have a .roll element to be a valid dice roll (filters out /help or /clear messages)
  const rollEle = item.querySelector('.roll');
  if (!rollEle) return null;

  // 1. Creature / Roller Name
  let character = '';
  const wrp = item.closest('.out-roll-wrp');
  if (wrp && wrp.getAttribute('data-rollbox-last-rolled-by-name')) {
    character = wrp.getAttribute('data-rollbox-last-rolled-by-name').trim();
  }

  if (!character && wrp) {
    const prev = wrp.previousElementSibling;
    if (prev && prev.classList.contains('out-roll-id')) {
      character = prev.textContent.trim();
    }
  }

  const rawTitle = item.getAttribute('title') || '';
  const titleParts = rawTitle.split(/\s*—\s*/);

  if (!character && titleParts.length > 0 && titleParts[0].trim()) {
    character = titleParts[0].trim();
  }
  if (!character) character = 'Anon';

  // 2. Roll Type / Label
  let rawLabel = '';
  const labelEle = item.querySelector('.roll-label');
  if (labelEle) {
    rawLabel = labelEle.textContent.trim().replace(/:\s*$/, '');
  } else if (titleParts.length > 1 && titleParts[1].trim()) {
    rawLabel = titleParts[1].trim();
  }

  // 3. Formula
  let formula = '';
  const formulaEle = item.querySelector('.ve-italic.ve-small') || item.querySelector('.ve-muted.ve-italic');
  if (formulaEle) {
    formula = formulaEle.textContent.trim();
  } else if (titleParts.length > 2 && titleParts[2].trim()) {
    formula = titleParts[2].trim();
  }

  // 4. Total and Crit / Fumble flags on total element
  const totalText = rollEle.textContent.trim();
  const total = !isNaN(Number(totalText)) ? Number(totalText) : totalText;
  const isCritOverall = rollEle.classList.contains('roll-max');
  const isFumbleOverall = rollEle.classList.contains('roll-min');

  // 5. Individual dice breakdown container (second .ve-muted span after ⇒)
  let breakdownSpan = null;
  let breakdownText = '';
  const mutedSpans = item.querySelectorAll('span.ve-muted');
  for (let i = 0; i < mutedSpans.length; i++) {
    const span = mutedSpans[i];
    if (!span.classList.contains('ve-italic')) {
      breakdownSpan = span;
      breakdownText = span.textContent.trim();
      break;
    }
  }

  // 6. Roll mode flags & Damage detection
  const cachedClick = getCachedRollInfo();

  const isAdvantage = formula.includes('dl1') || formula.includes('kh1');
  const isDisadvantage = formula.includes('dh1') || formula.includes('kl1');
  const isD20 = formula.includes('d20') || (/^\s*d20/i).test(formula);

  const hasDamageType = DAMAGE_TYPE_REGEX.test(rawLabel) ||
    DAMAGE_TYPE_REGEX.test(rawTitle) ||
    DAMAGE_TYPE_REGEX.test(formula) ||
    Boolean(cachedClick && cachedClick.damageType);

  const isRecharge = Boolean(cachedClick && cachedClick.isRecharge) ||
    (!hasDamageType && !/damage/i.test(rawLabel) && /^\s*1?d6\s*$/i.test(formula) && (/\brecharge\b/i.test(rawLabel) || /\brecharge\b/i.test(rawTitle)));

  let isDamage = !isD20 && !isRecharge && (
    /damage/i.test(rawLabel) ||
    hasDamageType ||
    Boolean(cachedClick && cachedClick.isDamage) ||
    /d(4|6|8|10|12)\b/i.test(formula)
  );

  // 7. Extract damage type and clean title
  let { cleanTitle, damageType } = extractDamageInfo(rawLabel, rawTitle, formula, isDamage);

  // Fallback to cached damage type from user click if not found in rollbox text
  if (isDamage && !damageType && cachedClick && cachedClick.damageType) {
    damageType = cachedClick.damageType;
  }

  // Use cached attack name if clean title is generic ("Damage" or "Roll") or empty
  if (cachedClick && cachedClick.attackName && (!cleanTitle || cleanTitle === 'Damage' || cleanTitle === 'Roll')) {
    cleanTitle = cachedClick.attackName;
  }

  // Resolve sanitized action/attack description (from click cache or statblock reader)
  let description = (cachedClick && cachedClick.description) ? cachedClick.description : '';
  if (!description && cleanTitle && cleanTitle !== 'Damage' && cleanTitle !== 'Roll' && typeof findStatblockActionDescription === 'function') {
    const matched = findStatblockActionDescription(cleanTitle);
    if (matched && matched.text) {
      description = matched.text;
    }
  }
  description = stripDcsFromDescription(description);

  // Resolve sibling damage roller elements for native Auto-Roll Damage on To-Hit rolls
  const pendingDamageElements = (!isDamage && isD20 && cachedClick && cachedClick.siblingDamageElements)
    ? cachedClick.siblingDamageElements
    : undefined;
  const attackSource = (cachedClick && cachedClick.attackSource) ? cachedClick.attackSource : undefined;
  const range = (cachedClick && cachedClick.range) ? cachedClick.range : undefined;

  // Detect saving throw ability (e.g., "Dex Save" -> "Dexterity")
  let saveAbility;
  const saveMatch = (cleanTitle || rawTitle).match(/\b(str(?:ength)?|dex(?:terity)?|con(?:stitution)?|int(?:elligence)?|wis(?:dom)?|cha(?:risma)?)\s+sav(?:e|ing throw)\b/i);
  if (saveMatch) {
    const abMap = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };
    saveAbility = abMap[saveMatch[1].slice(0, 3).toLowerCase()] || saveMatch[1];
  }

  // Clear click cache once consumed
  if (cachedClick) {
    cachedRollInfo.timestamp = 0;
  }

  // 8. Extract modifier from formula (e.g. "2d20dl1+4" -> +4, "2d20dh1-2" -> -2)
  const modMatch = formula.match(/([+-]\s*\d+)\s*$/);
  const modifier = modMatch ? parseInt(modMatch[1].replace(/\s+/g, ''), 10) : 0;

  // 9. Parse individual dice for Advantage / Disadvantage or Single D20
  const diceRolls = [];

  if (isD20 && (isAdvantage || isDisadvantage) && breakdownSpan) {
    // 5etools marks dropped dice with .rll__dropped
    const droppedEl = breakdownSpan.querySelector('.rll__dropped');
    if (droppedEl) {
      const droppedVal = parseInt(droppedEl.textContent.replace(/\D/g, ''), 10);
      const droppedIsCrit = droppedEl.querySelector('.rll__max--muted') !== null || droppedVal === 20;
      const droppedIsFumble = droppedEl.querySelector('.rll__min--muted') !== null || droppedVal === 1;
      const droppedTotal = droppedVal + modifier;

      const keptVal = typeof total === 'number' ? total - modifier : total;
      const keptIsCrit = isCritOverall || keptVal === 20;
      const keptIsFumble = isFumbleOverall || keptVal === 1;
      const keptTotal = total;

      // Determine order of dice in breakdown HTML
      const droppedHtml = droppedEl.outerHTML;
      const isDroppedFirst = breakdownSpan.innerHTML.indexOf(droppedHtml) < breakdownSpan.innerHTML.indexOf('[' + keptVal + ']');

      const droppedDieObj = {
        dieVal: droppedVal,
        totalVal: droppedTotal,
        isDiscarded: true,
        isCrit: droppedIsCrit,
        isFumble: droppedIsFumble
      };

      const keptDieObj = {
        dieVal: keptVal,
        totalVal: keptTotal,
        isDiscarded: false,
        isCrit: keptIsCrit,
        isFumble: keptIsFumble
      };

      if (isDroppedFirst) {
        diceRolls.push(droppedDieObj, keptDieObj);
      } else {
        diceRolls.push(keptDieObj, droppedDieObj);
      }
    }
  }

  // Fallback for standard single d20 roll
  if (isD20 && diceRolls.length === 0) {
    const dieVal = typeof total === 'number' ? total - modifier : total;
    diceRolls.push({
      dieVal: dieVal,
      totalVal: total,
      isDiscarded: false,
      isCrit: isCritOverall || dieVal === 20,
      isFumble: isFumbleOverall || dieVal === 1
    });
  }

  const parts = parseRollParts(formula, breakdownSpan, breakdownText, diceRolls);

  if (isRecharge) {
    parts.forEach((part) => {
      if (part.type === 'dice' && Array.isArray(part.rolls)) {
        part.rolls.forEach((r) => {
          r.critical = false;
          r.critical_failure = false;
        });
      }
    });
    diceRolls.forEach((d) => {
      d.isCrit = false;
      d.isFumble = false;
    });
  }

  // Compute rechargeSuccess when isRecharge is true
  let rechargeSuccess;
  if (isRecharge) {
    const itemText = item.textContent || '';
    if (/\bdid not recharge\b/i.test(itemText)) {
      rechargeSuccess = false;
    } else if (/\brecharged\b/i.test(itemText)) {
      rechargeSuccess = true;
    } else {
      const targetMatch = (rawTitle || rawLabel).match(/recharge\s*(\d+)/i);
      if (targetMatch && typeof total === 'number') {
        rechargeSuccess = total >= parseInt(targetMatch[1], 10);
      }
    }
  }

  // Determine crit/fumble from the actual kept d20 die value (never crit/fumble on Recharge rolls)
  const isCritFinal = isRecharge
    ? false
    : (isD20 ? diceRolls.some(d => !d.isDiscarded && (d.isCrit || d.dieVal === 20)) : isCritOverall);
  const isFumbleFinal = isRecharge
    ? false
    : (isD20 ? diceRolls.some(d => !d.isDiscarded && (d.isFumble || d.dieVal === 1)) : isFumbleOverall);

  return {
    character: character,
    title: (isRecharge && (!cleanTitle || cleanTitle === 'Damage' || cleanTitle === 'Roll'))
      ? 'Recharge'
      : (cleanTitle || (isRecharge ? 'Recharge' : (isDamage ? 'Damage' : 'Roll'))),
    formula: formula,
    total: total,
    modifier: modifier,
    isCrit: isCritFinal,
    isFumble: isFumbleFinal,
    isAdvantage: isAdvantage,
    isDisadvantage: isDisadvantage,
    isDamage: isDamage,
    isRecharge: isRecharge,
    rechargeSuccess: rechargeSuccess,
    damageType: damageType || undefined,
    pendingDamageElements: pendingDamageElements,
    attackSource: attackSource,
    range: range,
    saveAbility: saveAbility,
    description: description || undefined,
    breakdownText: breakdownText,
    diceRolls: diceRolls,
    parts: parts,
    rawTitle: rawTitle
  };
}
