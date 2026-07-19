const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const FFMPEG_DIR = path.join(ROOT, 'lib', 'ffmpeg');
const UTIL_DIR = path.join(ROOT, 'lib', 'util');
const CORE_VERSION = '0.12.10';

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`  copied ${path.relative(ROOT, dest)}`);
}

function copyDir(srcDir, destDir, files) {
  for (const file of files) {
    const src = path.join(srcDir, file);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing: ${src}`);
    }
    copyFile(src, path.join(destDir, file));
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest);
        return download(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed (${response.statusCode}): ${url}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log(`  downloaded ${path.relative(ROOT, dest)}`);
        resolve();
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('Building extension assets...\n');

  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    console.error('Run npm install first.');
    process.exit(1);
  }

  copyDir(
    path.join(ROOT, 'node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm'),
    FFMPEG_DIR,
    ['index.js', 'classes.js', 'const.js', 'errors.js', 'types.js', 'utils.js', 'worker.js']
  );

  copyDir(
    path.join(ROOT, 'node_modules', '@ffmpeg', 'util', 'dist', 'esm'),
    UTIL_DIR,
    ['index.js', 'const.js', 'errors.js', 'types.js']
  );

  copyFile(
    path.join(ROOT, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm', 'ffmpeg-core.js'),
    path.join(FFMPEG_DIR, 'ffmpeg-core.js')
  );

  const wasmPath = path.join(FFMPEG_DIR, 'ffmpeg-core.wasm');
  if (!fs.existsSync(wasmPath)) {
    await download(
      `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm/ffmpeg-core.wasm`,
      wasmPath
    );
  } else {
    console.log('  lib/ffmpeg/ffmpeg-core.wasm already present');
  }

  console.log('\nBuild complete.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
