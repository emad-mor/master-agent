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

# 6 ── Readiness report ──────────────────────────────────────────────────────
( cd "$APP" && npm run doctor ) || true

# 7 ── What's left (the only two manual steps) ───────────────────────────────
cat <<EOF

${GREEN}${BOLD}✓ Setup complete.${RST} Two steps left:

  ${BOLD}1) Log in to Claude${RST} ${DIM}(one time — needs a Claude/Anthropic account)${RST}
       ${BOLD}claude${RST}
     Follow the browser prompt to sign in, then press Ctrl-C to exit.

  ${BOLD}2) Start Daryan${RST}
       ${BOLD}cd "$APP" && npm run dev${RST}
     Then open ${BOLD}http://localhost:3939${RST}  ${DIM}(voice starts automatically)${RST}

EOF
