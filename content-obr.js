// [Tiny Extension] content-obr.js - Injected into Owlbear Rodeo tabs
const DEBUG = false;

function log(...args) {
  if (DEBUG) console.log('[Tiny Extension]', ...args);
}

function isOwlbearGm() {
  const GM_ONLY_LABELS = new Set([
    'scenes',
    'maps',
    'extras (ctrl + e)',
    'player settings'
  ]);
  const elements = document.querySelectorAll('button[aria-label], [title]');
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
    const title = (el.getAttribute('title') || '').trim().toLowerCase();
    if (GM_ONLY_LABELS.has(aria) || GM_ONLY_LABELS.has(title)) {
      return true;
    }
  }
  return false;
}

if (window.__5e2owl_obr_injected) {
  log('Owlbear Rodeo bridge script already loaded on this page.');
} else {
  window.__5e2owl_obr_injected = true;
  log('Owlbear Rodeo bridge content script initialized on:', window.location.href);

  // Listen on document for Beyond20_Roll events to log when they are dispatched/observed
  document.addEventListener('Beyond20_Roll', (event) => {
    log('Observed Beyond20_Roll CustomEvent on document:', event.detail);
  });

  // Listen for messages from background.js
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    log('content-obr received message:', message);

    if (message.action === 'PING') {
      sendResponse({ pong: true, href: window.location.href, isGm: isOwlbearGm() });
      return true;
    }

    if (message.action === 'DISPATCH_ROLL') {
      if (!isOwlbearGm()) {
        log('Blocked DISPATCH_ROLL: current user is not a GM in Owlbear Rodeo.');
        sendResponse({
          success: false,
          dispatched: false,
          blocked: true,
          error: 'Not GM in Owlbear Rodeo'
        });
        return true;
      }

      try {
        const rollData = formatBeyond20Roll(message.roll);
        log('Converted roll to Beyond20 rollData format:', rollData);

        // Dispatch Beyond20_Roll CustomEvent on document for the Owl20 extension to capture
        // Important: Owl20 expects event.detail to be an array: [rollData]
        const customEvent = new CustomEvent('Beyond20_Roll', {
          bubbles: true,
          composed: true,
          detail: [rollData]
        });

        document.dispatchEvent(customEvent);
        log('Successfully dispatched Beyond20_Roll event on document with detail:', [rollData]);

        // Check for any Owl20 iframes currently on the page
        const iframes = Array.from(document.querySelectorAll('iframe')).filter(
          (iframe) => (iframe.src || '').includes('owl20') || (iframe.src || '').includes('localhost')
        );
        log(`Found ${iframes.length} Owl20 iframe(s) in Owlbear Rodeo DOM.`);

        sendResponse({
          success: true,
          dispatched: true,
          owl20IframesDetected: iframes.length,
          character: rollData.character,
          title: rollData.title
        });
      } catch (err) {
        console.error('[Tiny Extension] Error formatting or dispatching roll:', err);
        sendResponse({
          success: false,
          error: err.message
        });
      }
    }

    return true; // Keep message channel open for response
  });
}

/**
 * Format incoming roll into exact Beyond20 rollData schema expected by Owl20
 */
