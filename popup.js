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

async function mixAudio(screen, mic) {
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const sa = screen.getAudioTracks()[0];
  if (sa) ctx.createMediaStreamSource(new MediaStream([sa])).connect(dest);
  const ma = mic?.getAudioTracks()[0];
  if (ma) ctx.createMediaStreamSource(new MediaStream([ma])).connect(dest);
  return dest.stream;
}

async function buildCaptureStream(includeMic) {
  const screenStream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30, max: 60 } },
    audio: true,
  });

  let micStream = null;
  if (includeMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      micStream = null;
    }
  }

  const video = screenStream.getVideoTracks()[0];
  const hasSA = screenStream.getAudioTracks().length > 0;
  const hasMA = micStream?.getAudioTracks().length > 0;
  const tracks = [video];

  if (hasSA && hasMA) {
    const mixed = await mixAudio(screenStream, micStream);
    tracks.push(...mixed.getAudioTracks());
  } else if (hasMA) {
    tracks.push(...micStream.getAudioTracks());
  } else {
    tracks.push(...screenStream.getAudioTracks());
  }

  screenStream.getAudioTracks().forEach((t) => {
    if (!tracks.includes(t)) t.stop();
  });
  if (micStream) {
    micStream.getAudioTracks().forEach((t) => {
      if (!tracks.includes(t)) t.stop();
    });
  }

  return tracks;
}

function sendTracksToOffscreen(tracks) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const port = chrome.runtime.connect({ name: 'recorder' });

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };

    port.onMessage.addListener(function onReply(res) {
      if (res?.action !== 'START_RESULT') return;
      port.onMessage.removeListener(onReply);
      if (res.ok) finish(() => resolve());
      else finish(() => reject(new Error(res.error || 'Could not start background recorder.')));
    });

    port.onDisconnect.addListener(() => {
      finish(() => reject(new Error(chrome.runtime.lastError?.message || 'Recorder connection lost.')));
    });

    port.postMessage({ action: 'START_STREAM', tracks }, tracks);
  });
}

async function startRecording() {
  chrome.runtime.sendMessage({ type: 'RECORDER_UPDATE', status: 'picking' });

  let tracks = null;
  try {
    await chrome.runtime.sendMessage({ type: 'ENSURE_OFFSCREEN' });
    tracks = await buildCaptureStream(micToggle.checked);
    await sendTracksToOffscreen(tracks);
  } catch (err) {
    tracks?.forEach((t) => t.stop());
    if (err.name === 'NotAllowedError') {
      applyUpdate({ status: 'error', error: 'Screen sharing was cancelled.' });
    } else {
      applyUpdate({ status: 'error', error: err.message || 'Could not start recording.' });
    }
  }
}

function stopRecording() {
  chrome.runtime.sendMessage({ target: 'offscreen', action: 'STOP' });
  applyUpdate({ status: 'processing', progress: 'Preparing MP4…' });
}

function resetToIdle() {
  chrome.runtime.sendMessage({ target: 'offscreen', action: 'RESET' });
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
  if (state) applyUpdate(state);
});
