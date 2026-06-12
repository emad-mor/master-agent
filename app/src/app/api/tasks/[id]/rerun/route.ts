import { NextRequest, NextResponse } from "next/server";
import { rerunStep } from "@/lib/orchestrator";

/* Re-run a step (optionally cascading to downstream steps whose {{input}} changes).
 *   POST /api/tasks/[id]/rerun  { cascade?: boolean } → { reset: [stepKeys] } */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null) as { cascade?: boolean } | null;
  const reset = await rerunStep(id, !!body?.cascade);
  if (!reset) return NextResponse.json({ error: "No such task." }, { status: 404 });
  return NextResponse.json({ ok: true, reset });
}
