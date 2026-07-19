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
let screenStream = null;
let micStream = null;
let combinedStream = null;
let timerInterval = null;
let startTime = null;
let selectedMimeType = '';

function broadcast(update) {
  chrome.runtime.sendMessage({ type: 'RECORDER_UPDATE', ...update });
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

async function mixAudio(screen, mic) {
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const sa = screen.getAudioTracks()[0];
  if (sa) ctx.createMediaStreamSource(new MediaStream([sa])).connect(dest);
  const ma = mic?.getAudioTracks()[0];
  if (ma) ctx.createMediaStreamSource(new MediaStream([ma])).connect(dest);
  return dest.stream;
}

async function buildStream(includeMic) {
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

  if (hasSA && hasMA) {
    const mixed = await mixAudio(screenStream, micStream);
    combinedStream = new MediaStream([video, ...mixed.getAudioTracks()]);
  } else if (hasMA) {
    combinedStream = new MediaStream([video, ...micStream.getAudioTracks()]);
  } else {
    combinedStream = new MediaStream([video, ...screenStream.getAudioTracks()]);
  }

  video.addEventListener('ended', () => {
    if (mediaRecorder?.state === 'recording') stopRecording();
  });

  return combinedStream;
}

async function startRecording(includeMic) {
  try {
    selectedMimeType = getSupportedMimeType();
    if (!selectedMimeType) throw new Error('No supported video format.');

    const stream = await buildStream(includeMic);
    recordedChunks = [];

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
    timerInterval = setInterval(() => {
      const sec = Math.floor((Date.now() - startTime) / 1000);
      const m = String(Math.floor(sec / 60)).padStart(2, '0');
      const s = String(sec % 60).padStart(2, '0');
      broadcast({ state: 'recording', timer: `${m}:${s}` });
    }, 500);

    broadcast({ state: 'recording', timer: '00:00' });
  } catch (err) {
    cleanupStreams();
    const msg = err.name === 'NotAllowedError'
      ? 'Screen sharing was cancelled.'
      : (err.message || 'Could not start recording.');
    broadcast({ state: 'error', error: msg });
  }
}

function stopRecording() {
  clearInterval(timerInterval);
  if (mediaRecorder?.state === 'recording') {
    mediaRecorder.requestData();
    mediaRecorder.stop();
  }
}

async function finishRecording() {
  clearInterval(timerInterval);

  if (recordedChunks.length === 0) {
    broadcast({ state: 'error', error: 'No video captured.' });
    return;
  }

  broadcast({ state: 'processing', progress: 'Preparing MP4…' });

  try {
    const blob = new Blob(recordedChunks, { type: selectedMimeType });
    recordedChunks = [];
    mediaRecorder = null;

    let mp4 = blob;
    if (!selectedMimeType.startsWith('video/mp4')) {
      mp4 = await convertToMp4(blob, (pct) => {
        broadcast({ state: 'processing', progress: `Converting… ${pct}%` });
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

    broadcast({ state: 'done' });
  } catch (err) {
    console.error(err);
    broadcast({ state: 'error', error: err.message || 'Failed to process recording.' });
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
  } else if (msg.action === 'PING') {
    sendResponse({ ok: true });
  }
  return true;
});
