#!/usr/bin/env node
/**
 * Provisions the OPTIONAL Kokoro TTS sidecar (tts/server.py) on macOS/Linux:
 * builds tts/.venv with python3 and installs tts/requirements.txt into it.
 *
 * Optional because the app falls back to the browser's built-in speech voice if
 * the sidecar isn't running. So this NEVER fails the install — missing python3
 * or a failed pip just prints guidance and exits 0. No-op on Windows (which has
 * its own .venv + start-tts.ps1).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { which, runnable, isWin, ttsDir, log, warn } from './lib.mjs';

const TAG = 'setup-tts';
const venvDir = join(ttsDir, '.venv');
const venvPy = join(venvDir, 'bin', 'python');           // unix layout
const model = join(ttsDir, 'kokoro-v1.0.onnx');
const reqs = join(ttsDir, 'requirements.txt');

if (isWin) process.exit(0); // Windows uses the shipped .venv + start-tts.ps1

// Already built and runnable? Done.
if (runnable(venvPy, ['--version'])) {
  log(TAG, 'TTS venv already present. Skipping.');
  process.exit(0);
}

const py = which('python3') || which('python');
if (!py) {
  warn(TAG, 'python3 not found — neural voice disabled (browser voice will be used). Install python3 then: npm run setup:tts');
  process.exit(0);
}

if (!existsSync(model)) {
  warn(TAG, 'Kokoro model (kokoro-v1.0.onnx) missing — neural voice unavailable. See README → "Voice setup".');
  // still build the venv so it's ready once the model is added
}

// The shipped .venv is a Windows venv (Scripts/, no bin/) — unusable here.
// `python -m venv` happily overwrites/creates the unix layout in place.
log(TAG, 'Creating Python venv for the TTS sidecar…');
let r = spawnSync(py, ['-m', 'venv', venvDir], { stdio: 'inherit' });
if (r.status !== 0 || !existsSync(venvPy)) {
  warn(TAG, 'Could not create venv — neural voice disabled (browser voice will be used).');
  process.exit(0);
}

log(TAG, 'Installing TTS Python deps (one-time, may take a minute)…');
r = spawnSync(venvPy, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '-r', reqs], { stdio: 'inherit' });
if (r.status !== 0) {
  warn(TAG, 'pip install failed — neural voice disabled (browser voice will be used). Retry: npm run setup:tts');
  process.exit(0);
}

log(TAG, 'TTS sidecar ready. Start it with: npm run tts');
process.exit(0);
