# ─────────────────────────────────────────────────────────────────────────────
# Aria master-agent — one-shot setup.
# Installs app dependencies and prepares the local voice stack (whisper + Kokoro).
# Safe to re-run; it skips anything already in place.
#
#   pwsh -File .\setup.ps1            # normal setup
#   pwsh -File .\setup.ps1 -DownloadModels   # also fetch missing voice models
# ─────────────────────────────────────────────────────────────────────────────
param(
  [switch]$DownloadModels
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$app  = Join-Path $root "app"
$tts  = Join-Path $app "tts"
$whisper = Join-Path $app "whisper"

function Ok($m)   { Write-Host "  [ok]   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [warn] $m" -ForegroundColor Yellow }
function Step($m) { Write-Host "`n=> $m" -ForegroundColor Cyan }

Write-Host "Aria master-agent setup" -ForegroundColor Cyan
Write-Host "root: $root"

# 1. Node + app dependencies ---------------------------------------------------
Step "Node + app dependencies"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js not found. Install Node 18+ from https://nodejs.org and re-run."
}
Ok "node $(node --version)"
Push-Location $app
npm install
Pop-Location
Ok "npm dependencies installed"

# 2. claude CLI ----------------------------------------------------------------
Step "Claude Code CLI"
if (Get-Command claude -ErrorAction SilentlyContinue) {
  Ok "claude found at $((Get-Command claude).Source)"
} else {
  Warn "claude CLI not on PATH. Aria's brain needs it."
  Warn "Install: npm install -g @anthropic-ai/claude-code   (then run 'claude' once to log in)"
}

# 3. ffmpeg (speech-to-text needs it) -----------------------------------------
Step "ffmpeg (for voice input)"
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
  Ok "ffmpeg found"
} else {
  Warn "ffmpeg not on PATH. Install: winget install Gyan.FFmpeg  (then open a new shell)"
}

# 4. whisper.cpp assets --------------------------------------------------------
Step "whisper.cpp (speech-to-text)"
if (Test-Path (Join-Path $whisper "whisper-cli.exe")) { Ok "whisper-cli.exe present" }
else { Warn "whisper-cli.exe missing in app/whisper/ — voice input won't work until it's there." }
if (Test-Path (Join-Path $whisper "ggml-small.en.bin")) { Ok "ggml-small.en.bin present" }
else { Warn "ggml-small.en.bin missing (~466 MB). Download from a whisper.cpp release and place in app/whisper/." }

# 5. Kokoro TTS — Python venv + models ----------------------------------------
Step "Kokoro TTS (neural voice output — optional; browser voice is the fallback)"
$venvPython = Join-Path $tts ".venv\Scripts\python.exe"
if (Test-Path $venvPython) {
  Ok "Python venv already present"
} else {
  if (Get-Command python -ErrorAction SilentlyContinue) {
    Write-Host "  creating venv + installing kokoro-onnx (this can take a few minutes)…"
    Push-Location $tts
    python -m venv .venv
    & $venvPython -m pip install --upgrade pip --quiet
    & $venvPython -m pip install kokoro-onnx soundfile numpy fastapi uvicorn pydantic --quiet
    Pop-Location
    Ok "venv created + dependencies installed"
  } else {
    Warn "python not found — skipping Kokoro. Browser speech will be used instead."
    Warn "To enable the neural voice: install Python 3.10+, then re-run setup.ps1."
  }
}

$kokoroModel  = Join-Path $tts "kokoro-v1.0.onnx"
$kokoroVoices = Join-Path $tts "voices-v1.0.bin"
$modelBase = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
foreach ($pair in @(@{ f = $kokoroModel; u = "$modelBase/kokoro-v1.0.onnx" }, @{ f = $kokoroVoices; u = "$modelBase/voices-v1.0.bin" })) {
  if (Test-Path $pair.f) {
    Ok "$(Split-Path $pair.f -Leaf) present"
  } elseif ($DownloadModels) {
    Write-Host "  downloading $(Split-Path $pair.f -Leaf)…"
    Invoke-WebRequest -Uri $pair.u -OutFile $pair.f
    Ok "downloaded $(Split-Path $pair.f -Leaf)"
  } else {
    Warn "$(Split-Path $pair.f -Leaf) missing. Re-run with -DownloadModels, or grab it from:"
    Warn "  $($pair.u)"
  }
}

# Done ------------------------------------------------------------------------
Step "Next steps"
Write-Host @"
  1. Put project folders in:  $root\workspace
  2. (optional) Start the neural voice in a separate window:
        pwsh -File "$tts\start-tts.ps1"
  3. Start the app:
        cd "$app"; npm run dev
  4. Open http://localhost:3939  →  press Ctrl/Cmd+K to talk to Aria.
"@ -ForegroundColor Gray
