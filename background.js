const DEFAULT_STATE = { status: 'idle', timer: '00:00', progress: '', error: '', startedAt: 0 };

let offscreenPort = null;
let popupPort = null;
let bridged = false;

async function getState() {
  const { recorderState } = await chrome.storage.session.get('recorderState');
  return recorderState || DEFAULT_STATE;
}

async function setState(partial) {
  const next = { ...(await getState()), ...partial };
  await chrome.storage.session.set({ recorderState: next });
  chrome.runtime.sendMessage({ type: 'RECORDER_UPDATE', ...next }).catch(() => {});
  return next;
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DISPLAY_MEDIA', 'WORKERS', 'USER_MEDIA'],
    justification: 'Persist screen recording and convert to MP4',
  });

  for (let i = 0; i < 20; i++) {
    if (offscreenPort) return;
    try {
      await chrome.runtime.sendMessage({ target: 'offscreen', action: 'PING' });
      if (offscreenPort) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Recorder failed to start.');
}

function bridgePorts() {
  if (!popupPort || !offscreenPort || bridged) return;
  bridged = true;

  popupPort.onMessage.addListener((msg) => {
    if (!offscreenPort) return;
    offscreenPort.postMessage(msg, msg.tracks || []);
  });

  offscreenPort.onMessage.addListener((msg) => {
    if (popupPort) popupPort.postMessage(msg);
  });

  try {
    popupPort.postMessage({ action: 'BRIDGE_READY' });
  } catch { /* popup gone */ }
}

chrome.runtime.onInstalled.addListener(async () => {
  await setState(DEFAULT_STATE);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'recorder-offscreen') {
    offscreenPort = port;
    offscreenPort.onDisconnect.addListener(() => {
      offscreenPort = null;
      bridged = false;
    });
    bridgePorts();
    return;
  }

  if (port.name === 'recorder') {
    popupPort = port;
    popupPort.onDisconnect.addListener(() => {
      popupPort = null;
      bridged = false;
    });
    bridgePorts();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'DOWNLOAD') {
    chrome.downloads.download(
      { url: message.url, filename: message.filename, saveAs: false },
      (downloadId) => {
        sendResponse(
          chrome.runtime.lastError
            ? { ok: false, error: chrome.runtime.lastError.message }
            : { ok: true, downloadId }
        );
      }
    );
    return true;
  }

  if (message.type === 'GET_STATE') {
    getState().then((state) => {
      if (state.status === 'recording' && state.startedAt) {
        const sec = Math.floor((Date.now() - state.startedAt) / 1000);
        state.timer = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
      }
      sendResponse(state);
    });
    return true;
  }

  if (message.type === 'ENSURE_OFFSCREEN') {
    ensureOffscreen().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (message.type === 'RECORDER_UPDATE') {
    const { type: _t, ...stateFields } = message;
    setState(stateFields);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'SET_BADGE') {
    chrome.action.setBadgeText({ text: message.text || '' });
    chrome.action.setBadgeBackgroundColor({ color: '#e11' });
    sendResponse({ ok: true });
    return false;
  }
});
