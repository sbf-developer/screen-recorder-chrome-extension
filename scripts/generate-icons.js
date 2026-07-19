const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ICONS_DIR = path.join(__dirname, '..', 'icons');

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function createPNG(size) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  const pad = 2 * (size / 24);

  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * (1 + size * 4) + 1 + x * 4;
      const fx = (x / size) * 24;
      const fy = (y / size) * 24;

      const inOuter = fx >= 3 && fx <= 21 && fy >= 4 && fy <= 17;
      const inInner = fx >= 5 && fx <= 19 && fy >= 6 && fy <= 15;
      const inDot = (fx - 12) ** 2 + (fy - 10) ** 2 <= 9;
      const inStand = Math.abs(fx - 12) <= 1.5 && fy >= 17 && fy <= 19;
      const inBase = Math.abs(fx - 12) <= 4.5 && fy >= 19 && fy <= 20;

      if (inDot) {
        raw[i] = 239; raw[i + 1] = 68; raw[i + 2] = 68; raw[i + 3] = 255;
      } else if (inInner) {
        raw[i] = 255; raw[i + 1] = 255; raw[i + 2] = 255; raw[i + 3] = 255;
      } else if (inOuter || inStand || inBase) {
        raw[i] = 10; raw[i + 1] = 10; raw[i + 2] = 10; raw[i + 3] = 255;
      } else {
        raw[i] = 0; raw[i + 1] = 0; raw[i + 2] = 0; raw[i + 3] = 0;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(ICONS_DIR, { recursive: true });
for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(ICONS_DIR, `icon${size}.png`), createPNG(size));
  console.log(`Created icon${size}.png`);
}
