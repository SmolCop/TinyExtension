# Tiny Extension — Developer Documentation

**Cross-Browser Manifest V3** extension (Chromium: Chrome/Vivaldi/Brave/Edge + Firefox 121+) built with **vanilla JS/CSS and zero build step**. Bridges 5etools dice rolls, action descriptions, and condition cards into Owl20 on Owlbear Rodeo.

---

## 1. Architecture & Data Flow

```text
[5etools Tab]
  1. Early localhost bailout (content-5etools.js): skips non-5etools localhost/127.0.0.1 apps
  2. Capture-phase click (content-5etools.js)
     ├─ Inspects clicked .roller / [data-packed-dice]
     ├─ Reads sanitized description (statblock-reader.js) & strips DCs
     └─ Caches sibling damage roller elements + damage types (1500ms TTL)
  3. MutationObserver watches .out-roll-item in 5etools roll box
     ├─ Parses total, formula, diceRolls, parts[], kept-d20 Nat 20 (isCrit)
     └─ If bridgeEnabled && autoRollDamage && To-Hit: dispatches MouseEvent('click', { shiftKey: isCrit })
        on sibling damage rollers, buffers results for up to 250ms, and bundles
        To-Hit + Damage(s) into one roll object
          │
          ▼  chrome.runtime.sendMessage({ action: 'SEND_ROLL', roll })
[Background Worker / Script] (background.js — single source of truth for masking)
  ├─ Reads chrome.storage.local settings
  ├─ Applies showCreatureName, showActionName, and sendDescriptions masking/redaction
  ├─ Queries open Owlbear Rodeo tabs (prioritizing /room/ URLs)
  └─ Auto-injects content-obr.js via chrome.scripting if a tab predates extension reload
          │
          ▼  chrome.tabs.sendMessage(tab.id, { action: 'DISPATCH_ROLL', roll })
[Owlbear Rodeo Tab] (content-obr.js)
  ├─ Converts roll into Beyond20 rendered-roll payload + HTML card (default character fallback: "DM")
  └─ Dispatches CustomEvent('Beyond20_Roll', { detail: [beyond20Payload] }) on document
          │
          ▼
[Owl20 Extension] ──► PostMessages to Owl20 iframe ──► Renders in Owlbear Rodeo chat
```

---

## 2. File-by-File Breakdown

| File | Responsibility |
| --- | --- |
| `manifest.json` | Cross-browser MV3 config (Chromium `service_worker` + Firefox `background.scripts` & `browser_specific_settings.gecko`), permissions (`tabs`, `scripting`, `storage`), host matches, icon paths, and script order. |
| `statblock-reader.js` | Parses active 5etools statblocks (`#pagecontent`, `.ve-stats`, `.stats`), strips links/UI elements, and exposes `readCurrentStatblock`, `extractCleanStatblockText`, and `findStatblockActionDescription` (which calls `findStatblockContainer` + `parseSections` directly). |
| `content-5etools.js` | Bails out early on non-5etools localhost pages, observes `.out-roll-item` rollbox entries, caches statblock click context, triggers native damage rollers on To-Hit, strips DCs, and injects **Send to Owl20** buttons on condition cards. |
| `background.js` | MV3 background script & single source of truth for `showCreatureName`, `showActionName`, and `sendDescriptions` masking/redaction; routes `SEND_ROLL` to Owlbear Rodeo tabs, and handles `CHECK_OBR_TAB` and dynamic script injection fallback. |
| `content-obr.js` | Translates parsed rolls and conditions into Beyond20 `rendered-roll` JSON + Owl20 CSS-compatible HTML (boxed hover tooltips, inline damage, collapsible `<details>` descriptions) and fires `Beyond20_Roll`. |
| `popup.html` / `popup.css` / `popup.js` | Toolbar switchboard UI showing Owlbear tab status and persisting the 5 toggles in `chrome.storage.local`. |

---

## 3. Core Mechanics

### Roll Scraping & Native Auto-Damage (`content-5etools.js`)
- **Localhost Bailout:** On `localhost` / `127.0.0.1`, `isFiveEToolsPage()` checks for `#pagecontent`, `.ve-stats`, `.out-roll-wrp`, `.out-roll-item`, or `5etools` in `document.title` / `meta[name="application-name"]` before attaching listeners.
- **Click Caching:** `handleStatblockDiceClick` runs in the capture phase (`evt.isTrusted` guard ignores our own synthetic clicks). It identifies whether the clicked `.roller` / `[data-packed-dice]` is a `d20` To-Hit or damage roll, grabs the adjacent damage type (`DAMAGE_TYPE_REGEX`), and locates sibling damage rollers in the same action entry (`findSiblingDamageRollers`, excluding `d20` and `Recharge` rollers).
- **Nat 20 Detection:** `parseRollItem` computes `isCrit` from the actual **kept** d20 die value (`!d.isDiscarded && d.dieVal === 20`), handling single d20s as well as Advantage (`2d20dl1` / `kh1`) and Disadvantage (`2d20dh1` / `kl1`).
- **Native Crit Trigger & Collection Buffer:** When `autoRollDamage` is `true` on a To-Hit roll with sibling damage rollers, `dispatchParsedRoll` opens a 250ms `autoRollCollector` buffer and dispatches `new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: Boolean(roll.isCrit) })` on each damage roller. 5etools' own `render-dice.js` doubles damage dice when `shiftKey: true`. `handleParsedRoll` intercepts those resulting `.out-roll-item` entries and flushes one combined payload once all expected damages arrive (or when the 250ms timer expires).

