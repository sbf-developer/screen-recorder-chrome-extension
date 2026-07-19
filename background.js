const DEFAULT_STATE = { status: 'idle', timer: '00:00', progress: '', error: '', startedAt: 0 };

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

let creating = null;
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) return;

  if (creating) await creating;
  else {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DISPLAY_MEDIA', 'USER_MEDIA', 'WORKERS'],
      justification: 'Record screen and convert to MP4',
    });
    try { await creating; } finally { creating = null; }
  }

  for (let i = 0; i < 40; i++) {
    try {
      const ok = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'PING' });
      if (ok?.ok) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Recorder failed to start.');
}

chrome.runtime.onInstalled.addListener(async () => {
  await setState(DEFAULT_STATE);
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

  if (message.type === 'START_RECORDING') {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ target: 'offscreen', action: 'START', includeMic: !!message.includeMic }))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (message.type === 'STOP_RECORDING') {
    chrome.runtime.sendMessage({ target: 'offscreen', action: 'STOP' }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'RESET') {
    chrome.runtime.sendMessage({ target: 'offscreen', action: 'RESET' }).catch(() => {});
    setState({ status: 'idle', timer: '00:00', progress: '', error: '', startedAt: 0 });
    chrome.action.setBadgeText({ text: '' });
    sendResponse({ ok: true });
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
