#!/usr/bin/env node
/**
 * Runs after every `npm install`. Orchestrates cross-platform provisioning so a
 * teammate's first `npm install` gets them as close to "ready" as possible.
 * Each step is self-contained and guaranteed NOT to fail the install:
 *   1. unquarantine  — strip macOS Gatekeeper quarantine (no-op off macOS)
 *   2. setup-whisper — install ffmpeg + native whisper-cli (no-op on Windows)
 *   3. setup-tts     — build the Kokoro Python venv (optional; no-op on Windows)
 *   4. doctor        — print a readiness banner; loud if a REQUIRED dep (the
 *                      claude CLI, which needs interactive login) is missing.
 *
 * The claude CLI is intentionally NOT auto-installed: `npm i -g` inside a
 * postinstall is fragile, and it needs a manual `claude` login anyway. The
 * doctor flags it loudly with the exact command instead.
 *
 * Set ARIA_SKIP_SETUP=1 to skip the heavy steps (CI, Docker builds, etc.).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const run = (step) => spawnSync(process.execPath, [join(here, step)], { stdio: 'inherit' });

if (process.env.ARIA_SKIP_SETUP === '1') {
  console.log('[postinstall] ARIA_SKIP_SETUP=1 — skipping environment setup.');
  process.exit(0);
}

for (const step of ['unquarantine.mjs', 'setup-whisper.mjs', 'setup-tts.mjs', 'doctor.mjs']) {
  run(step); // never throw — each script swallows its own errors and exits 0
}