### Statblock Parsing, Sanitization & Condition Cards (`statblock-reader.js`, `content-5etools.js`)
- `extractCleanStatblockText` clones DOM nodes, removes hidden/UI-only elements (`.ve-hidden`, `.mon__btn-scale-cr`, `.rd__h-toggle`, buttons, `[aria-hidden="true"]`), strips `href`, `on*`, `data-vet*`, and `data-packed-dice` attributes, and preserves line breaks.
- `findStatblockActionDescription` calls `findStatblockContainer` and `parseSections` directly so attack clicks don't re-parse AC, HP, Speed, or ability scores.
- `stripDcsFromDescription` removes explicit DC numbers (`/\bDC\s*\d+\s*/gi`) from action descriptions when `sendDescriptions` is ON.
- `scanNodeForConditions` injects a `Send to Owl20` button (guarded by `data-owl20-injected="true"`) on `conditionsdiseases.html` and `.hwin` condition hover popups.

### Owl20 / Beyond20 Payload Schema (`content-obr.js`)
- **Payload Fields:** Emits `action: 'rendered-roll'`, `character` (defaults to `"DM"` if missing), `title`, `whisper`, `html`, `description`, and `roll` (omitting any `avatar` / `charUrl` fields).
  - Combined attacks set `type: 'attack'`, `to-hit` / `to_hit`, `attack_rolls`, `damages`, `damage_rolls` (`[label, rollObj]` tuples), `damage-types` / `damage_types`, `attack-source`, and `range`.
  - Saving throws set `type: 'saving-throw'` and `save-ability` / `save_ability`.
- **Hover Tooltips:** `parseRollParts` extracts each die group (`amount`, `faces`, `formula`, `rolls: [{ roll, discarded, critical, critical_failure }]`) and numeric modifier from 5etools' breakdown HTML (including `rll__max--muted` / `rll__min--muted` / `rll__dropped`). `buildTooltipBox` renders `.beyond20-tooltip` / `.beyond20-tooltip-content` with a top `.beyond20-roll-formula` box and `.beyond20-roll-die-result` boxes.
- **Inline Damage & Collapsible Descriptions:** Combined attacks render To-Hit inside `.beyond20-roll-cell` and each damage underneath as unboxed `.beyond20-roll-damage` inline text (`<b>Piercing Damage:</b> <total>`). Roll descriptions wrap the title in `<details><summary>...</summary>...</details>` (collapsed by default); when `sendDescriptions` is OFF, metadata (`attack-source`, `range`, `save-ability`) is omitted and `description` is set to `"[REDACTED]"`.

---

## 4. State & Storage Keys (`chrome.storage.local`)

| Key | Default | Behavior When `false` |
| --- | --- | --- |
| `bridgeEnabled` | `true` | Pauses roll forwarding and condition sends. |
| `showCreatureName` | `false` | Replaces `character` with `"DM"` (in `background.js`). |
| `showActionName` | `false` | Masks `title` as `"Attack"`, `"Damage"`, `"Saving Throw"`, `"Check"`, or `"Roll"` and strips `attackSource` / `range` (in `background.js`). |
| `sendDescriptions` | `true` | Sets roll `description` to `"[REDACTED]"`, omits `attackSource` / `range` / `saveAbility`, and disables condition sends. |
| `autoRollDamage` | `true` | Disables auto-clicking sibling damage rollers on To-Hit rolls. |

---

## 5. Cross-Browser Manifest & Local Development

- **No Build Step:** Edit any `.js`, `.html`, `.css`, or `manifest.json` file directly.
- **Firefox MV3 Keys (`manifest.json`):**
  - `background.scripts: ["background.js"]` alongside `background.service_worker: "background.js"`
  - `browser_specific_settings.gecko.id`: `"tiny-extension@livingchronicles.local"`
  - `browser_specific_settings.gecko.strict_min_version`: `"121.0"`
  - `browser_specific_settings.gecko.data_collection_permissions`: `{ "required": ["none"] }`
- **Adding Custom 5etools Mirrors:** Add your mirror's URL pattern to **both** `host_permissions` and `content_scripts[1].matches` in `manifest.json` (e.g., `"*://your-mirror.example/*"`).
- **Debug Logging:** Every JS file defines `const DEBUG = false;` at the top. Set `DEBUG = true` in the script(s) you want to inspect to enable `[Tiny Extension]` console logs (errors always log via `console.error`).
- **Reloading After Edits:** Open `chrome://extensions` / `vivaldi://extensions` (or `about:debugging` in Firefox), reload **Tiny Extension**, and refresh any open **5etools** and **Owlbear Rodeo** tabs.
