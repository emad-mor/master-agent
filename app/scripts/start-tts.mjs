#!/usr/bin/env node
/**
 * Cross-platform launcher for the Kokoro TTS sidecar (http://127.0.0.1:8001).
 * Mirrors tts/start-tts.ps1 for macOS/Linux. Run it in its own terminal and
 * leave it open while using voice output. Exits non-zero with guidance if the
 * venv or model is missing (unlike the install scripts, this is run on purpose).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isWin, ttsDir } from './lib.mjs';

const venvPy = isWin ? join(ttsDir, '.venv', 'Scripts', 'python.exe')
                     : join(ttsDir, '.venv', 'bin', 'python');
const server = join(ttsDir, 'server.py');

if (!existsSync(venvPy)) {
  console.error('TTS venv missing. Run: npm run setup:tts');
  process.exit(1);
}
if (!existsSync(join(ttsDir, 'kokoro-v1.0.onnx'))) {
  console.error('Kokoro model missing. See README → "Voice setup".');
  process.exit(1);
}

console.log('Kokoro TTS sidecar on http://127.0.0.1:8001 — Ctrl+C to stop.');
const r = spawnSync(venvPy, [server], { stdio: 'inherit', cwd: ttsDir });
process.exit(r.status ?? 0);
