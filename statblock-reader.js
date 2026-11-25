// [Tiny Extension] statblock-reader.js - Clean 5etools bestiary statblock DOM parser

(function (global) {
  'use strict';

  const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const SIZE_REGEX = /^(Tiny|Small|Medium|Large|Huge|Gargantuan)(?:\s+or\s+(?:Tiny|Small|Medium|Large|Huge|Gargantuan))?\b/i;

  const HIDDEN_OR_UI_SELECTORS = [
    'script',
    'style',
    'button',
    '.ve-btn',
    '.btn',
    '.ve-hidden',
    '.hidden',
    '.ve-print__hidden',
    '.mon__btn-scale-cr',
    '.mon__wrp-btn-crcalc',
    '.rd__h-toggle',
    '.glyphicon',
    '[aria-hidden="true"]'
  ].join(', ');

  /**
   * Clone an element, strip 5etools links, hover attributes, and hidden/UI elements,
   * and return normalized clean text.
   */
  function extractCleanText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);

    // Remove hidden or UI-only elements
    if (clone.querySelectorAll) {
      const uiNodes = clone.querySelectorAll(HIDDEN_OR_UI_SELECTORS);
      for (let i = 0; i < uiNodes.length; i++) {
        uiNodes[i].remove();
      }

      // Remove inline display:none elements
      const allEls = clone.querySelectorAll('*');
      for (let i = 0; i < allEls.length; i++) {
        const node = allEls[i];
        if (node.style && node.style.display === 'none') {
          node.remove();
          continue;
        }
        // Unwrap <a> links while preserving text
        if (node.tagName === 'A') {
          node.removeAttribute('href');
          node.removeAttribute('target');
          node.removeAttribute('rel');
        }
        // Strip hover-wrapper and packed-dice attributes
        const attrs = Array.from(node.attributes || []);
        for (let j = 0; j < attrs.length; j++) {
          const attrName = attrs[j].name;
          if (
            attrName.startsWith('on') ||
            attrName.startsWith('data-vet') ||
            attrName === 'data-packed-dice' ||
            attrName === 'data-roll-name'
          ) {
            node.removeAttribute(attrName);
          }
        }
      }

      // Preserve line breaks for <br> and list items
      const brs = clone.querySelectorAll('br');
      for (let i = 0; i < brs.length; i++) {
        brs[i].replaceWith('\n');
      }
      const lis = clone.querySelectorAll('li');
      for (let i = 0; i < lis.length; i++) {
        lis[i].prepend('\n• ');
      }
    }

    return (clone.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Locate the active 5etools statblock container in the DOM.
   */
  function findStatblockContainer(rootEl) {
    if (rootEl && rootEl.nodeType === Node.ELEMENT_NODE) {
      return rootEl;
    }

    const pageContent = document.querySelector('#pagecontent');
    if (pageContent && !pageContent.querySelector('.initial-message')) {
      return pageContent;
    }

    const candidates = document.querySelectorAll('#wrp-pagecontent .ve-stats, .ve-stats, .stats');
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (!el.querySelector('.initial-message') && (el.querySelector('.stats-name, .mon__name') || el.textContent.trim())) {
        return el;
      }
    }

    return null;
  }

  /**
   * Parse creature name from the statblock header.
   */
  function parseName(container) {
    const nameEl = container.querySelector('.stats-name, .mon__name, th.stats-name');
    if (nameEl) {
      const clone = nameEl.cloneNode(true);
      const sourceEls = clone.querySelectorAll('.stats-source, .mon__source');
      for (let i = 0; i < sourceEls.length; i++) {
        sourceEls[i].remove();
      }
      const text = extractCleanText(clone);
      if (text) return text;
    }

    const firstHeader = container.querySelector('th[colspan]');
    return firstHeader ? extractCleanText(firstHeader) : '';
  }

  /**
   * Parse size, creature type, and alignment from the subtitle line.
   */
  function parseSizeTypeAlignment(container) {
    let raw = '';
    const wrp = container.querySelector('.mon__wrp-size-type-align');
    if (wrp) {
      raw = extractCleanText(wrp);
    } else {
      const rows = container.querySelectorAll('tr');
      for (let i = 0; i < Math.min(rows.length, 5); i++) {
        const italic = rows[i].querySelector('td > i, td > em');
        if (italic) {
          const text = extractCleanText(italic);
          if (SIZE_REGEX.test(text)) {
            raw = text;
            break;
          }
        }
      }
    }

    if (!raw) {
      return { size: '', type: '', alignment: '' };
    }

    // Split on comma outside parentheses so "humanoid (elf, shapechanger), neutral" works
    let splitIdx = -1;
    let depth = 0;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '(') depth++;
      else if (raw[i] === ')') depth = Math.max(0, depth - 1);
      else if (raw[i] === ',' && depth === 0) {
        splitIdx = i;
        break;
      }
    }

    const left = (splitIdx !== -1 ? raw.slice(0, splitIdx) : raw).trim();
    const alignment = (splitIdx !== -1 ? raw.slice(splitIdx + 1) : '').trim();

    let size = '';
    let type = left;
    const sizeMatch = left.match(SIZE_REGEX);
    if (sizeMatch) {
      size = sizeMatch[0].trim();
      type = left.slice(sizeMatch[0].length).trim();
    }

    return { size, type, alignment };
  }

  /**
   * Parse ability scores and modifiers (supports 2014 6-col table & 2024 ability grid).
   */
  function parseAbilities(container) {
    const result = {};
    ABILITIES.forEach((ab) => {
      result[ab] = { score: null, modifier: null };
    });

    // Strategy 1: 2014 table row with STR/DEX/CON/INT/WIS/CHA headers
    const tables = container.querySelectorAll('table');
    const searchTables = [container, ...tables];

    for (let t = 0; t < searchTables.length; t++) {
      const rows = searchTables[t].querySelectorAll('tr');
      for (let r = 0; r < rows.length - 1; r++) {
        const headerCells = Array.from(rows[r].children);
        const headerTexts = headerCells.map((c) => extractCleanText(c).toUpperCase());
        if (headerTexts.includes('STR') && headerTexts.includes('DEX') && headerTexts.includes('CHA')) {
          const valCells = Array.from(rows[r + 1].children);
          ABILITIES.forEach((ab) => {
            const idx = headerTexts.indexOf(ab.toUpperCase());
            if (idx !== -1 && valCells[idx]) {
              const parsed = parseScoreAndMod(extractCleanText(valCells[idx]));
              if (parsed) result[ab] = parsed;
            }
          });
          if (result.str.score !== null) return result;
        }
      }
    }

    // Strategy 2: 2024 statblock ability grid/elements (e.g. "STR 10 +0 +0")
    const fullText = extractCleanText(container);
    ABILITIES.forEach((ab) => {
      const re = new RegExp(`\\b${ab.toUpperCase()}\\s+(\\d+)\\s*\\(?([+-]?\\d+)\\)?`, 'i');
      const m = fullText.match(re);
      if (m) {
        result[ab] = {
          score: parseInt(m[1], 10),
          modifier: parseInt(m[2], 10)
        };
      }
    });

    return result;
  }

  function parseScoreAndMod(text) {
    if (!text) return null;
    const m = text.match(/(\d+)\s*\(\s*([+-]?\d+)\s*\)/);
    if (m) {
      return {
        score: parseInt(m[1], 10),
        modifier: parseInt(m[2], 10)
      };
    }
    const numOnly = text.match(/^\s*(\d+)\s*$/);
    if (numOnly) {
      const score = parseInt(numOnly[1], 10);
      return {
        score,
        modifier: Math.floor((score - 10) / 2)
      };
    }
    return null;
  }

  /**
   * Parse labeled stat lines (AC, HP, Speed, Saves, Skills, Senses, etc.).
   */
  function parseStatLines(container) {
    const fields = {
      ac: '',
      hp: '',
      speed: '',
      saves: '',
      skills: '',
      senses: '',
      languages: '',
      vulnerabilities: '',
      resistances: '',
      immunities: '',
      conditionImmunities: '',
      cr: ''
    };

    const labelMap = [
      { key: 'ac', re: /^(Armor Class|AC)\b/i },
      { key: 'hp', re: /^(Hit Points|HP)\b/i },
      { key: 'speed', re: /^Speed\b/i },
      { key: 'saves', re: /^Saving Throws\b/i },
      { key: 'skills', re: /^Skills\b/i },
      { key: 'vulnerabilities', re: /^(Damage Vulnerabilities|Vulnerabilities)\b/i },
      { key: 'resistances', re: /^(Damage Resistances|Resistances)\b/i },
      { key: 'conditionImmunities', re: /^Condition Immunities\b/i },
      { key: 'immunities', re: /^(Damage Immunities|Immunities)\b/i },
      { key: 'senses', re: /^Senses\b/i },
      { key: 'languages', re: /^Languages\b/i },
      { key: 'cr', re: /^(Challenge|CR)\b/i }
    ];

    const rows = container.querySelectorAll('tr, .mon__stat-line, .rd-mon__stat-line');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // Skip rows that are section containers or have nested tables
      if (row.querySelector('table')) continue;

      const text = extractCleanText(row);
      if (!text) continue;

      for (let j = 0; j < labelMap.length; j++) {
        const { key, re } = labelMap[j];
        const m = text.match(re);
        if (m && !fields[key]) {
          fields[key] = text.slice(m[0].length).replace(/^[:\s]+/, '').trim();
          break;
        }
      }
    }

    return fields;
  }

  /**
   * Determine which target section array a section header maps to.
   */
  function mapSectionKey(headerText) {
    const normalized = headerText.trim().toLowerCase();
    if (normalized === 'traits' || normalized === 'special traits') return 'traits';
    if (normalized === 'actions') return 'actions';
    if (normalized === 'bonus actions') return 'bonusActions';
    if (normalized === 'reactions') return 'reactions';
    if (normalized === 'legendary actions' || normalized === 'mythic actions') return 'legendaryActions';
    return null;
  }

  /**
   * Parse an individual feature/trait/action block into { name, text }.
   */
  function parseEntryElement(el) {
    const titleEl = el.querySelector('.entry-title-inner, .rd__h .entry-title, b > i, strong > em, i > b, em > strong, strong, b');
    let name = '';
    let text = extractCleanText(el);

    if (titleEl) {
      name = extractCleanText(titleEl).replace(/\.$/, '').trim();
      // Remove the leading title from the body text if it starts with it
      if (name && text.startsWith(name)) {
        text = text.slice(name.length).replace(/^[.:\s]+/, '').trim();
      }
    } else {
      // Fallback: match "Feature Name. Description..."
      const m = text.match(/^([^.]{2,80})\.\s+([\s\S]+)$/);
      if (m) {
        name = m[1].trim();
        text = m[2].trim();
      }
    }

    if (!name && !text) return null;
    return { name, text };
  }

  /**
   * Parse traits, actions, bonusActions, reactions, legendaryActions, and spellcasting.
   */
  function parseSections(container) {
    const sections = {
      traits: [],
      actions: [],
      bonusActions: [],
      reactions: [],
      legendaryActions: [],
      spellcasting: []
    };

    let currentSection = 'traits';
    let passedCoreStats = false;

    const rows = container.querySelectorAll('tr');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.querySelector('table')) continue;

      const rowText = extractCleanText(row);
      if (!rowText) continue;

      // Detect transition past the core stats header block (after Challenge / CR)
      if (/^(Challenge|CR)\b/i.test(rowText)) {
        passedCoreStats = true;
        continue;
      }

      // Check for section header rows
      const headerEl = row.querySelector('.mon__sect-row-inner, .rd__h--sect, h3, h4');
      if (headerEl) {
        const mapped = mapSectionKey(extractCleanText(headerEl));
        if (mapped) {
          currentSection = mapped;
          passedCoreStats = true;
          continue;
        }
      }

      // Also check if the entire row text is just a section title
      const directMapped = mapSectionKey(rowText);
      if (directMapped && rowText.length < 30) {
        currentSection = directMapped;
        passedCoreStats = true;
        continue;
      }

      if (!passedCoreStats) continue;

      // Skip divider rows or empty border rows
      if (row.querySelector('.ve-tbl-border') && !rowText) continue;

      // Extract feature blocks (.rd__b, <p>, or direct <td>)
      const entryBlocks = row.querySelectorAll(':scope > td > div.rd__b, :scope > td > p');
      const targets = entryBlocks.length > 0 ? Array.from(entryBlocks) : [row];

      for (let j = 0; j < targets.length; j++) {
        const entry = parseEntryElement(targets[j]);
        if (!entry) continue;

        if (/^(innate\s+)?spellcasting\b/i.test(entry.name)) {
          sections.spellcasting.push(entry);
        } else if (sections[currentSection]) {
          sections[currentSection].push(entry);
        }
      }
    }

    return sections;
  }

  /**
   * Read the currently open monster statblock on 5etools and return a structured object.
   * Returns null if no monster statblock is currently rendered.
   */
  function readCurrentStatblock(rootEl) {
    const container = findStatblockContainer(rootEl);
    if (!container) return null;

    const name = parseName(container);
    if (!name) return null;

    const { size, type, alignment } = parseSizeTypeAlignment(container);
    const abilities = parseAbilities(container);
    const statLines = parseStatLines(container);
    const sections = parseSections(container);

    return {
      name,
      size,
      type,
      alignment,
      ac: statLines.ac,
      hp: statLines.hp,
      speed: statLines.speed,
      cr: statLines.cr,
      str: abilities.str,
      dex: abilities.dex,
      con: abilities.con,
      int: abilities.int,
      wis: abilities.wis,
      cha: abilities.cha,
      saves: statLines.saves,
      skills: statLines.skills,
      senses: statLines.senses,
      languages: statLines.languages,
      vulnerabilities: statLines.vulnerabilities,
      resistances: statLines.resistances,
      immunities: statLines.immunities,
      conditionImmunities: statLines.conditionImmunities,
      traits: sections.traits,
      actions: sections.actions,
      bonusActions: sections.bonusActions,
      reactions: sections.reactions,
      legendaryActions: sections.legendaryActions,
      spellcasting: sections.spellcasting
    };
  }

  /**
   * Find an action, trait, reaction, bonus action, legendary action, or spellcasting entry
   * matching the given name in the currently open statblock.
   */
  function findStatblockActionDescription(actionName, rootEl) {
    if (!actionName) return null;
    const container = findStatblockContainer(rootEl);
    if (!container) return null;
    const sections = parseSections(container);

    const target = String(actionName).trim().toLowerCase();
    if (!target) return null;

    const buckets = [
      sections.actions,
      sections.bonusActions,
      sections.reactions,
      sections.legendaryActions,
      sections.traits,
      sections.spellcasting
    ];

    // Pass 1: exact case-insensitive match
    for (let b = 0; b < buckets.length; b++) {
      const list = buckets[b] || [];
      for (let i = 0; i < list.length; i++) {
        const entry = list[i];
        if (entry && entry.name && entry.name.trim().toLowerCase() === target) {
          return entry;
        }
      }
    }

    // Pass 2: prefix/substring match (e.g. "Scimitar (2/Day)" or "Bite" vs "Bite Attack")
    for (let b = 0; b < buckets.length; b++) {
      const list = buckets[b] || [];
      for (let i = 0; i < list.length; i++) {
        const entry = list[i];
        if (!entry || !entry.name) continue;
        const entryName = entry.name.trim().toLowerCase();
        if (entryName.startsWith(target) || target.startsWith(entryName)) {
          return entry;
        }
      }
    }

    return null;
  }

  global.readCurrentStatblock = readCurrentStatblock;
  global.extractCleanStatblockText = extractCleanText;
  global.findStatblockActionDescription = findStatblockActionDescription;
})(typeof window !== 'undefined' ? window : globalThis);
