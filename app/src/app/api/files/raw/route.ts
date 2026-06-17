import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { resolveProjectFilePath } from "@/lib/workspace";

/* Serve a project file's RAW bytes with a sensible Content-Type, so the browser
 * can render it directly in a new tab — images, audio, video, HTML, PDF.
 *   GET /api/files/raw?project=SLUG&path=REL/PATH
 * Same traversal guards as the content API; capped so a giant file can't OOM. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RAW_BYTES = 64 * 1024 * 1024;   // 64 MB ceiling for in-tab serving

const MIME: Record<string, string> = {
  // images
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon",
  // audio
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg",
  ".m4a": "audio/mp4", ".flac": "audio/flac", ".aac": "audio/aac", ".opus": "audio/opus",
  // video
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mkv": "video/x-matroska", ".ogv": "video/ogg",
  // documents the browser renders natively
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".pdf": "application/pdf",
};

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const slug = url.searchParams.get("project");
  const path = url.searchParams.get("path");
  if (!path) return NextResponse.json({ error: "Missing path" }, { status: 400 });

  const r = await resolveProjectFilePath(slug, path);
  if ("error" in r) return NextResponse.json(r, { status: 400 });
  if (r.size > MAX_RAW_BYTES) return NextResponse.json({ error: "File too large to open in a tab" }, { status: 413 });

  const type = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
  const buf = await readFile(r.abs);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(buf.length),
      "Content-Disposition": "inline",   // render in the tab, don't force-download
      "Cache-Control": "no-store",
    },
  });
}
