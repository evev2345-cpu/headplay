import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const watchMode = process.argv.includes('--watch');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(srcDir, destDir) {
  ensureDir(destDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Generates a minimal valid RGBA PNG icon (dark navy background with sky-blue eye ring)
// using Node built-in zlib so unpacked Chrome loading has valid icons without extra deps.
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function createIconPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const rOuter = size * 0.42;
  const rInner = size * 0.22;
  const rPupil = size * 0.12;

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      const px = rowStart + 1 + x * 4;

      let r = 15, g = 23, b = 42, a = 255; // #0f172a
      if (d <= rPupil) {
        r = 34; g = 197; b = 94; // #22c55e pupil
      } else if (d <= rInner) {
        r = 248; g = 250; b = 252; // #f8fafc sclera
      } else if (d <= rOuter) {
        r = 56; g = 189; b = 248; // #38bdf8 ring
      }

      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function copyStaticAssets() {
  ensureDir(distDir);

  copyFile(path.join(rootDir, 'manifest.json'), path.join(distDir, 'manifest.json'));
  copyFile(
    path.join(rootDir, 'src/extension/offscreen/offscreen.html'),
    path.join(distDir, 'offscreen.html'),
  );
  copyFile(
    path.join(rootDir, 'src/extension/permission/permission.html'),
    path.join(distDir, 'permission.html'),
  );
  copyFile(
    path.join(rootDir, 'src/extension/popup/popup.html'),
    path.join(distDir, 'popup.html'),
  );
  copyFile(
    path.join(rootDir, 'src/extension/popup/popup.css'),
    path.join(distDir, 'popup.css'),
  );

  // Icons
  const iconsDir = path.join(distDir, 'icons');
  ensureDir(iconsDir);
  for (const size of [16, 48, 128]) {
    fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), createIconPng(size));
  }

  // Local MediaPipe WASM files (no runtime CDN requests)
  const wasmSrc = path.join(rootDir, 'node_modules/@mediapipe/tasks-vision/wasm');
  if (!fs.existsSync(wasmSrc)) {
    throw new Error(`MediaPipe WASM directory not found at ${wasmSrc}. Run "npm install" first.`);
  }
  copyDir(wasmSrc, path.join(distDir, 'vendor/mediapipe/wasm'));

  // Local Face Landmarker model
  const modelSrc = path.join(rootDir, 'assets/models/face_landmarker.task');
  if (!fs.existsSync(modelSrc)) {
    throw new Error(
      `Local model not found at ${modelSrc}. Run "npm run fetch-model" to download face_landmarker.task for offline bundling.`,
    );
  }
  copyFile(modelSrc, path.join(distDir, 'vendor/mediapipe/face_landmarker.task'));
}

async function build() {
  copyStaticAssets();

  const common = {
    bundle: true,
    sourcemap: true,
    target: ['chrome116'],
    logLevel: 'info',
  };

  const configs = [
    {
      ...common,
      entryPoints: [path.join(rootDir, 'src/extension/background/index.ts')],
      outfile: path.join(distDir, 'background.js'),
      format: 'esm',
    },
    {
      ...common,
      entryPoints: [path.join(rootDir, 'src/extension/offscreen/index.ts')],
      outfile: path.join(distDir, 'offscreen.js'),
      format: 'iife',
    },
    {
      ...common,
      entryPoints: [path.join(rootDir, 'src/extension/permission/index.ts')],
      outfile: path.join(distDir, 'permission.js'),
      format: 'iife',
    },
    {
      ...common,
      entryPoints: [path.join(rootDir, 'src/extension/popup/index.ts')],
      outfile: path.join(distDir, 'popup.js'),
      format: 'iife',
    },
    {
      ...common,
      entryPoints: [path.join(rootDir, 'src/extension/content/youtube.ts')],
      outfile: path.join(distDir, 'youtube-content.js'),
      format: 'iife',
    },
  ];

  if (watchMode) {
    const contexts = await Promise.all(configs.map((cfg) => esbuild.context(cfg)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('[build] Watching for changes... Output in dist/');
  } else {
    await Promise.all(configs.map((cfg) => esbuild.build(cfg)));
    console.log('[build] Extension bundle ready in dist/');
  }
}

build().catch((err) => {
  console.error('[build] Failed:', err);
  process.exit(1);
});
