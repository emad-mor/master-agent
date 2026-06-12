import { NextRequest, NextResponse } from "next/server";
import { saveDrops } from "@/lib/workspace";

/* Save dropped files (images / text / docs) into <project>/.aria-drops/ so the
 * agent can read them by path. Accepts multipart/form-data with field "files"
 * (one or many) and an optional "project" field.
 *   POST /api/drops  (FormData: files[], project) → { saved: [{relPath, name}] } */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024;   // 25 MB per file guard

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Expected multipart/form-data." }, { status: 400 });
  const project = (form.get("project") as string) || undefined;
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) return NextResponse.json({ error: "No files." }, { status: 400 });

  const payload: { name: string; data: Buffer }[] = [];
  for (const f of files) {
    if (f.size > MAX_BYTES) return NextResponse.json({ error: `${f.name} is too large (max 25 MB).` }, { status: 413 });
    payload.push({ name: f.name || "file", data: Buffer.from(await f.arrayBuffer()) });
  }
  const saved = await saveDrops(project, payload);
  return NextResponse.json({ saved });
}
