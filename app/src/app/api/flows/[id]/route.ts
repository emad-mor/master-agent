import { NextRequest, NextResponse } from "next/server";
import { pauseFlow, playFlow, stopFlow } from "@/lib/orchestrator";

/* Flow controls.
 *   POST /api/flows/[id]  { action: "pause" | "play" | "stop" }
 * pause: running steps are killed but remembered (Play --resumes them); queued
 *        steps won't launch. play: resume launching. stop: kill + cancel all. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null) as { action?: string } | null;
  const action = body?.action;
  const ok =
    action === "pause" ? pauseFlow(id) :
    action === "play" ? playFlow(id) :
    action === "stop" ? stopFlow(id) :
    false;
  if (!ok && !["pause", "play", "stop"].includes(action ?? "")) {
    return NextResponse.json({ error: "Pass action: pause | play | stop." }, { status: 400 });
  }
  return NextResponse.json({ ok });
}
