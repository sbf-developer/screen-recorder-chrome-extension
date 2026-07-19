import { convertToMp4 } from './converter.js';

const MIME_CANDIDATES = [
  'video/mp4;codecs=h264,aac',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

let mediaRecorder = null;
let recordedChunks = [];
let screenStream = null;
let micStream = null;
let combinedStream = null;
let timerInterval = null;
let startTime = null;
let selectedMimeType = '';

function broadcast(update) {
  chrome.runtime.sendMessage({ type: 'RECORDER_UPDATE', ...update }).catch(() => {});
}

function setBadge(text) {
  chrome.runtime.sendMessage({ type: 'SET_BADGE', text }).catch(() => {});
}

function getSupportedMimeType() {
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function cleanupStreams() {
  [combinedStream, screenStream, micStream].forEach((s) => {
    s?.getTracks().forEach((t) => t.stop());
  });
  combinedStream = screenStream = micStream = null;
}

function formatTimer(ms) {
  const sec = Math.floor(ms / 1000);
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

function startTimerLoop() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!startTime) return;
    broadcast({ status: 'recording', timer: formatTimer(Date.now() - startTime), startedAt: startTime });
  }, 500);
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

async function startRecording(includeMic) {
  try {
    selectedMimeType = getSupportedMimeType();
    if (!selectedMimeType) throw new Error('No supported video format.');

    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: true,
    });

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
    let audioTracks = [];

    if (hasSA && hasMA) {
      const mixed = await mixAudio(screenStream, micStream);
      audioTracks = mixed.getAudioTracks();
    } else if (hasMA) {
      audioTracks = micStream.getAudioTracks();
    } else {
      audioTracks = screenStream.getAudioTracks();
    }

    combinedStream = new MediaStream([video, ...audioTracks]);

    video.addEventListener('ended', () => {
      if (mediaRecorder?.state === 'recording') stopRecording();
    });

    recordedChunks = [];
    mediaRecorder = new MediaRecorder(combinedStream, {
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
  } catch (err) {
    cleanupStreams();
    const msg = err.name === 'NotAllowedError'
      ? 'Screen sharing was cancelled.'
      : (err.message || 'Could not start recording.');
    broadcast({ status: 'error', error: msg });
  }
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
      broadcast({ status: 'processing', progress: 'Loading encoder…' });
      let convertPct = 0;
      const convertStart = Date.now();
      const convertInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - convertStart) / 1000);
        const label = convertPct > 0
          ? `Converting… ${convertPct}%`
          : `Converting… ${elapsed}s`;
        broadcast({ status: 'processing', progress: label });
      }, 1000);

      try {
        mp4 = await convertToMp4(blob, (pct) => {
          convertPct = pct;
          broadcast({ status: 'processing', progress: `Converting… ${pct}%` });
        });
      } finally {
        clearInterval(convertInterval);
      }
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  if (msg.action === 'START') {
    startRecording(msg.includeMic);
    sendResponse({ ok: true });
  } else if (msg.action === 'STOP') {
    stopRecording();
    sendResponse({ ok: true });
  } else if (msg.action === 'RESET') {
    cleanupStreams();
    recordedChunks = [];
    mediaRecorder = null;
    clearInterval(timerInterval);
    setBadge('');
    broadcast({ status: 'idle', timer: '00:00', progress: '', error: '', startedAt: 0 });
    sendResponse({ ok: true });
  } else if (msg.action === 'PING') {
    sendResponse({ ok: true });
  }
  return true;
});
