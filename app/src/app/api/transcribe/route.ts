import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { existsSync } from "node:fs";

/* Local speech-to-text via whisper.cpp. The widget records the user's voice
 * with MediaRecorder, posts the audio blob here, and we shell out to
 * ffmpeg → whisper-cli to transcribe it. Fully offline; no cloud, no API key.
 *
 * Assets live in app/whisper/ (shipped with this boilerplate):
 *   - whisper-cli.exe + dlls (whisper.cpp release, BLAS x64)
 *   - ggml-small.en.bin (English-only model, ~466 MB)
 *
 * ffmpeg must be on PATH (install via `winget install Gyan.FFmpeg`). */

const WHISPER_DIR = join(process.cwd(), "whisper");
const WHISPER_BIN = join(WHISPER_DIR, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
const MODEL_PATH = join(WHISPER_DIR, "ggml-small.en.bin");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

// Locate ffmpeg.exe even when the dev server was started before ffmpeg landed
// on PATH (winget appends to PATH for new shells only). Cached after first call.
let cachedFfmpeg: string | null = null;
async function resolveFfmpeg(): Promise<string | null> {
  if (cachedFfmpeg) return cachedFfmpeg;
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, exe);
    if (existsSync(candidate)) { cachedFfmpeg = candidate; return candidate; }
  }

  if (process.platform !== "win32") return null;

  const wingetRoot = join(homedir(), "AppData", "Local", "Microsoft", "WinGet", "Packages");
  if (existsSync(wingetRoot)) {
    try {
      const entries = await readdir(wingetRoot);
      for (const e of entries) {
        if (!e.startsWith("Gyan.FFmpeg")) continue;
        const pkgDir = join(wingetRoot, e);
        const subs = await readdir(pkgDir).catch(() => []);
        for (const sub of subs) {
          const candidate = join(pkgDir, sub, "bin", exe);
          if (existsSync(candidate)) { cachedFfmpeg = candidate; return candidate; }
        }
      }
    } catch {}
  }

  for (const candidate of [
    "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
  ]) {
    if (existsSync(candidate)) { cachedFfmpeg = candidate; return candidate; }
  }

  return null;
}

export async function POST(req: NextRequest) {
  if (!existsSync(WHISPER_BIN)) {
    return NextResponse.json({ error: `whisper-cli not found at ${WHISPER_BIN}. See README → "Voice setup".` }, { status: 500 });
  }
  if (!existsSync(MODEL_PATH)) {
    return NextResponse.json({ error: `Model not found at ${MODEL_PATH}. Re-download ggml-small.en.bin (see README).` }, { status: 500 });
  }

  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length === 0) {
    return NextResponse.json({ error: "Empty audio body." }, { status: 400 });
  }

  const work = await mkdtemp(join(tmpdir(), "aria-stt-"));
  const inputPath = join(work, "input.webm");
  const wavPath = join(work, "audio.wav");

  try {
    await writeFile(inputPath, buf);

    const ffmpegBin = await resolveFfmpeg();
    if (!ffmpegBin) {
      return NextResponse.json({ error: "ffmpeg not found. Install via `winget install Gyan.FFmpeg` (see README)." }, { status: 500 });
    }

    // ffmpeg: any container → 16 kHz mono 16-bit PCM WAV, which is what whisper expects.
    const ff = await run(ffmpegBin, ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath]);
    if (ff.code !== 0) {
      return NextResponse.json({ error: `ffmpeg failed (code ${ff.code}): ${ff.stderr.slice(-500)}` }, { status: 500 });
    }

    // whisper-cli writes "audio.wav.txt" next to the input by default.
    const wh = await run(WHISPER_BIN, [
      "-m", MODEL_PATH,
      "-f", wavPath,
      "--output-txt",
      "--no-prints",
      "--language", "en",
      "--threads", "4",
    ], WHISPER_DIR);
    if (wh.code !== 0) {
      return NextResponse.json({ error: `whisper-cli failed (code ${wh.code}): ${wh.stderr.slice(-500)}` }, { status: 500 });
    }

    const text = (await readFile(`${wavPath}.txt`, "utf8")).trim();
    return NextResponse.json({ text });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message ?? "Unknown transcription error" }, { status: 500 });
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
