import { NextRequest, NextResponse } from "next/server";
import { stopTask } from "@/lib/orchestrator";

/* Stop one running/queued task (SIGTERM the claude process). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ok = stopTask(id);
  return NextResponse.json({ ok });
}
