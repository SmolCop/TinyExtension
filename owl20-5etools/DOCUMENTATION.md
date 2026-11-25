# Tiny Extension — Developer Documentation

Manifest V3 Chrome/Edge extension built with **vanilla JS/CSS and zero build step**. Bridges 5etools dice rolls, action descriptions, and condition cards into Owl20 on Owlbear Rodeo.

---

## 1. Architecture & Data Flow

```text
[5etools Tab]
  1. Capture-phase click (content-5etools.js)
     ├─ Inspects clicked .roller / [data-packed-dice]
     ├─ Reads sanitized description (statblock-reader.js) & strips DCs
     └─ Caches sibling damage roller elements + damage types (1500ms TTL)
  2. MutationObserver watches .out-roll-item in 5etools roll box
     ├─ Parses total, formula, diceRolls, parts[], kept-d20 Nat 20 (isCrit)
     └─ If autoRollDamage && To-Hit: dispatches MouseEvent('click', { shiftKey: isCrit })
        on sibling damage rollers, buffers results for up to 250ms, and bundles
        To-Hit + Damage(s) into one roll object
          │
          ▼  chrome.runtime.sendMessage({ action: 'SEND_ROLL', roll })
[Service Worker] (background.js)
  ├─ Reads chrome.storage.local settings & applies showCreatureName / showActionName / sendDescriptions
  ├─ Queries open Owlbear Rodeo tabs (prioritizing /room/ URLs)
  └─ Auto-injects content-obr.js via chrome.scripting if a tab predates extension reload
          │
          ▼  chrome.tabs.sendMessage(tab.id, { action: 'DISPATCH_ROLL', roll })
[Owlbear Rodeo Tab] (content-obr.js)
  ├─ Converts roll into Beyond20 rendered-roll payload + HTML card
  └─ Dispatches CustomEvent('Beyond20_Roll', { detail: [beyond20Payload] }) on document
          │
          ▼
[Owl20 Extension] ──► PostMessages to Owl20 iframe ──► Renders in Owlbear Rodeo chat
```

---

## 2. File-by-File Breakdown

| File | Responsibility |
| --- | --- |
| `manifest.json` | MV3 config, permissions (`tabs`, `scripting`, `storage`), host matches, icon paths, and script injection order. |
| `statblock-reader.js` | Parses active 5etools statblocks (`#pagecontent`, `.ve-stats`, `.stats`), strips links/UI elements, and exposes `readCurrentStatblock`, `extractCleanStatblockText`, and `findStatblockActionDescription`. |
| `content-5etools.js` | Observes 5etools `.out-roll-item` rollbox entries, caches statblock click context, triggers native damage rollers on To-Hit, strips DCs, and injects **Send to Owl20** buttons on condition cards. |
| `background.js` | MV3 service worker that checks `bridgeEnabled`, applies visibility/description masking, routes `SEND_ROLL` to Owlbear Rodeo tabs, and handles `CHECK_OBR_TAB` and dynamic script injection fallback. |
| `content-obr.js` | Translates parsed rolls and conditions into Beyond20 `rendered-roll` JSON + Owl20 CSS-compatible HTML (boxed hover tooltips, inline damage, collapsible `<details>` descriptions) and fires `Beyond20_Roll`. |
| `popup.html` / `popup.css` / `popup.js` | Toolbar switchboard UI showing Owlbear tab status and persisting the 5 toggles in `chrome.storage.local`. |

---

## 3. Core Mechanics

### Roll Scraping & Native Auto-Damage (`content-5etools.js`)
- **Click Caching:** `handleStatblockDiceClick` runs in the capture phase (`evt.isTrusted` guard ignores our own synthetic clicks). It identifies whether the clicked `.roller` / `[data-packed-dice]` is a `d20` To-Hit or damage roll, grabs the adjacent damage type (`DAMAGE_TYPE_REGEX`), and locates sibling damage rollers in the same action entry (`findSiblingDamageRollers`, excluding `d20` and `Recharge` rollers).
- **Nat 20 Detection:** `parseRollItem` computes `isCrit` from the actual **kept** d20 die value (`!d.isDiscarded && d.dieVal === 20`), handling single d20s as well as Advantage (`2d20dl1` / `kh1`) and Disadvantage (`2d20dh1` / `kl1`).
- **Native Crit Trigger & Collection Buffer:** When `autoRollDamage` is `true` on a To-Hit roll with sibling damage rollers, `dispatchParsedRoll` opens a 250ms `autoRollCollector` buffer and dispatches `new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: Boolean(roll.isCrit) })` on each damage roller. 5etools' own `render-dice.js` doubles damage dice when `shiftKey: true`. `handleParsedRoll` intercepts those resulting `.out-roll-item` entries and flushes one combined payload once all expected damages arrive (or when the 250ms timer expires).

