#!/usr/bin/env node
/**
 * Dev launcher: starts the Kokoro neural-voice sidecar in the background, THEN
 * runs `next dev`. This makes the neural voice the DEFAULT on `npm run dev` —
 * no separate `npm run tts` terminal needed.
 *
 * Faithful to the rest of the setup scripts: it NEVER blocks or breaks the dev
 * server. If the venv/model is missing, python won't start, or anything else
 * goes wrong, it prints one warning and continues — the app simply falls back
 * to the browser's built-in speech voice (handled client-side in the widget).
 *
 * Behaviour:
 *   - If something is already serving Kokoro on :8001, reuse it (don't double-run).
 *   - Otherwise spawn the sidecar detached, piping its output to tts/sidecar.log.
 *   - Run `next dev` with inherited stdio (its output is what you watch).
 *   - On exit / Ctrl+C, tear the sidecar down too (only if WE started it).
 *
 * Skip the sidecar entirely with ARIA_NO_TTS=1 (browser voice only).
 */
import { spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { get } from 'node:http';
import { isWin, ttsDir, appDir, log, warn } from './lib.mjs';

const TAG = 'dev';
const PORT = process.env.NEXT_PORT || '3939';
const KOKORO_PORT = 8001;

const venvPy = isWin ? join(ttsDir, '.venv', 'Scripts', 'python.exe')
                     : join(ttsDir, '.venv', 'bin', 'python');
const server = join(ttsDir, 'server.py');
const model = join(ttsDir, 'kokoro-v1.0.onnx');
const logFile = join(ttsDir, 'sidecar.log');

/** Is something already answering on the Kokoro health endpoint? */
function kokoroAlreadyUp(timeoutMs = 600) {
  return new Promise((resolve) => {
    const req = get({ host: '127.0.0.1', port: KOKORO_PORT, path: '/health', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Start the Kokoro sidecar in the background. Returns the child, or null if we couldn't/shouldn't. */
function startSidecar() {
  if (process.env.ARIA_NO_TTS === '1') {
    log(TAG, 'ARIA_NO_TTS=1 — skipping neural voice (browser voice will be used).');
    return null;
  }
  if (!existsSync(venvPy)) {
    warn(TAG, 'TTS venv missing — neural voice off, using browser voice. Provision it with: npm run setup:tts');
    return null;
  }
  if (!existsSync(model)) {
    warn(TAG, 'Kokoro model missing — neural voice off, using browser voice. See README → "Voice setup".');
    return null;
  }

  const out = openSync(logFile, 'a');
  const child = spawn(venvPy, [server], {
    cwd: ttsDir,
    stdio: ['ignore', out, out],   // sidecar logs go to tts/sidecar.log, not the dev console
    windowsHide: true,
  });
  child.on('error', (err) => {
    warn(TAG, `Could not start neural voice (${err.message}) — using browser voice.`);
  });
  log(TAG, `Neural voice (Kokoro) starting on http://127.0.0.1:${KOKORO_PORT} — logs: tts/sidecar.log`);
  return child;
}

async function main() {
  let sidecar = null;
  if (await kokoroAlreadyUp()) {
    log(TAG, `Neural voice already running on http://127.0.0.1:${KOKORO_PORT} — reusing it.`);
  } else {
    sidecar = startSidecar();
  }

  // Run Next.js in the foreground — this is the process you interact with.
  const npx = isWin ? 'npx.cmd' : 'npx';
  const next = spawn(npx, ['next', 'dev', '--turbopack', '-p', PORT], {
    cwd: appDir,
    stdio: 'inherit',
    shell: isWin,           // .cmd shims need a shell on Windows
  });

  // Tear down the sidecar when the dev server ends or we're interrupted —
  // but only if WE started it (don't kill a sidecar someone else is using).
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (sidecar && !sidecar.killed) {
      try { sidecar.kill('SIGTERM'); } catch {}
    }
  };

  next.on('exit', (code) => { cleanup(); process.exit(code ?? 0); });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { cleanup(); try { next.kill(sig); } catch {} });
  }
}

main();
