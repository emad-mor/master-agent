import { NextRequest, NextResponse } from "next/server";
import { chainTask } from "@/lib/orchestrator";

/* Chain a new step onto an existing task. The source task's final reply is
 * wired into the new prompt as {{input}}. If the source is standalone, both
 * become a flow.
 *   POST /api/tasks/[id]/chain  { prompt, agentId?, label? } → { taskId } */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null) as { prompt?: string; agentId?: string; label?: string } | null;
  const prompt = body?.prompt?.trim();
  if (!prompt) return NextResponse.json({ error: "Pass non-empty 'prompt'." }, { status: 400 });
  const taskId = await chainTask(id, { prompt, agentId: body?.agentId, label: body?.label });
  if (!taskId) return NextResponse.json({ error: "No such task." }, { status: 404 });
  return NextResponse.json({ taskId });
}
