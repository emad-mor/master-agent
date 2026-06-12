#!/usr/bin/env node
/**
 * Readiness report for Aria's runtime dependencies. npm install can provision
 * most of these, but some (the claude CLI login, OS package managers) are
 * machine-level and can't be guaranteed — this tells the user exactly what's
 * green and what still needs a hand.
 *
 * Runs at the tail of postinstall (loud banner if anything required is missing)
 * and on demand via `npm run doctor`. Always exits 0 so it never wedges install.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { which, runnable, isWin, whisperDir, ttsDir, C } from './lib.mjs';

const checks = [];
function check({ name, required, ok, fixMac, fixWin, note }) {
  checks.push({ name, required, ok, fix: isWin ? fixWin : fixMac, note });
}

// --- claude CLI: Aria's brain. Without it the app does nothing. ---
const claudeBin = isWin ? 'claude.cmd' : 'claude';
const claude = which(claudeBin) || which('claude');
check({
  name: 'claude CLI',
  required: true,
  ok: !!claude,
  note: claude ? 'found — make sure you have run `claude` once to log in' : 'the agent brain',
  fixMac: 'npm i -g @anthropic-ai/claude-code   (then run `claude` once to log in)',
  fixWin: 'npm i -g @anthropic-ai/claude-code   (then run `claude` once to log in)',
});

// --- ffmpeg: required for voice input (STT pipeline). ---
check({
  name: 'ffmpeg',
  required: false,
  ok: !!which(isWin ? 'ffmpeg.exe' : 'ffmpeg'),
  note: 'voice input',
  fixMac: 'brew install ffmpeg',
  fixWin: 'winget install Gyan.FFmpeg',
});

// --- whisper-cli: STT engine. Windows ships .exe; mac/Linux need native. ---
const whisperBin = join(whisperDir, isWin ? 'whisper-cli.exe' : 'whisper-cli');
check({
  name: 'whisper-cli',
  required: false,
  ok: runnable(whisperBin),
  note: 'speech-to-text',
  fixMac: 'npm run setup:whisper   (needs Homebrew)',
  fixWin: '(should ship with the repo — re-extract the zip)',
});

// --- whisper model. ---
check({
  name: 'whisper model',
  required: false,
  ok: existsSync(join(whisperDir, 'ggml-small.en.bin')),
  note: 'ggml-small.en.bin (~466 MB)',
  fixMac: 'download ggml-small.en.bin into app/whisper/ (see README)',
  fixWin: 'download ggml-small.en.bin into app\\whisper\\ (see README)',
});

// --- TTS sidecar venv (optional — browser voice is the fallback). ---
const venvPy = isWin ? join(ttsDir, '.venv', 'Scripts', 'python.exe')
                     : join(ttsDir, '.venv', 'bin', 'python');
check({
  name: 'TTS voice (Kokoro)',
  required: false,
  ok: runnable(venvPy, ['--version']),
  note: 'optional — falls back to browser voice',
  fixMac: 'npm run setup:tts   (needs python3)',
  fixWin: 'see app\\tts\\start-tts.ps1',
});

// --- render ---
const missingRequired = checks.filter((c) => c.required && !c.ok);
const missingOptional = checks.filter((c) => !c.required && !c.ok);

console.log('\n' + C.bold('  Aria readiness check'));
for (const c of checks) {
  const mark = c.ok ? C.green('✓') : (c.required ? C.red('✗') : C.yellow('○'));
  const tag = c.required ? '' : C.dim(' (optional)');
  let line = `  ${mark} ${c.name}${tag}`;
  if (c.ok && c.note) line += C.dim(`  — ${c.note}`);
  console.log(line);
  if (!c.ok) console.log(C.dim(`      fix: ${c.fix}`));
}

if (missingRequired.length) {
  console.log('\n' + C.red(C.bold('  ⚠ Aria will NOT work until the required items above are installed.')));
} else if (missingOptional.length) {
  console.log('\n' + C.green('  Core is ready.') + C.dim(' Optional voice features may be limited — see above.'));
} else {
  console.log('\n' + C.green(C.bold('  ✓ Everything is ready. Run `npm run dev`.')));
}
console.log('');
process.exit(0);
