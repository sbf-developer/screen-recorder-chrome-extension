const states = {
  idle: document.getElementById('state-idle'),
  recording: document.getElementById('state-recording'),
  processing: document.getElementById('state-processing'),
  done: document.getElementById('state-done'),
  error: document.getElementById('state-error'),
};

const micToggle = document.getElementById('mic-toggle');
const timerEl = document.getElementById('timer');
const processingSubtitle = document.getElementById('processing-subtitle');
const errorMessage = document.getElementById('error-message');

function showState(name) {
  Object.entries(states).forEach(([key, el]) => {
    el.classList.toggle('hidden', key !== name);
  });
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DISPLAY_MEDIA', 'WORKERS'],
    justification: 'Record screen and convert video to MP4',
  });

  for (let i = 0; i < 10; i++) {
    try {
      await chrome.runtime.sendMessage({ target: 'offscreen', action: 'PING' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function sendToOffscreen(action, data = {}) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', action, ...data });
}

document.getElementById('btn-start').addEventListener('click', async () => {
  try {
    await sendToOffscreen('START', { includeMic: micToggle.checked });
    showState('recording');
    timerEl.textContent = '00:00';
  } catch (err) {
    showError(err.message || 'Could not start recorder.');
  }
});

document.getElementById('btn-stop').addEventListener('click', () => {
  sendToOffscreen('STOP');
  showState('processing');
  processingSubtitle.textContent = 'Preparing MP4…';
});

document.getElementById('btn-new').addEventListener('click', () => showState('idle'));
document.getElementById('btn-retry').addEventListener('click', () => showState('idle'));

function showError(message) {
  errorMessage.textContent = message;
  showState('error');
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'RECORDER_UPDATE') return;

  if (msg.state === 'recording') {
    showState('recording');
    if (msg.timer) timerEl.textContent = msg.timer;
  } else if (msg.state === 'processing') {
    showState('processing');
    if (msg.progress) processingSubtitle.textContent = msg.progress;
  } else if (msg.state === 'done') {
    showState('done');
  } else if (msg.state === 'error') {
    showError(msg.error || 'Something went wrong.');
  }
});

showState('idle');
