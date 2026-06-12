# Aria — master-agent boilerplate

A **local, voice-driven Claude Code agent** with **layered per-project memory**
and access to **every folder you drop into the workspace**. Copy this whole
folder to start a new multi-project cockpit; drop projects into `workspace/` and
Aria can work in any of them.

She is extracted from the Experiences Agency dashboard's "Aria" persona and
generalized for many projects.

```
master-agent/
├── app/            the agent — a Next.js app (UI + voice + memory + claude spawn)
│   ├── src/
│   ├── tts/        Kokoro neural-voice sidecar (Python) + models
│   ├── whisper/    whisper.cpp speech-to-text binaries + model
│   └── data/       layered memory store (created at runtime, gitignored)
├── workspace/      ← drop / clone your project folders here
├── setup.ps1       one-shot setup
└── README.md
```

## What it is

- **Brain.** Each turn spawns the real `claude` CLI
  (`claude -p --dangerously-skip-permissions`) in the active project's directory,
  with `--add-dir <workspace>` so it can reach every other project too. Output
  streams back token-by-token over SSE. This is Claude Code with full tool
  access — *Aria is a front-end and a memory around it.*
- **Voice in.** Press-and-hold the mic → local **whisper.cpp** transcribes the
  audio. Offline, no API key.
- **Voice out.** Replies are read aloud by the local **Kokoro** neural voice
  (`app/tts/`); if that sidecar isn't running it falls back to the browser's
  built-in speech.
- **Layered memory** (`app/src/lib/persona-memory.ts`):
  | Tier   | Scope          | What it holds                                  |
  |--------|----------------|------------------------------------------------|
  | core   | **global**     | always-true facts, injected on every project   |
  | recent | per project    | last ~20 full turns, verbatim                  |
  | mid    | per project    | older turns, Haiku-summarized to a paragraph   |
  | long   | per project    | 100+ turns distilled into ~30 theme lines      |

  Each project also keeps its own `claude` session id, so switching projects
  resumes the right context. Manage it all from the **brain icon** in the widget.

## Requirements

| Need              | Why                          | Install |
|-------------------|------------------------------|---------|
| Node 18+          | runs the app                 | https://nodejs.org |
| `claude` CLI      | Aria's brain                 | `npm i -g @anthropic-ai/claude-code` then run `claude` once to log in |
| ffmpeg            | voice input (STT)            | `winget install Gyan.FFmpeg` |
| Python 3.10+      | neural voice (optional)      | https://python.org — without it, browser voice is used |

The big voice assets (whisper model, Kokoro models, Python venv) are **already
copied into `app/`** in this build, so it runs immediately. They're gitignored,
so a fresh clone re-fetches them via `setup.ps1 -DownloadModels`.

## Quick start

```powershell
# 1. one-time setup (installs npm deps, prepares voice stack)
pwsh -File .\setup.ps1

# 2. (optional) neural voice — leave this window open
pwsh -File .\app\tts\start-tts.ps1

# 3. run the app
cd app
npm run dev
# → http://localhost:3939   (press Ctrl/⌘+K to talk to Aria)
```

Then drop a project folder into `workspace/`, hit rescan in Aria's project
picker, and select it.

## How multi-project access works

- The widget's **project picker** lists every folder in `workspace/`
  (`/api/projects`).
- On Send, the browser posts `{ prompt, project }` to `/api/persona/run`.
- The server resolves the slug to a directory and spawns:
  ```
  claude -p --output-format stream-json --verbose \
         --dangerously-skip-permissions \
         --add-dir <workspace-root> --input-format text [--resume <id>]
  ```
  with **cwd = the active project**. Pick **"All projects"** to run at the
  workspace root instead.
- Memory reads/writes use the project's slug as the bucket key; **Core** is global.

### Config (env vars)

Set these in `app/.env.local` if you need to:

| Var | Default | Purpose |
|-----|---------|---------|
| `WORKSPACE_DIR` | `../workspace` | absolute path to the folder holding your projects |
| `KOKORO_URL` | `http://127.0.0.1:8001/speak` | TTS sidecar endpoint |
| `ARIA_MEMORY_MODEL` | `claude-haiku-4-5-20251001` | model used to summarize/distill memory |

## Customizing

- **Persona / greetings / quick prompts** — `app/src/components/persona/persona-config.ts`
- **Seed core facts** — `DEFAULT_CORE` in `app/src/lib/persona-memory.ts` (seeded once into `app/data/memory/core.json`; edit the file after that)
- **Tier sizes** — `RECENT_LIMIT` / `MID_LIMIT` / `LONG_TIER_TARGET` in the same file
- **Look & feel** — design tokens in `app/src/app/globals.css`
- **Voice** — pick a different Kokoro voice via `KOKORO_VOICE` (see `app/tts/server.py`)

## Safety

This is a **single-user, local tool**. Aria runs `claude` with
`--dangerously-skip-permissions` and read/write access to everything in your
workspace. Run it only on a machine and folders you trust, and **do not deploy
it to a shared or public host.**
