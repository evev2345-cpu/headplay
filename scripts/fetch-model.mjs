import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const modelDir = path.join(rootDir, 'assets', 'models');
const modelPath = path.join(modelDir, 'face_landmarker.task');

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

async function main() {
  fs.mkdirSync(modelDir, { recursive: true });

  if (fs.existsSync(modelPath)) {
    const stat = fs.statSync(modelPath);
    if (stat.size > 1_000_000) {
      console.log(`[fetch-model] Existing model found (${(stat.size / 1024 / 1024).toFixed(2)} MB): ${modelPath}`);
      return;
    }
  }

  console.log(`[fetch-model] Downloading MediaPipe Face Landmarker model...`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) {
    throw new Error(`Failed to download model: HTTP ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength < 1_000_000) {
    throw new Error(`Downloaded model looks unexpectedly small (${buf.byteLength} bytes).`);
  }

  fs.writeFileSync(modelPath, buf);
  console.log(`[fetch-model] Saved ${(buf.byteLength / 1024 / 1024).toFixed(2)} MB to ${modelPath}`);
}

main().catch((err) => {
  console.error('[fetch-model] Error:', err);
  process.exit(1);
});
