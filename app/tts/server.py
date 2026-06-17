"""Kokoro TTS sidecar for the persona widget.

Listens on http://127.0.0.1:8001/speak (POST), accepts JSON {text, voice?},
returns 24 kHz mono 16-bit WAV in the response body. The Next.js dashboard
proxies to this via /api/speak so the browser sees same-origin audio.

Run with: dashboard/tts/.venv/Scripts/python.exe dashboard/tts/server.py
Or use: dashboard/tts/start-tts.ps1
"""

from __future__ import annotations

import io
import os
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel
from kokoro_onnx import Kokoro

HERE = Path(__file__).resolve().parent
MODEL = HERE / "kokoro-v1.0.onnx"
VOICES = HERE / "voices-v1.0.bin"

# af_heart is the most natural-sounding default. Other notable voices:
# af_bella, af_nicole (warm), am_michael (male), bf_emma (British female).
DEFAULT_VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
DEFAULT_SPEED = float(os.environ.get("KOKORO_SPEED", "1.0"))

app = FastAPI(title="Kokoro TTS sidecar")
kokoro: Kokoro | None = None


@app.on_event("startup")
def _load_model() -> None:
    global kokoro
    if not MODEL.exists():
        raise RuntimeError(f"Kokoro model not found at {MODEL}")
    if not VOICES.exists():
        raise RuntimeError(f"Kokoro voices bundle not found at {VOICES}")
    kokoro = Kokoro(str(MODEL), str(VOICES))


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "voice": DEFAULT_VOICE}


class SpeakBody(BaseModel):
    text: str
    voice: str | None = None
    speed: float | None = None


@app.post("/speak")
def speak(body: SpeakBody) -> Response:
    if kokoro is None:
        return Response(status_code=503, content=b"Kokoro not initialized")
    text = (body.text or "").strip()
    if not text:
        return Response(status_code=400, content=b"Empty text")

    samples, sample_rate = kokoro.create(
        text,
        voice=body.voice or DEFAULT_VOICE,
        speed=body.speed or DEFAULT_SPEED,
        lang="en-us",
    )

    # Encode as 16-bit PCM WAV in-memory.
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return Response(
        content=buf.getvalue(),
        media_type="audio/wav",
        headers={"Cache-Control": "no-store", "X-Kokoro-Voice": body.voice or DEFAULT_VOICE},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8001, log_level="warning")
