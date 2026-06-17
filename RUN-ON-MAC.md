# Run Daryan on a Mac

Copy-paste these. The installer handles **everything** — Homebrew, Node, Python,
ffmpeg, the Claude Code CLI, the app's dependencies, and the neural-voice models
(~800 MB) — and it **verifies the voice actually works** before finishing.

## 1. Download + install (one command)

Open **Terminal** and paste:

```bash
cd ~
git clone https://github.com/emad-mor/master-agent.git
cd master-agent
bash install.sh
```

It's safe to re-run. At the end it prints a readiness report and a line like
`✓ Neural voice verified — it produced audio.`

## 2. Open a NEW Terminal window

So `node` and `claude` are on your PATH. (The installer added Homebrew to your
shell profile; a fresh window picks it up.)

## 3. Log in to Claude (one time)

Daryan thinks using the Claude Code CLI, which needs a **Claude / Anthropic
account**:

```bash
claude
```

Follow the browser prompt to sign in, then press **Ctrl-C** to exit.

## 4. Start it

```bash
cd ~/master-agent/app && npm run dev
```

Then open **http://localhost:3939**. The neural voice starts automatically.
Stop with **Ctrl-C**.

---

### Requirements
- A Mac (macOS), Apple Silicon or Intel.
- A Claude / Anthropic account (for the one-time `claude` login).

### Troubleshooting
- **"command not found: claude / npm"** → you're in the old Terminal; open a new
  window (step 2), or run `eval "$(/opt/homebrew/bin/brew shellenv)"`.
- **No voice / falls back to "browser voice"** → re-run `bash install.sh` (it
  resumes any model download that was interrupted and re-verifies voice).
- **Check what's ready anytime** → `cd ~/master-agent/app && npm run doctor`.
- The app runs fully **text-only** even if voice setup fails.