### Statblock Parsing, Sanitization & Condition Cards (`statblock-reader.js`, `content-5etools.js`)
- `extractCleanStatblockText` clones DOM nodes, removes hidden/UI-only elements (`.ve-hidden`, `.mon__btn-scale-cr`, `.rd__h-toggle`, buttons, `[aria-hidden="true"]`), strips `href`, `on*`, `data-vet*`, and `data-packed-dice` attributes, and preserves line breaks.
- `stripDcsFromDescription` removes explicit DC numbers (`/\bDC\s*\d+\s*/gi`) from action descriptions when `sendDescriptions` is ON.
- `scanNodeForConditions` injects a `Send to Owl20` button (guarded by `data-owl20-injected="true"`) on `conditionsdiseases.html` and `.hwin` condition hover popups.

### Owl20 / Beyond20 Payload Schema (`content-obr.js`)
- **Payload Fields:** Emits `action: 'rendered-roll'`, `character`, `title`, `whisper`, `html`, `description`, and `roll` (omitting any `avatar` / `charUrl` fields).
  - Combined attacks set `type: 'attack'`, `to-hit` / `to_hit`, `attack_rolls`, `damages`, `damage_rolls` (`[label, rollObj]` tuples), `damage-types` / `damage_types`, `attack-source`, and `range`.
  - Saving throws set `type: 'saving-throw'` and `save-ability` / `save_ability`.
- **Hover Tooltips:** `parseRollParts` extracts each die group (`amount`, `faces`, `formula`, `rolls: [{ roll, discarded, critical, critical_failure }]`) and numeric modifier from 5etools' breakdown HTML (including `rll__max--muted` / `rll__min--muted` / `rll__dropped`). `buildTooltipBox` renders `.beyond20-tooltip` / `.beyond20-tooltip-content` with a top `.beyond20-roll-formula` box and `.beyond20-roll-die-result` boxes.
- **Inline Damage & Collapsible Descriptions:** Combined attacks render To-Hit inside `.beyond20-roll-cell` and each damage underneath as unboxed `.beyond20-roll-damage` inline text (`<b>Piercing Damage:</b> <total>`). Roll descriptions wrap the title in `<details><summary>...</summary>...</details>` (collapsed by default); when `sendDescriptions` is OFF, metadata (`attack-source`, `range`, `save-ability`) is omitted and `description` is set to `"[REDACTED]"`.

---

## 4. State & Storage Keys (`chrome.storage.local`)

| Key | Default | Behavior When `false` |
| --- | --- | --- |
| `bridgeEnabled` | `true` | Pauses roll forwarding and condition sends. |
| `showCreatureName` | `false` | Replaces `character` with `"DM"`. |
| `showActionName` | `false` | Masks `title` as `"Attack"`, `"Damage"`, `"Saving Throw"`, `"Check"`, or `"Roll"` and strips `attackSource` / `range`. |
| `sendDescriptions` | `true` | Sets roll `description` to `"[REDACTED]"`, omits `attackSource` / `range` / `saveAbility`, and disables condition sends. |
| `autoRollDamage` | `true` | Disables auto-clicking sibling damage rollers on To-Hit rolls. |

---

## 5. Local Development & Customization

- **No Build Step:** Edit any `.js`, `.html`, `.css`, or `manifest.json` file directly.
- **Adding Custom 5etools Mirrors:** Add your mirror's URL pattern to **both** `host_permissions` and the 5etools entry under `content_scripts[1].matches` in `manifest.json` (e.g., `"*://your-mirror.example/*"`).
- **Debug Logging:** Each JS file defines `const DEBUG = false;` at the top. Set `DEBUG = true` in the script(s) you want to inspect (`background.js`, `content-5etools.js`, `content-obr.js`, `popup.js`) to enable `[Tiny Extension]` console logs (errors always log via `console.error`).
- **Reloading After Edits:** Open `chrome://extensions` (or `edge://extensions`), click **Reload (↺)** on **Tiny Extension**, and refresh any open **5etools** and **Owlbear Rodeo** tabs.
