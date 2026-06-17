# Run Daryan on a Mac

## 1. Install (one command)

Open **Terminal**, then paste this (replace the path with wherever this folder lives):

```bash
cd /path/to/master-agent && bash install.sh
```

That installs everything automatically — Homebrew, Node, Python, ffmpeg, the
Claude Code CLI, the app's dependencies, and the neural-voice models
(~800 MB download, so it can take a few minutes). It's safe to re-run.

## 2. Log in to Claude (one time)

Daryan thinks using the Claude Code CLI, which needs a **Claude / Anthropic
account**. Log in once:

```bash
claude
```

Follow the browser prompt to sign in, then press **Ctrl-C** to exit.

## 3. Start it

```bash
cd app && npm run dev
```

Then open **http://localhost:3939**. The neural voice starts automatically.
To stop, press **Ctrl-C** in that Terminal window.

---

### Requirements
- A Mac (macOS).
- A Claude / Anthropic account (for the one-time `claude` login in step 2).

### Troubleshooting
- **"claude: command not found"** after install → open a fresh Terminal window
  (so it picks up the new PATH), or run `npm i -g @anthropic-ai/claude-code`.
- **No voice / "browser voice"** → the model download may have been skipped on a
  flaky connection. Re-run `bash install.sh` (it resumes the missing pieces).
- **Check what's ready** → `cd app && npm run doctor` prints a green/red list.
- The app runs fully **text-only** even if voice setup fails.
