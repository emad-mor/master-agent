import { NextRequest, NextResponse } from "next/server";
import { listAllSkills, createCustomSkill, deleteCustomSkill, MAX_BRIEF_CHARS, type Skill } from "@/lib/skills";

/* The skill catalog — capability briefs the agent editor offers as toggles.
 * Built-ins are code-defined (lib/skills.ts); custom skills are user-created
 * and persisted to data/skills.json.
 *
 *   GET    /api/skills           → { skills } (full briefs + source + custom flag)
 *   POST   /api/skills           → create custom { name, brief, summary?, source?, category? }
 *   DELETE /api/skills?id=...    → remove a custom skill (built-ins can't be deleted)
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Ship the FULL catalog (brief + source included) — the agent editor lets the
  // user read exactly what a skill injects and where the practice comes from.
  return NextResponse.json({ skills: listAllSkills() });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { name?: string; summary?: string; brief?: string; source?: string; category?: Skill["category"]; fileName?: string } | null;
  if (!body?.name?.trim() || !body?.brief?.trim()) {
    return NextResponse.json({ error: "Pass 'name' and 'brief' (the practice text injected into the agent)." }, { status: 400 });
  }
  if (body.brief.length > MAX_BRIEF_CHARS) {
    return NextResponse.json({ error: `Brief is too long (${body.brief.length.toLocaleString()} chars; max ${MAX_BRIEF_CHARS.toLocaleString()}). It rides inside every agent prompt — trim the file to the essential practice.` }, { status: 413 });
  }
  const skill = createCustomSkill({ name: body.name, summary: body.summary, brief: body.brief, source: body.source, category: body.category, fileName: body.fileName });
  if (!skill) return NextResponse.json({ error: "A skill with that name already exists." }, { status: 409 });
  return NextResponse.json({ skill });
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Pass ?id=." }, { status: 400 });
  if (!deleteCustomSkill(id)) {
    return NextResponse.json({ error: "No such custom skill (built-in skills can't be deleted)." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
