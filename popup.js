// [Tiny Extension] popup.js - Extension popup controller
const DEBUG = false;

function log(...args) {
  if (DEBUG) console.log('[Tiny Extension]', ...args);
}

log('Popup loaded.');

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const targetRoomRow = document.getElementById('target-room-row');
const selectTargetRoom = document.getElementById('select-target-room');
const toggleBridge = document.getElementById('toggle-bridge');
const toggleShowCreature = document.getElementById('toggle-show-creature');
const toggleShowAction = document.getElementById('toggle-show-action');
const btnExpandAction = document.getElementById('btn-expand-action');
const subrowShowAction = document.getElementById('subrow-show-action');
const toggleSendDescriptions = document.getElementById('toggle-send-descriptions');
const toggleAutoRollDamage = document.getElementById('toggle-auto-roll-damage');

const btnExpandMirrors = document.getElementById('btn-expand-mirrors');
const mirrorsChevron = document.getElementById('mirrors-chevron');
const mirrorsBody = document.getElementById('mirrors-body');
const inputMirrorUrl = document.getElementById('input-mirror-url');
const btnAddMirror = document.getElementById('btn-add-mirror');
const mirrorStatus = document.getElementById('mirror-status');
const mirrorList = document.getElementById('mirror-list');

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
  autoRollDamage: true,
  customMirrors: []
}, (settings) => {
  const showCreature = Boolean(settings.showCreatureName);
  if (toggleBridge) toggleBridge.checked = Boolean(settings.bridgeEnabled);
  if (toggleShowCreature) toggleShowCreature.checked = showCreature;
  if (toggleShowAction) toggleShowAction.checked = Boolean(settings.showActionName);
  if (toggleSendDescriptions) toggleSendDescriptions.checked = Boolean(settings.sendDescriptions);
  if (toggleAutoRollDamage) toggleAutoRollDamage.checked = Boolean(settings.autoRollDamage);
  setActionSubrowExpanded(showCreature);
  renderMirrorsList(Array.isArray(settings.customMirrors) ? settings.customMirrors : []);
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

// Active Table selector (visible when 2+ OBR tabs are open)
function renderTargetRoomSelector(tabs, targetObrTabId) {
  if (!targetRoomRow || !selectTargetRoom) return;
  if (!Array.isArray(tabs) || tabs.length < 2) {
    targetRoomRow.classList.add('collapsed');
    selectTargetRoom.innerHTML = '';
    return;
  }

  selectTargetRoom.innerHTML = '';
  tabs.forEach((tab) => {
    const opt = document.createElement('option');
    opt.value = String(tab.id);
    const roomName = tab.roomName || 'Owlbear Room';
    opt.textContent = tab.isGm ? roomName : `${roomName} (Player)`;
    if (tab.id === targetObrTabId) {
      opt.selected = true;
    }
    selectTargetRoom.appendChild(opt);
  });
  targetRoomRow.classList.remove('collapsed');
}

if (selectTargetRoom) {
  selectTargetRoom.addEventListener('change', () => {
    const tabId = Number(selectTargetRoom.value);
    if (!tabId) return;
    chrome.runtime.sendMessage({ action: 'SET_TARGET_OBR_TAB', tabId: tabId }, () => {
      checkConnection();
    });
  });
}

// Check if an Owlbear Rodeo tab is open and display GM status
function checkConnection() {
  chrome.runtime.sendMessage({ action: 'CHECK_OBR_TAB' }, (response) => {
    if (chrome.runtime.lastError) {
      if (statusDot) statusDot.className = 'dot disconnected';
      if (statusText) statusText.textContent = 'Inactive';
      renderTargetRoomSelector([], null);
      return;
    }

    if (response && response.hasObrTab && response.isGm) {
      if (statusDot) statusDot.className = 'dot connected';
      if (statusText) statusText.textContent = 'GM Mode';
    } else if (response && response.hasObrTab) {
      if (statusDot) statusDot.className = 'dot warning';
      if (statusText) statusText.textContent = 'Player Mode';
    } else {
      if (statusDot) statusDot.className = 'dot disconnected';
      if (statusText) statusText.textContent = 'No Owlbear Tab';
    }

    renderTargetRoomSelector(response ? response.tabs : [], response ? response.targetObrTabId : null);
  });
}

// Custom 5etools Mirrors UI
function setMirrorStatus(msg) {
  if (!mirrorStatus) return;
  if (!msg) {
    mirrorStatus.textContent = '';
    mirrorStatus.classList.add('collapsed');
  } else {
    mirrorStatus.textContent = msg;
    mirrorStatus.classList.remove('collapsed');
  }
}

function normalizeMirrorPattern(rawInput) {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.host) return null;
    return `${url.protocol}//${url.host}/*`;
  } catch (e) {
    return null;
  }
}

