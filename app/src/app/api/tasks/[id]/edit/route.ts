import { NextRequest, NextResponse } from "next/server";
import { editStep } from "@/lib/orchestrator";

/* Edit a step's prompt template and/or title (does not re-run — call /rerun).
 *   POST /api/tasks/[id]/edit  { prompt?, title? } */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null) as { prompt?: string; title?: string } | null;
  if (body?.prompt == null && body?.title == null) {
    return NextResponse.json({ error: "Pass 'prompt' and/or 'title'." }, { status: 400 });
  }
  const ok = editStep(id, { prompt: body?.prompt, title: body?.title });
  if (!ok) return NextResponse.json({ error: "No such task." }, { status: 404 });
  return NextResponse.json({ ok });
}
