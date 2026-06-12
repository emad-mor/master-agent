import { NextRequest, NextResponse } from "next/server";
import { listSessions, createSession, updateSession, deleteSession, sessionHistory } from "@/lib/persona-memory";
import { resolveProject } from "@/lib/workspace";

/* Named sessions ("tabs") within a project. All sessions feed the project's one
 * layered memory, grouped by session.
 *
 *   GET    /api/persona/sessions?project=SLUG                 → { sessions }
 *   GET    /api/persona/sessions?project=SLUG&history=KEY     → { mode, turns, summaries }
 *   POST   /api/persona/sessions  { project, label? }         → { session } (create)
 *   PATCH  /api/persona/sessions  { project, key, label }     → { session } (rename)
 *   DELETE /api/persona/sessions?project=SLUG&key=KEY         → { ok } */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const { key } = await resolveProject(url.searchParams.get("project"));
  const historyKey = url.searchParams.get("history");
  if (historyKey) {
    return NextResponse.json(await sessionHistory(key, historyKey));
  }
  return NextResponse.json({ sessions: await listSessions(key) });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { project?: string; label?: string } | null;
  const { key } = await resolveProject(body?.project);
  const session = await createSession(key, body?.label);
  return NextResponse.json({ session });
}

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => null) as { project?: string; key?: string; label?: string } | null;
  if (!body?.key) return NextResponse.json({ error: "Pass 'key'." }, { status: 400 });
  const { key } = await resolveProject(body.project);
  // A manual rename locks the name so auto-naming won't override it.
  const session = await updateSession(key, body.key, { label: body.label, nameLocked: true });
  if (!session) return NextResponse.json({ error: "No such session." }, { status: 404 });
  return NextResponse.json({ session });
}

export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const sessionKey = url.searchParams.get("key");
  if (!sessionKey) return NextResponse.json({ error: "Pass ?key=<sessionKey>." }, { status: 400 });
  const { key } = await resolveProject(url.searchParams.get("project"));
  await deleteSession(key, sessionKey);
  return NextResponse.json({ ok: true });
}
