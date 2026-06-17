#!/usr/bin/env node
/**
 * Provisions the voice-input (speech-to-text) toolchain that the transcribe API
 * (app/src/app/api/transcribe/route.ts) shells out to:
 *   - whisper-cli : Windows ships whisper-cli.exe; mac/Linux need a native build.
 *   - ffmpeg      : must be on PATH on every platform.
 *
 * On macOS this auto-installs both via Homebrew and symlinks whisper-cli into
 * app/whisper/. It is idempotent (skips work already done) and NEVER fails the
 * install — every problem degrades to a warning + exit 0. No-op on Windows.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { which, runnable, isBrokenSymlink, isWin, isMac, whisperDir, log, warn } from './lib.mjs';

const TAG = 'setup-whisper';
const binPath = join(whisperDir, 'whisper-cli');

// Windows ships its own whisper-cli.exe and uses winget for ffmpeg (README).
if (isWin) process.exit(0);

function linkInto(target) {
  try {
    // whisper/ is gitignored, so on a fresh clone it may not exist yet — create
    // it before symlinking, or symlinkSync throws ENOENT and voice input breaks.
    mkdirSync(whisperDir, { recursive: true });
    if (existsSync(binPath) || isBrokenSymlink(binPath)) rmSync(binPath, { force: true });
    symlinkSync(target, binPath);
    log(TAG, `Linked whisper-cli -> ${target}`);
  } catch (e) {
    warn(TAG, `Could not create symlink: ${e.message}`);
  }
}

// --- ffmpeg ---
function ensureFfmpeg(brew) {
  if (which('ffmpeg')) return;
  if (!brew) { warn(TAG, 'ffmpeg missing. Install it: brew install ffmpeg'); return; }
  log(TAG, 'Installing ffmpeg via Homebrew…');
  const r = spawnSync(brew, ['install', 'ffmpeg'], { stdio: 'inherit' });
  if (r.status !== 0) warn(TAG, 'brew install ffmpeg failed — install it manually.');
}

// --- whisper-cli ---
function ensureWhisper(brew) {
  if (runnable(binPath)) { log(TAG, 'whisper-cli already present and runnable.'); return; }

  if (isMac) {
    if (!brew) {
      warn(TAG, 'Homebrew not found. Install from https://brew.sh, then run: npm run setup:whisper');
      return;
    }
    let brewBin = which('whisper-cli');
    if (!brewBin) {
      log(TAG, 'Installing whisper-cpp via Homebrew (one-time, ~1-2 min)…');
      const r = spawnSync(brew, ['install', 'whisper-cpp'], { stdio: 'inherit' });
      if (r.status !== 0) { warn(TAG, 'brew install whisper-cpp failed. Run: npm run setup:whisper'); return; }
      brewBin = which('whisper-cli');
    }
    if (brewBin && runnable(brewBin)) linkInto(brewBin);
    else warn(TAG, 'whisper-cli not on PATH after install. Run: npm run setup:whisper');
    return;
  }

  // Linux & other unix: no universal installer.
  warn(TAG, `Native whisper-cli not found. Build whisper.cpp and symlink its whisper-cli to ${binPath}.`);
}

const brew = isMac ? which('brew') : null;
ensureFfmpeg(brew);
ensureWhisper(brew);
process.exit(0);
