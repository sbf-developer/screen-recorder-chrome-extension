const states = {
  idle: document.getElementById('state-idle'),
  picking: document.getElementById('state-picking'),
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

function applyUpdate(update) {
  const status = update.status || 'idle';

  if (status === 'picking') {
    showState('picking');
  } else if (status === 'recording') {
    showState('recording');
    if (update.timer) timerEl.textContent = update.timer;
  } else if (status === 'processing') {
    showState('processing');
    if (update.progress) processingSubtitle.textContent = update.progress;
  } else if (status === 'done') {
    showState('done');
  } else if (status === 'error') {
    errorMessage.textContent = update.error || 'Something went wrong';
    showState('error');
  } else {
    showState('idle');
  }
}

function startRecording() {
  showState('picking');
  chrome.runtime.sendMessage(
    { type: 'START_RECORDING', includeMic: micToggle.checked },
    (res) => {
      if (!res?.ok) {
        applyUpdate({ status: 'error', error: res?.error || 'Could not start recorder.' });
      }
    }
  );
}

function stopRecording() {
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
  applyUpdate({ status: 'processing', progress: 'Preparing MP4…' });
}

function resetToIdle() {
  chrome.runtime.sendMessage({ type: 'RESET' });
  showState('idle');
}

document.getElementById('btn-start').addEventListener('click', startRecording);
document.getElementById('btn-stop').addEventListener('click', stopRecording);
document.getElementById('btn-cancel').addEventListener('click', resetToIdle);
document.getElementById('btn-new').addEventListener('click', resetToIdle);
document.getElementById('btn-retry').addEventListener('click', resetToIdle);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'RECORDER_UPDATE') applyUpdate(msg);
});

chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
  if (!state) return;
  if (state.status === 'picking') {
    chrome.runtime.sendMessage({ type: 'RESET' });
    applyUpdate({ status: 'idle' });
  } else {
    applyUpdate(state);
  }
});