function getMirrorScriptId(pattern) {
  return 'tiny-ext-mirror-' + String(pattern).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function renderMirrorsList(mirrors) {
  if (!mirrorList) return;
  mirrorList.innerHTML = '';
  mirrors.forEach((pattern) => {
    const li = document.createElement('li');
    li.className = 'mirror-item';

    const span = document.createElement('span');
    span.className = 'mirror-pattern';
    span.textContent = pattern;
    span.title = pattern;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mirror-remove-btn';
    btn.textContent = '×';
    btn.title = 'Remove mirror';
    btn.addEventListener('click', () => removeMirror(pattern));

    li.appendChild(span);
    li.appendChild(btn);
    mirrorList.appendChild(li);
  });
}

function addMirror() {
  setMirrorStatus('');
  const pattern = normalizeMirrorPattern(inputMirrorUrl ? inputMirrorUrl.value : '');
  if (!pattern) {
    setMirrorStatus('Enter a valid http(s) URL or domain.');
    return;
  }

  chrome.permissions.request({ origins: [pattern] }, (granted) => {
    if (chrome.runtime.lastError || !granted) {
      setMirrorStatus('Host permission denied.');
      return;
    }

    const scriptId = getMirrorScriptId(pattern);
    const scriptDef = [{
      id: scriptId,
      matches: [pattern],
      js: ['statblock-reader.js', 'content-5etools.js'],
      runAt: 'document_end',
      persistAcrossSessions: true
    }];

    const finishSave = () => {
      chrome.storage.local.get({ customMirrors: [] }, (res) => {
        const list = Array.isArray(res.customMirrors) ? res.customMirrors : [];
        if (!list.includes(pattern)) list.push(pattern);
        chrome.storage.local.set({ customMirrors: list }, () => {
          if (inputMirrorUrl) inputMirrorUrl.value = '';
          renderMirrorsList(list);
        });
      });
    };

    chrome.scripting.unregisterContentScripts({ ids: [scriptId] }, () => {
      // Ignore error if script wasn't registered yet
      void chrome.runtime.lastError;
      chrome.scripting.registerContentScripts(scriptDef, () => {
        if (chrome.runtime.lastError) {
          setMirrorStatus('Failed to register script: ' + chrome.runtime.lastError.message);
          return;
        }
        finishSave();
      });
    });
  });
}

function removeMirror(pattern) {
  setMirrorStatus('');
  const scriptId = getMirrorScriptId(pattern);
  chrome.scripting.unregisterContentScripts({ ids: [scriptId] }, () => {
    void chrome.runtime.lastError;
    chrome.permissions.remove({ origins: [pattern] }, () => {
      void chrome.runtime.lastError;
      chrome.storage.local.get({ customMirrors: [] }, (res) => {
        const list = (Array.isArray(res.customMirrors) ? res.customMirrors : []).filter((p) => p !== pattern);
        chrome.storage.local.set({ customMirrors: list }, () => {
          renderMirrorsList(list);
        });
      });
    });
  });
}

if (btnExpandMirrors && mirrorsBody) {
  btnExpandMirrors.addEventListener('click', () => {
    const isCollapsed = mirrorsBody.classList.toggle('collapsed');
    if (mirrorsChevron) mirrorsChevron.textContent = isCollapsed ? '▸' : '▾';
    btnExpandMirrors.setAttribute('aria-expanded', String(!isCollapsed));
  });
}

if (btnAddMirror) {
  btnAddMirror.addEventListener('click', addMirror);
}

if (inputMirrorUrl) {
  inputMirrorUrl.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter') {
      evt.preventDefault();
      addMirror();
    }
  });
}

checkConnection();