function formatBeyond20Roll(roll) {
  const character = (roll && roll.character) ? String(roll.character) : "DM";
  const title = (roll && roll.title) ? String(roll.title) : "Roll";
  const formula = (roll && roll.formula) ? String(roll.formula) : "1d20";
  const total = (roll && roll.total !== undefined) ? roll.total : 0;
  const result = (roll && roll.result !== undefined) ? roll.result : total;
  const whisper = Boolean(roll && roll.whisper);
  const isAdvantage = Boolean(roll && roll.isAdvantage);
  const isDisadvantage = Boolean(roll && roll.isDisadvantage);
  const isCrit = Boolean(roll && roll.isCrit);
  const isFumble = Boolean(roll && roll.isFumble);
  const isDamage = Boolean(roll && roll.isDamage);
  const isCondition = Boolean(roll && roll.isCondition);
  const hasCombinedDamages = Array.isArray(roll && roll.damages) && roll.damages.length > 0;
  const isRedacted = !isCondition && ((roll && roll.sendDescriptions === false) || (roll && roll.description === '[REDACTED]'));
  const description = isRedacted ? '[REDACTED]' : ((roll && roll.description) ? String(roll.description).trim() : '');
  const damageType = (roll && roll.damageType) ? String(roll.damageType).trim() : '';
  const damageLabel = damageType || 'Damage';

  // If pre-rendered HTML is already provided, use it; otherwise build Beyond20-compliant HTML card
  const html = (roll && roll.html) ? roll.html : buildBeyond20Html(roll);

  const rollObj = isCondition ? undefined : {
    dice: formula,
    formula: formula,
    result: result,
    total: total,
    advantage: isAdvantage ? 1 : (isDisadvantage ? -1 : 0),
    is_critical: isCrit,
    is_critical_failure: isFumble,
    parts: (roll && Array.isArray(roll.parts) && roll.parts.length > 0) ? roll.parts : undefined,
    dice_rolls: (roll && roll.diceRolls && roll.diceRolls.length > 0)
      ? roll.diceRolls.map(d => ({
          die: 20,
          roll: d.dieVal,
          total: d.totalVal,
          discarded: Boolean(d.isDiscarded),
          critical: Boolean(d.isCrit),
          critical_failure: Boolean(d.isFumble)
        }))
      : undefined
  };

  const beyond20Payload = {
    action: 'rendered-roll',
    character: character,
    title: title,
    whisper: whisper,
    html: html,
    description: description || undefined,
    roll: rollObj
  };

  if (hasCombinedDamages) {
    beyond20Payload.type = 'attack';
    beyond20Payload['to-hit'] = rollObj;
    beyond20Payload.to_hit = rollObj;
    beyond20Payload.attack_rolls = rollObj ? [rollObj] : undefined;
    if (!isRedacted) {
      beyond20Payload['attack-source'] = roll.attackSource || undefined;
      beyond20Payload.range = roll.range || undefined;
    }
    beyond20Payload.damages = roll.damages.map(d => ({
      damage_type: d.damageType || 'Damage',
      label: formatInlineDamageLabel(d.damageType),
      damage: d.total,
      total: d.total,
      formula: d.formula,
      breakdown: d.breakdown,
      parts: Array.isArray(d.parts) ? d.parts : undefined,
      is_critical: Boolean(d.isCrit)
    }));
    beyond20Payload.damage_rolls = roll.damages.map(d => ([
      formatInlineDamageLabel(d.damageType),
      {
        dice: d.formula,
        formula: d.formula,
        total: d.total,
        result: d.total,
        parts: Array.isArray(d.parts) ? d.parts : undefined,
        is_critical: Boolean(d.isCrit || isCrit)
      }
    ]));
    beyond20Payload['damage-types'] = beyond20Payload.damages.map(d => d.damage_type);
    beyond20Payload.damage_types = beyond20Payload['damage-types'];
  } else if (!isRedacted && roll && roll.saveAbility) {
    beyond20Payload.type = 'saving-throw';
    beyond20Payload['save-ability'] = roll.saveAbility;
    beyond20Payload.save_ability = roll.saveAbility;
  } else if (isDamage) {
    beyond20Payload.damage_type = damageLabel;
    beyond20Payload.damage_types = [damageLabel];
    beyond20Payload.damages = [
      {
        damage_type: damageLabel,
        damage: total,
        total: total,
        label: damageLabel
      }
    ];
    if (beyond20Payload.roll) {
      beyond20Payload.roll.damage_type = damageLabel;
      beyond20Payload.roll.damage_types = [damageLabel];
      beyond20Payload.roll.damages = beyond20Payload.damages;
    }
  }

  return beyond20Payload;
}

function formatDescriptionHtml(desc) {
  if (!desc) return '';
  return escapeHtml(desc).replace(/\r?\n/g, '<br>');
}

function formatInlineDamageLabel(damageType) {
  const raw = damageType ? String(damageType).trim() : '';
  if (!raw || raw.toLowerCase() === 'damage') return 'Damage';
  return /damage$/i.test(raw) ? raw : `${raw} Damage`;
}

