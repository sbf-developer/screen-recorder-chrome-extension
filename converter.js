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

export async function convertToMp4(webmBlob, onProgress) {
  const ffmpeg = await getFFmpeg();

  const progressHandler = ({ progress }) => {
    if (onProgress && typeof progress === 'number') {
      onProgress(Math.round(Math.min(progress, 1) * 100));
    }
  };

  ffmpeg.on('progress', progressHandler);

  const inputName = 'input.webm';
  const outputName = 'output.mp4';

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(webmBlob));

    await ffmpeg.exec([
      '-i', inputName,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-y',
      outputName,
    ]);

    const data = await ffmpeg.readFile(outputName);
    return new Blob([data], { type: 'video/mp4' });
  } catch (err) {
    throw new Error(err.message || 'Could not convert to MP4.');
  } finally {
    ffmpeg.off('progress', progressHandler);
    try {
      await ffmpeg.deleteFile(inputName);
      await ffmpeg.deleteFile(outputName);
    } catch { /* files may not exist */ }
  }
}
