import { NextRequest, NextResponse } from "next/server";
import { listTemplates, saveTemplate, deleteTemplate, type TemplateStep } from "@/lib/flow-templates";

/* Reusable flow templates.
 *   GET    /api/flow-templates           → all templates (builtins first)
 *   POST   /api/flow-templates           → save a new template { name, description?, steps }
 *   DELETE /api/flow-templates?id=ID      → delete a user template (builtins protected) */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ templates: await listTemplates() });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { name?: string; description?: string; steps?: TemplateStep[] } | null;
  if (!body?.name?.trim() || !Array.isArray(body.steps) || body.steps.length === 0) {
    return NextResponse.json({ error: "Pass 'name' and non-empty 'steps'." }, { status: 400 });
  }
  const tmpl = await saveTemplate({ name: body.name, description: body.description, steps: body.steps });
  return NextResponse.json({ template: tmpl });
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Pass ?id=<id>." }, { status: 400 });
  const ok = await deleteTemplate(id);
  return NextResponse.json({ ok });
}