function buildTooltipBox(visibleHtml, formula, breakdown, inline = false, parts = null) {
  const hasParts = Array.isArray(parts) && parts.length > 0;
  const formulaHtml = formula ? `<div class="dice-formula beyond20-roll-formula">${escapeHtml(formula)}</div>` : '';
  let bodyHtml = '';

  if (hasParts) {
    let allDieBoxes = '';
    parts.forEach((part) => {
      if (part.type === 'dice') {
        allDieBoxes += (part.rolls || []).map((r) => {
          let cls = 'beyond20-roll-detail-normal';
          if (r.discarded) cls = 'beyond20-roll-detail-discarded';
          else if (r.critical) cls = 'beyond20-roll-detail-crit';
          else if (r.critical_failure) cls = 'beyond20-roll-detail-fail';
          return `<div class="beyond20-roll-die-result"><span class="${cls}">${escapeHtml(String(r.roll))}</span></div>`;
        }).join('');
      }
    });
    if (allDieBoxes) {
      bodyHtml = `<div class="beyond20-dice-roller-content"><div class="beyond20-roll-dice"><div class="beyond20-roll-dice-rolls">${allDieBoxes}</div></div></div>`;
    } else if (breakdown) {
      bodyHtml = `<div class="dice-tooltip">${escapeHtml(breakdown)}</div>`;
    }
  } else if (breakdown) {
    bodyHtml = `<div class="dice-tooltip">${escapeHtml(breakdown)}</div>`;
  }

  if (!formulaHtml && !bodyHtml) {
    return visibleHtml;
  }
  const inlineStyle = inline ? ' style="display:inline-block"' : '';
  return `<div class="beyond20-tooltip"${inlineStyle}>` +
    visibleHtml +
    `<div class="beyond20-tooltip-content">` +
      `<div class="dice-roll">${formulaHtml}${bodyHtml}</div>` +
    `</div>` +
  `</div>`;
}

/**
 * Generate Beyond20 HTML card structure styled with Owl20 CSS classes:
 * - .beyond20-roll-cells flex container holding multiple .beyond20-roll-cell boxes
 * - .beyond20-tooltip / .beyond20-tooltip-content for hover-only dice formula & breakdown
 * - .beyond20-roll-detail-discarded for dropped dice in advantage / disadvantage (strikethrough)
 * - .beyond20-roll-detail-crit for natural 20 / max (green text + [CRIT] prefix)
 * - .beyond20-roll-detail-fail for natural 1 / min (red text)
 * - .beyond20-roll-detail-normal for standard kept rolls
 * - .beyond20-total-damage.beyond20-critical-damage for damage rolls with damage type beside total
 * - <details><summary> + .beyond20-description for collapsible action descriptions
 */
