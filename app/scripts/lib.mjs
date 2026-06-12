/** Shared helpers for the setup/doctor scripts. */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const appDir = resolve(here, '..');                 // app/
export const projectRoot = resolve(appDir, '..');          // repo root
export const whisperDir = join(appDir, 'whisper');
export const ttsDir = join(appDir, 'tts');
export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

/** Resolve a command on PATH (cross-platform). Returns abs path or null. */
export function which(cmd) {
  if (isWin) {
    const r = spawnSync('where', [cmd], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() || null : null;
  }
  const r = spawnSync('command', ['-v', cmd], { shell: '/bin/sh', encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

/** Does this executable path actually launch? (catches dangling symlinks, wrong arch) */
export function runnable(path, args = ['--help']) {
  if (!path || !existsSync(path)) return false;
  const r = spawnSync(path, args, { stdio: 'ignore' });
  return r.status === 0 || r.status === 1; // --help/-version often exit 1; either means it ran
}

/** A symlink whose target no longer exists (left behind by a zip/AirDrop copy). */
export function isBrokenSymlink(p) {
  try { statSync(p); return false; } catch {
    try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
  }
}

export const log = (tag, m) => console.log(`[${tag}] ${m}`);
export const warn = (tag, m) => console.warn(`[${tag}] ${m}`);

export const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};
