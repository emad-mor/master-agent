# Launch the Kokoro TTS sidecar at http://127.0.0.1:8001.
# Run this once before using voice in the dashboard. Leave the window open.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $here ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    Write-Error "Python venv missing. Run setup steps from docs/running.md."
    exit 1
}
if (-not (Test-Path (Join-Path $here "kokoro-v1.0.onnx"))) {
    Write-Error "Kokoro model missing. Download from https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0"
    exit 1
}
Write-Host "Kokoro TTS sidecar on http://127.0.0.1:8001 — Ctrl+C to stop." -ForegroundColor Cyan
& $python (Join-Path $here "server.py")