function buildBeyond20Html(roll) {
  const isCondition = Boolean(roll && roll.isCondition);
  const isDamage = Boolean(roll && roll.isDamage);
  const total = (roll && roll.total !== undefined) ? roll.total : '';
  const formula = (roll && roll.formula) ? roll.formula : '';
  const breakdown = (roll && roll.breakdownText) ? roll.breakdownText : '';
  const isCrit = Boolean(roll && roll.isCrit);
  const isFumble = Boolean(roll && roll.isFumble);
  const damageType = (roll && roll.damageType) ? String(roll.damageType).trim() : '';
  const damageLabel = damageType || 'Damage';
  const isRedacted = !isCondition && ((roll && roll.sendDescriptions === false) || (roll && roll.description === '[REDACTED]'));
  const description = isRedacted ? '[REDACTED]' : ((roll && roll.description) ? String(roll.description).trim() : '');
  const metaRows = [];
  if (!isRedacted) {
    if (roll && roll.attackSource) {
      metaRows.push(`<tr><td>Attack</td><td>${escapeHtml(roll.attackSource)}</td></tr>`);
    }
    if (roll && roll.range) {
      metaRows.push(`<tr><td>Range</td><td>${escapeHtml(roll.range)}</td></tr>`);
    }
  }
  const metaTableHtml = metaRows.length > 0 ? `<table>${metaRows.join('')}</table>` : '';
  const descriptionHtml = (description || metaTableHtml)
    ? `${metaTableHtml}${description ? `<div class="beyond20-description">${formatDescriptionHtml(description)}</div>` : ''}`
    : '';

  if (isCondition) {
    const condTitle = (roll && roll.title) ? String(roll.title) : 'Condition';
    return `<div class="beyond20-message">` +
      `<div class="beyond20-header">` +
        `<span class="beyond20-title">${escapeHtml(condTitle)}</span>` +
      `</div>` +
      descriptionHtml +
    `</div>`;
  }

  let titleSuffix = '';
  if (roll && roll.isAdvantage) titleSuffix = ' (Advantage)';
  else if (roll && roll.isDisadvantage) titleSuffix = ' (Disadvantage)';

  // Keep attack/action title clean (e.g. "Scimitar", "Fireball", or "Damage")
  const displayTitle = (roll && roll.title ? roll.title : (isDamage ? 'Damage' : 'Roll')) + titleSuffix;

  let rollBodyHtml = '';

  if (isDamage) {
    // Compact Damage box with hover tooltip for formula & boxed die parts
    const critClass = isCrit ? ' beyond20-critical-damage' : '';
    const dmgBox = `<div class="beyond20-total-damage${critClass}">${escapeHtml(String(total))} ${escapeHtml(damageLabel)}</div>`;
    rollBodyHtml = buildTooltipBox(dmgBox, formula, breakdown, false, roll && roll.parts);
  } else {
    // Compact To-Hit / D20 cells with hover tooltip for formula & breakdown
    let cellsHtml = '';
    const diceRolls = (roll && roll.diceRolls && roll.diceRolls.length > 0)
      ? roll.diceRolls
      : [{
          dieVal: total,
          totalVal: total,
          isDiscarded: false,
          isCrit: isCrit,
          isFumble: isFumble
        }];

    diceRolls.forEach((die) => {
      let detailClasses = [];
      if (die.isDiscarded) {
        detailClasses.push('beyond20-roll-detail-discarded');
      } else {
        detailClasses.push('beyond20-roll-total', 'dice-total');
      }

      if (die.isCrit) {
        detailClasses.push('beyond20-roll-detail-crit');
      } else if (die.isFumble) {
        detailClasses.push('beyond20-roll-detail-fail');
      } else if (!die.isDiscarded) {
        detailClasses.push('beyond20-roll-detail-normal');
      }

      const dieValueSpan = `<span class="beyond20-roll-value ${detailClasses.join(' ')}">${escapeHtml(String(die.totalVal !== undefined ? die.totalVal : die.dieVal))}</span>`;
      const dieTooltipBreakdown = breakdown || (die.dieVal !== undefined ? `[${die.dieVal}]` : '');
      cellsHtml += `<div class="beyond20-roll-cell">` +
        buildTooltipBox(dieValueSpan, formula, dieTooltipBreakdown, false, roll && roll.parts) +
      `</div>`;
    });

    rollBodyHtml = `<div class="beyond20-roll-cells">` +
        cellsHtml +
      `</div>`;

    // Append combined auto-rolled damage(s) underneath as unboxed inline text with hover tooltips
    if (Array.isArray(roll && roll.damages) && roll.damages.length > 0) {
      roll.damages.forEach((dmg) => {
        const prefixLabel = formatInlineDamageLabel(dmg.damageType);
        const numClass = (dmg.isCrit || isCrit) ? 'beyond20-roll-detail-crit' : 'beyond20-roll-detail-normal';
        const numSpan = `<span class="beyond20-roll-total dice-total ${numClass}">${escapeHtml(String(dmg.total))}</span>`;
        rollBodyHtml += `<div class="beyond20-roll-damage" style="display:flex;align-items:baseline;gap:4px"><b>${escapeHtml(prefixLabel)}:</b>${buildTooltipBox(numSpan, dmg.formula, dmg.breakdown, true, dmg.parts)}</div>`;
      });
    }
  }

  const headerInnerHtml = descriptionHtml
    ? `<details><summary>${escapeHtml(displayTitle)}</summary>${descriptionHtml}</details>`
    : `<span class="beyond20-title">${escapeHtml(displayTitle)}</span>`;

  return `<div class="beyond20-message">` +
    `<div class="beyond20-header">` +
      headerInnerHtml +
    `</div>` +
    `<div class="beyond20-roll-result">` +
      rollBodyHtml +
    `</div>` +
  `</div>`;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
