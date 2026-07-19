import { convertToMp4 } from './converter.js';

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4;codecs=h264,aac',
  'video/mp4',
];

let mediaRecorder = null;
let recordedChunks = [];
let combinedStream = null;
let timerInterval = null;
let startTime = null;
let selectedMimeType = '';

function broadcast(update) {
  chrome.runtime.sendMessage({ type: 'RECORDER_UPDATE', ...update });
}

function setBadge(text) {
  chrome.runtime.sendMessage({ type: 'SET_BADGE', text });
}

function getSupportedMimeType() {
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function cleanupStreams() {
  combinedStream?.getTracks().forEach((t) => t.stop());
  combinedStream = null;
}

function formatTimer(ms) {
  const sec = Math.floor(ms / 1000);
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

function startTimerLoop() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!startTime) return;
    broadcast({
      status: 'recording',
      timer: formatTimer(Date.now() - startTime),
      startedAt: startTime,
    });
  }, 500);
}

async function beginRecording(stream) {
  selectedMimeType = getSupportedMimeType();
  if (!selectedMimeType) throw new Error('No supported video format.');

  combinedStream = stream;
  recordedChunks = [];

  const video = stream.getVideoTracks()[0];
  video?.addEventListener('ended', () => {
    if (mediaRecorder?.state === 'recording') stopRecording();
  });

  mediaRecorder = new MediaRecorder(stream, {
    mimeType: selectedMimeType,
    videoBitsPerSecond: 2_500_000,
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    cleanupStreams();
    finishRecording();
  };

  mediaRecorder.start(1000);
  startTime = Date.now();
  startTimerLoop();
  setBadge('REC');
  broadcast({ status: 'recording', timer: '00:00', error: '', progress: '', startedAt: startTime });
}

function stopRecording() {
  clearInterval(timerInterval);
  setBadge('');
  if (mediaRecorder?.state === 'recording') {
    broadcast({ status: 'processing', progress: 'Preparing MP4…' });
    mediaRecorder.requestData();
    mediaRecorder.stop();
  }
}

async function finishRecording() {
  clearInterval(timerInterval);
  setBadge('');

  if (recordedChunks.length === 0) {
    broadcast({ status: 'error', error: 'No video captured.' });
    return;
  }

  broadcast({ status: 'processing', progress: 'Preparing MP4…' });

  try {
    const blob = new Blob(recordedChunks, { type: selectedMimeType });
    recordedChunks = [];
    mediaRecorder = null;

    let mp4 = blob;
    if (!selectedMimeType.startsWith('video/mp4')) {
      mp4 = await convertToMp4(blob, (pct) => {
        broadcast({ status: 'processing', progress: `Converting… ${pct}%` });
      });
    }

    const url = URL.createObjectURL(mp4);
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const filename = `screen-recording-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.mp4`;

    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD', url, filename }, (res) => {
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (res?.ok) resolve();
        else reject(new Error(res?.error || 'Download failed'));
      });
    });

    broadcast({ status: 'done', progress: '', error: '' });
  } catch (err) {
    console.error(err);
    broadcast({ status: 'error', error: err.message || 'Failed to process recording.' });
  }
}

let bridge = null;

function connectBridge() {
  bridge = chrome.runtime.connect({ name: 'recorder-offscreen' });

  bridge.onMessage.addListener(async (msg) => {
    if (msg.action !== 'START_STREAM') return;

    try {
      const tracks = msg.tracks || [];
      if (!tracks.length) throw new Error('No media tracks received.');
      await beginRecording(new MediaStream(tracks));
      bridge?.postMessage({ action: 'START_RESULT', ok: true });
    } catch (err) {
      broadcast({ status: 'error', error: err.message || 'Could not start recording.' });
      bridge?.postMessage({ action: 'START_RESULT', ok: false, error: err.message });
    }
  });

  // SW may restart; reconnect to restore messaging. Recording keeps running.
  bridge.onDisconnect.addListener(() => {
    bridge = null;
    setTimeout(connectBridge, 300);
  });
}

connectBridge();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  if (msg.action === 'STOP') {
    stopRecording();
    sendResponse({ ok: true });
  } else if (msg.action === 'PING') {
    sendResponse({ ok: true });
  } else if (msg.action === 'RESET') {
    cleanupStreams();
    recordedChunks = [];
    mediaRecorder = null;
    clearInterval(timerInterval);
    setBadge('');
    broadcast({ status: 'idle', timer: '00:00', progress: '', error: '', startedAt: 0 });
    sendResponse({ ok: true });
  }
  return true;
});
