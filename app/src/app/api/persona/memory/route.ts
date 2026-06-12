import { NextRequest, NextResponse } from "next/server";
import {
  addCore, clearAll, deleteTurn, listCore, listSummaries, listThemes, listTurns,
  memoryStats, removeCore, updateCore, setTurnCategory,
} from "@/lib/persona-memory";
import { resolveProject } from "@/lib/workspace";

/* Manage Aria's layered memory from the dashboard. Conversational tiers
 * (recent/mid/long + session) are PER PROJECT — pass ?project=<slug>. Core
 * facts are GLOBAL (no project) — they apply to every project.
 *
 *   GET     /api/persona/memory?project=SLUG       → stats + tiers (incl. core)
 *   POST    /api/persona/memory                     → pin a GLOBAL core fact { text }
 *   PATCH   /api/persona/memory                     → edit a core fact { id, text }
 *   DELETE  /api/persona/memory?coreId=ID           → unpin a core fact (global)
 *   DELETE  /api/persona/memory?project=SLUG&turnId=N → forget one recent turn
 *   DELETE  /api/persona/memory?project=SLUG&all=1   → wipe a project's convo memory (core survives) */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const slug = new URL(req.url).searchParams.get("project");
  const { key } = await resolveProject(slug);
  const [stats, core, turns, summaries, themes] = await Promise.all([
    memoryStats(key),
    listCore(),
    listTurns(key),
    listSummaries(key),
    listThemes(key),
  ]);
  return NextResponse.json({ stats, core, recent: turns, summaries, themes });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { text?: string; source?: "user" | "aria"; category?: string } | null;
  const text = body?.text?.trim();
  if (!text) return NextResponse.json({ error: "Pass a non-empty 'text'." }, { status: 400 });
  const fact = await addCore(text, body?.source ?? "user", body?.category);
  return NextResponse.json({ ok: true, fact });
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { id?: string; text?: string; category?: string; project?: string; turnId?: number } | null;
  // Re-tag a recent turn's category: { project, turnId, category }
  if (body?.turnId != null) {
    const { key } = await resolveProject(body.project);
    const ok = await setTurnCategory(key, body.turnId, body.category ?? "");
    if (!ok) return NextResponse.json({ error: "No turn with that id." }, { status: 404 });
    return NextResponse.json({ ok: true });
  }
  // Edit a core fact: { id, text, category? }
  if (!body?.id || !body?.text?.trim()) {
    return NextResponse.json({ error: "Pass 'id' and non-empty 'text' (or 'turnId' + 'category')." }, { status: 400 });
  }
  const ok = await updateCore(body.id, body.text, body.category);
  if (!ok) return NextResponse.json({ error: "No core fact with that id." }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const { key } = await resolveProject(url.searchParams.get("project"));

  if (url.searchParams.get("all") === "1") {
    await clearAll(key);
    return NextResponse.json({ ok: true, cleared: "all", project: key });
  }
  const coreId = url.searchParams.get("coreId");
  if (coreId) {
    await removeCore(coreId);
    return NextResponse.json({ ok: true, cleared: coreId });
  }
  const turnId = Number(url.searchParams.get("turnId"));
  if (!turnId || Number.isNaN(turnId)) {
    return NextResponse.json({ error: "Pass ?coreId=<id>, ?project=<slug>&turnId=<n>, or ?project=<slug>&all=1" }, { status: 400 });
  }
  await deleteTurn(key, turnId);
  return NextResponse.json({ ok: true, cleared: turnId, project: key });
}
