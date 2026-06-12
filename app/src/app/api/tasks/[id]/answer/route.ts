import { NextRequest, NextResponse } from "next/server";
import { answerQuestion } from "@/lib/orchestrator";

/* Answer a question the agent surfaced (it had already proceeded on an
 * assumption). Spawns a follow-up that resumes the session and revises the work.
 *   POST /api/tasks/[id]/answer  { qid, answer } → { taskId } */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null) as { qid?: string; answer?: string } | null;
  if (!body?.qid || !body?.answer?.trim()) {
    return NextResponse.json({ error: "Pass 'qid' and non-empty 'answer'." }, { status: 400 });
  }
  const taskId = await answerQuestion(id, body.qid, body.answer.trim());
  if (!taskId) {
    return NextResponse.json(
      { error: "Couldn't apply that answer — the task or question is no longer active (it may have been cleared)." },
      { status: 404 },
    );
  }
  return NextResponse.json({ taskId });
}
