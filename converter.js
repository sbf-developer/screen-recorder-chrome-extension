import { FFmpeg } from './lib/ffmpeg/index.js';
import { fetchFile, toBlobURL } from './lib/util/index.js';

let ffmpegInstance = null;
let loadPromise = null;

async function loadFFmpeg() {
  const ffmpeg = new FFmpeg();
  const base = chrome.runtime.getURL('lib/ffmpeg');
  const workerURL = `${base}/worker.js`;

  try {
    await ffmpeg.load({
      classWorkerURL: workerURL,
      coreURL: `${base}/ffmpeg-core.js`,
      wasmURL: `${base}/ffmpeg-core.wasm`,
    });
  } catch {
    await ffmpeg.load({
      classWorkerURL: workerURL,
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
    });
  }

  return ffmpeg;
}

async function getFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  if (!loadPromise) loadPromise = loadFFmpeg().then((ff) => { ffmpegInstance = ff; return ff; });
  return loadPromise;
}

export async function convertToMp4(inputBlob, onProgress, isMp4 = false) {
  const ffmpeg = await getFFmpeg();

  const progressHandler = ({ progress }) => {
    if (onProgress && typeof progress === 'number' && Number.isFinite(progress)) {
      const clamped = Math.max(0, Math.min(progress, 1));
      onProgress(Math.round(clamped * 100));
    }
  };

  ffmpeg.on('progress', progressHandler);
  ffmpeg.on('log', ({ message }) => {
    console.log('[ffmpeg]', message);
  });

  const inputName = isMp4 ? 'input.mp4' : 'input.webm';
  const outputName = 'output.mp4';

  const audioArgs = ['-c:a', 'aac', '-b:a', '128k'];
  const fastVideoArgs = ['-c:v', 'copy'];
  const slowVideoArgs = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23'];
  const muxArgs = ['-movflags', '+faststart', '-y', outputName];

  async function run(videoArgs) {
    await ffmpeg.exec(['-i', inputName, ...videoArgs, ...audioArgs, ...muxArgs]);
    const data = await ffmpeg.readFile(outputName);
    return new Blob([data], { type: 'video/mp4' });
  }

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(inputBlob));

    // If input is already H.264 MP4, just copy video and transcode audio to AAC (fast).
    // Fall back to full re-encode if the video stream isn't copyable.
    if (isMp4) {
      try {
        return await run(fastVideoArgs);
      } catch {
        return await run(slowVideoArgs);
      }
    }
    return await run(slowVideoArgs);
  } catch (err) {
    throw new Error(err.message || 'Could not convert to MP4.');
  } finally {
    ffmpeg.off('progress', progressHandler);
    ffmpeg.off('log');
    try {
      await ffmpeg.deleteFile(inputName);
      await ffmpeg.deleteFile(outputName);
    } catch { /* files may not exist */ }
  }
}
