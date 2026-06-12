import { NextRequest, NextResponse } from "next/server";

/* Proxy to the Kokoro TTS sidecar at http://127.0.0.1:8001/speak.
 * Frontend stays same-origin; the sidecar is a separate Python process you
 * launch with `app/tts/start-tts.ps1`.
 *
 * Returns 503 if the sidecar isn't running so the widget can fall back to the
 * browser's speechSynthesis without a hard error. */

const SIDECAR_URL = process.env.KOKORO_URL ?? "http://127.0.0.1:8001/speak";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { text?: string; voice?: string; speed?: number } | null;
  const text = body?.text?.trim();
  if (!text) {
    return NextResponse.json({ error: "Empty text" }, { status: 400 });
  }

  let sidecar: Response;
  try {
    sidecar = await fetch(SIDECAR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: body?.voice, speed: body?.speed }),
      signal: req.signal,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `TTS sidecar unreachable at ${SIDECAR_URL}. Start it with app/tts/start-tts.ps1.`, cause: (err as Error).message },
      { status: 503 },
    );
  }

  if (!sidecar.ok) {
    const detail = await sidecar.text().catch(() => "");
    return NextResponse.json({ error: `TTS sidecar returned ${sidecar.status}: ${detail.slice(0, 300)}` }, { status: 502 });
  }

  return new Response(sidecar.body, {
    headers: {
      "Content-Type": sidecar.headers.get("Content-Type") ?? "audio/wav",
      "Cache-Control": "no-store",
    },
  });
}
