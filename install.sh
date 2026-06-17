#!/usr/bin/env bash
#
# Daryan — one-command macOS setup.
#
#   bash install.sh
#
# Installs everything a fresh Mac needs (Homebrew, Node, Python, ffmpeg, the
# Claude Code CLI), installs the app's dependencies, and downloads the neural
# voice models (~800 MB). Safe to re-run: every step skips work already done.
#
set -uo pipefail   # intentionally NOT -e: each step has its own check so one
                   # soft failure (e.g. a model download) never aborts the rest.

BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; RST=$'\033[0m'
say(){  printf '\n%s\n' "${BOLD}▶ $*${RST}"; }
ok(){   printf '%s\n' "${GREEN}  ✓ $*${RST}"; }
warn(){ printf '%s\n' "${YELLOW}  ! $*${RST}"; }
err(){  printf '%s\n' "${RED}  ✗ $*${RST}"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/app"

printf '%s\n' "${BOLD}Setting up Daryan…${RST} ${DIM}(this can take a few minutes the first time)${RST}"

# 0 ── macOS only ────────────────────────────────────────────────────────────
if [ "$(uname)" != "Darwin" ]; then err "This installer is for macOS."; exit 1; fi

# 1 ── Homebrew ──────────────────────────────────────────────────────────────
if ! command -v brew >/dev/null 2>&1; then
  say "Installing Homebrew (you may be asked for your Mac password)…"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
# Load brew into THIS shell (Apple Silicon → /opt/homebrew, Intel → /usr/local)
if   [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)";
elif [ -x /usr/local/bin/brew ];    then eval "$(/usr/local/bin/brew shellenv)"; fi
if command -v brew >/dev/null 2>&1; then ok "Homebrew ready"; else err "Homebrew install failed — see https://brew.sh"; exit 1; fi
# Persist brew on PATH for FUTURE terminals (the installer doesn't do this), so
# `node`, `npm`, and `claude` are found when you open a new window later.
if ! grep -q "brew shellenv" "$HOME/.zprofile" 2>/dev/null; then
  printf '\neval "$(%s shellenv)"\n' "$(command -v brew)" >> "$HOME/.zprofile"
  ok "Added Homebrew to ~/.zprofile (for new terminals)"
fi

# 2 ── System packages ───────────────────────────────────────────────────────
say "Installing Node, Python, ffmpeg & git…"
brew install node python ffmpeg git >/dev/null 2>&1 || brew install node python ffmpeg git
command -v node >/dev/null 2>&1 && ok "Node $(node -v), Python $(python3 --version 2>&1 | awk '{print $2}')" || { err "Node missing after install"; exit 1; }

# 3 ── Claude Code CLI (the agent brain — REQUIRED) ──────────────────────────
if ! command -v claude >/dev/null 2>&1; then
  say "Installing the Claude Code CLI…"
  npm i -g @anthropic-ai/claude-code >/dev/null 2>&1 || npm i -g @anthropic-ai/claude-code
fi
command -v claude >/dev/null 2>&1 && ok "Claude CLI ready" || warn "Claude CLI not on PATH — open a new terminal, or run: npm i -g @anthropic-ai/claude-code"

# 4 ── App dependencies (postinstall provisions whisper + the TTS venv) ──────
# Create the (gitignored) voice asset dirs FIRST so postinstall's whisper-cli
# symlink has somewhere to land.
mkdir -p "$APP/tts" "$APP/whisper"
say "Installing app dependencies…"
( cd "$APP" && npm install )

# 5 ── Voice models (downloaded, not shipped — kept out of git for size) ─────
dl(){ # url  dest  size-hint
  local url="$1" dest="$2" hint="$3" sz
  sz=$(stat -f%z "$dest" 2>/dev/null || echo 0)
  if [ "$sz" -gt 1000000 ]; then ok "$(basename "$dest") already present"; return; fi
  say "Downloading $(basename "$dest") (${hint})…"
  if curl -fL --progress-bar -o "$dest" "$url"; then ok "$(basename "$dest")"; else warn "Could not download $(basename "$dest") — voice may be limited (browser voice still works)."; fi
}
mkdir -p "$APP/tts" "$APP/whisper"
KO="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
dl "$KO/kokoro-v1.0.onnx" "$APP/tts/kokoro-v1.0.onnx" "~310 MB · reply voice"
dl "$KO/voices-v1.0.bin"  "$APP/tts/voices-v1.0.bin"  "~27 MB · voice profiles"
dl "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin" "$APP/whisper/ggml-small.en.bin" "~466 MB · mic / speech-to-text"

# The Kokoro sidecar source must be present for neural voice to start.
[ -f "$APP/tts/server.py" ] || warn "app/tts/server.py is missing — re-pull the repo, or neural voice won't start (browser voice still works)."

# Re-provision the voice toolchain now that the models are on disk (idempotent).
( cd "$APP" && npm run setup:tts >/dev/null 2>&1; npm run setup:whisper >/dev/null 2>&1 ) || true

# 6 ── Prove the neural voice actually synthesizes audio ─────────────────────
say "Verifying neural voice…"
VENV_PY="$APP/tts/.venv/bin/python"
if [ -x "$VENV_PY" ] && [ -f "$APP/tts/kokoro-v1.0.onnx" ] && [ -f "$APP/tts/voices-v1.0.bin" ]; then
  ( cd "$APP/tts" && "$VENV_PY" server.py >/tmp/daryan-tts-check.log 2>&1 & echo $! >/tmp/daryan-tts-check.pid )
  code=$(curl -s --retry 15 --retry-connrefused --retry-delay 1 --connect-timeout 2 -m 12 \
              -X POST http://127.0.0.1:8001/speak -H 'Content-Type: application/json' \
              -d '{"text":"Voice ready."}' -o /tmp/daryan-tts-check.wav -w '%{http_code}' 2>/dev/null)
  if [ "$code" = "200" ] && [ "$(stat -f%z /tmp/daryan-tts-check.wav 2>/dev/null || echo 0)" -gt 1000 ]; then
    ok "Neural voice verified — it produced audio."
  else
    warn "Neural voice didn't synthesize on the smoke test (HTTP $code). See /tmp/daryan-tts-check.log. The app still runs; browser voice is the fallback."
  fi
  kill "$(cat /tmp/daryan-tts-check.pid 2>/dev/null)" 2>/dev/null
  for p in $(lsof -nP -iTCP:8001 -sTCP:LISTEN -t 2>/dev/null); do kill "$p" 2>/dev/null; done
  rm -f /tmp/daryan-tts-check.wav /tmp/daryan-tts-check.pid /tmp/daryan-tts-check.log
else
  warn "TTS venv or models missing — neural voice unavailable (browser voice will be used). Retry: cd app && npm run setup:tts"
fi

# 7 ── Readiness report ──────────────────────────────────────────────────────
( cd "$APP" && npm run doctor ) || true

# 8 ── What's left (manual steps) ────────────────────────────────────────────
cat <<EOF

${GREEN}${BOLD}✓ Setup complete.${RST} Three steps left:

  ${BOLD}1) Open a NEW Terminal window${RST} ${DIM}(so Node & Claude are on your PATH)${RST}

  ${BOLD}2) Log in to Claude${RST} ${DIM}(one time — needs a Claude/Anthropic account)${RST}
       ${BOLD}claude${RST}
     Follow the browser prompt to sign in, then press Ctrl-C to exit.

  ${BOLD}3) Start Daryan${RST}
       ${BOLD}cd "$APP" && npm run dev${RST}
     Then open ${BOLD}http://localhost:3939${RST}  ${DIM}(voice starts automatically)${RST}

EOF
