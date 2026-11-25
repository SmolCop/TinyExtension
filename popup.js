// [Tiny Extension] popup.js - Extension popup controller
const DEBUG = false;

function log(...args) {
  if (DEBUG) console.log('[Tiny Extension]', ...args);
}

log('Popup loaded.');

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const toggleBridge = document.getElementById('toggle-bridge');
const toggleShowCreature = document.getElementById('toggle-show-creature');
const toggleShowAction = document.getElementById('toggle-show-action');
const btnExpandAction = document.getElementById('btn-expand-action');
const subrowShowAction = document.getElementById('subrow-show-action');
const toggleSendDescriptions = document.getElementById('toggle-send-descriptions');
const toggleAutoRollDamage = document.getElementById('toggle-auto-roll-damage');

function setActionSubrowExpanded(expanded) {
  if (subrowShowAction) {
    subrowShowAction.classList.toggle('collapsed', !expanded);
  }
  if (btnExpandAction) {
    btnExpandAction.textContent = expanded ? '▾' : '▸';
    btnExpandAction.setAttribute('aria-expanded', String(Boolean(expanded)));
  }
}

// Load persisted settings (creature & action names hidden by default)
chrome.storage.local.get({
  bridgeEnabled: true,
  showCreatureName: false,
  showActionName: false,
  sendDescriptions: true,
  autoRollDamage: true
}, (settings) => {
  const showCreature = Boolean(settings.showCreatureName);
  if (toggleBridge) toggleBridge.checked = Boolean(settings.bridgeEnabled);
  if (toggleShowCreature) toggleShowCreature.checked = showCreature;
  if (toggleShowAction) toggleShowAction.checked = Boolean(settings.showActionName);
  if (toggleSendDescriptions) toggleSendDescriptions.checked = Boolean(settings.sendDescriptions);
  if (toggleAutoRollDamage) toggleAutoRollDamage.checked = Boolean(settings.autoRollDamage);
  setActionSubrowExpanded(showCreature);
  log('Loaded settings into popup:', settings);
});

// Manual chevron toggle (clickable at all times)
if (btnExpandAction && subrowShowAction) {
  btnExpandAction.addEventListener('click', () => {
    const currentlyCollapsed = subrowShowAction.classList.contains('collapsed');
    setActionSubrowExpanded(currentlyCollapsed);
  });
}

// Save settings on changes
if (toggleBridge) {
  toggleBridge.addEventListener('change', () => {
    chrome.storage.local.set({ bridgeEnabled: toggleBridge.checked }, () => {
      log('Updated bridgeEnabled:', toggleBridge.checked);
    });
  });
}

if (toggleShowCreature) {
  toggleShowCreature.addEventListener('change', () => {
    const showCreature = toggleShowCreature.checked;
    // Automatically expand when turned ON, collapse when turned OFF (without touching showActionName)
    setActionSubrowExpanded(showCreature);
    chrome.storage.local.set({ showCreatureName: showCreature }, () => {
      log('Updated showCreatureName:', showCreature);
    });
  });
}

if (toggleShowAction) {
  toggleShowAction.addEventListener('change', () => {
    chrome.storage.local.set({ showActionName: toggleShowAction.checked }, () => {
      log('Updated showActionName:', toggleShowAction.checked);
    });
  });
}

if (toggleSendDescriptions) {
  toggleSendDescriptions.addEventListener('change', () => {
    chrome.storage.local.set({ sendDescriptions: toggleSendDescriptions.checked }, () => {
      log('Updated sendDescriptions:', toggleSendDescriptions.checked);
    });
  });
}

if (toggleAutoRollDamage) {
  toggleAutoRollDamage.addEventListener('change', () => {
    chrome.storage.local.set({ autoRollDamage: toggleAutoRollDamage.checked }, () => {
      log('Updated autoRollDamage:', toggleAutoRollDamage.checked);
    });
  });
}

// Check if an Owlbear Rodeo tab is open
function checkConnection() {
  chrome.runtime.sendMessage({ action: 'CHECK_OBR_TAB' }, (response) => {
    if (chrome.runtime.lastError) {
      if (statusDot) statusDot.className = 'dot disconnected';
      if (statusText) statusText.textContent = 'Inactive';
      return;
    }

    if (response && response.hasObrTab && response.isGm) {
      if (statusDot) statusDot.className = 'dot connected';
      if (statusText) statusText.textContent = 'Owlbear Ready (GM)';
    } else if (response && response.hasObrTab) {
      if (statusDot) statusDot.className = 'dot warning';
      if (statusText) statusText.textContent = 'Player Mode (GM Only)';
    } else {
      if (statusDot) statusDot.className = 'dot disconnected';
      if (statusText) statusText.textContent = 'No Owlbear Tab';
    }
  });
}

checkConnection();
