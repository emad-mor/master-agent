#!/usr/bin/env node
/**
 * Strips the macOS `com.apple.quarantine` extended attribute from the project.
 *
 * Why this exists: when this project is delivered as a zip / archive / AirDrop,
 * macOS Gatekeeper stamps every extracted file with `com.apple.quarantine`.
 * Because the project *directory* is quarantined, npm then propagates that flag
 * onto everything it writes into node_modules — which makes the CLI shims
 * (next, etc.) fail to launch with a confusing "operation not permitted" error.
 *
 * This runs automatically as a `postinstall` step. It is a deliberate no-op on
 * any non-macOS platform (Linux, Windows, CI), and it never fails the install:
 * if `xattr` is missing or there's nothing to clean, it exits 0 quietly.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Only macOS carries the quarantine attribute; everywhere else this is unneeded.
if (process.platform !== 'darwin') {
  process.exit(0);
}

// scripts/ lives inside the npm package dir (app/), so the project root is two up.
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

// We deliberately AVOID `xattr -dr <dir>`: its recursive walk aborts on the
// first entry it can't stat (e.g. a dangling symlink left by a zip/AirDrop copy
// that points at the sender's machine), leaving the rest of the tree dirty.
//
// Instead, `find -xattrname` selects ONLY files that actually carry the flag and
// does not follow symlinks, so broken links are skipped rather than fatal. Each
// match is cleared independently, so one bad entry can't stop the others.
const r = spawnSync(
  'find',
  [projectRoot, '-xattrname', 'com.apple.quarantine', '-exec', 'xattr', '-d', 'com.apple.quarantine', '{}', ';'],
  { stdio: 'ignore' },
);

if (r.error) {
  // Non-fatal: log a gentle note but exit success so install always proceeds.
  console.warn('[unquarantine] Could not strip macOS quarantine (harmless): ' + r.error.message);
} else {
  console.log('[unquarantine] Cleared macOS quarantine flag from project.');
}
process.exit(0);
