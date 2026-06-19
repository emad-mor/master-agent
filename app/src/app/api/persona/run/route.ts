import { NextRequest } from "next/server";
import { buildMemoryBlock, listSessions, getSessionByKey, createSession } from "@/lib/persona-memory";
import { resolveProject, WORKSPACE_DIR } from "@/lib/workspace";
import { startPersonaRun, subscribePersonaRun, stopPersonaRun, type PersonaEvent } from "@/lib/persona-run";

/* Persona send → runs `claude -p` against the ACTIVE PROJECT and streams its
 * output to the browser as SSE.
 *
 * The run is SERVER-OWNED (see persona-run.ts): it lives in a process-wide
 * registry, not the request, so a tab refresh doesn't kill it. The request just
 * subscribes to stream it; a disconnect only unsubscribes. A refreshed tab
 * reattaches via GET (replays the log so far, then tails). Stop is explicit
 * (DELETE). Persistence to layered memory happens in the registry on close.
 *
 * Continuity (per session): first send (or after a long idle gap) injects the
 * full memory block and runs a fresh session; warm sends `--resume` the same
 * claude session id without re-injecting. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IDLE_REINJECT_MS = 4 * 60 * 1000;

/** Subscribe to the run for (projectKey, sessionKey) and stream it as SSE:
 *  replay the log, then tail live events. No active run → emit `idle` + close.
 *  Client disconnect → unsubscribe only (the run keeps going server-side). */
function streamRun(req: NextRequest, projectKey: string, sessionKey: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (e: PersonaEvent) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)); }
        catch { closed = true; }
        if (e.event === "done") { closed = true; sub?.unsubscribe(); try { controller.close(); } catch {} }
      };
      const sub = subscribePersonaRun(projectKey, sessionKey, write);
      if (!sub) {
        try { controller.enqueue(encoder.encode(`event: idle\ndata: {}\n\n`)); controller.close(); } catch {}
        return;
      }
      // Replay the existing log synchronously — no await before the loop, so live
      // events can't be enqueued ahead of the replayed ones.
      for (const e of sub.replay) write(e);
      req.signal.addEventListener("abort", () => { closed = true; sub.unsubscribe(); try { controller.close(); } catch {} });
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as {
    prompt?: string; project?: string; sessionKey?: string;
    attachments?: { relPath: string; name: string }[];
  } | null;
  const userPrompt = body?.prompt?.trim();
  if (!userPrompt) {
    return new Response(JSON.stringify({ error: "Empty prompt." }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const claudeBin = process.platform === "win32" ? "claude.cmd" : "claude";
  const { cwd, key, name } = await resolveProject(body?.project);

  // Resolve the session ("tab"): supplied key, else most recent, else create one.
  let session = body?.sessionKey ? await getSessionByKey(key, body.sessionKey) : null;
  if (!session) {
    const all = await listSessions(key);
    session = all[0] ?? await createSession(key, "Session 1");
  }
  const sessionKey = session.key;
  const sessionLabel = session.label;

  const isFirstTurn = !session.claudeSessionId;
  const cold = !session.claudeSessionId || (Date.now() - session.lastTurnAt > IDLE_REINJECT_MS);
  const reason = !session.claudeSessionId ? "first" : cold ? "idle" : "fresh";
  const inject = cold;
  const memoryBlock = inject ? await buildMemoryBlock(key, name) : "";

  const atts = body?.attachments ?? [];
  const attBlock = atts.length
    ? `\n\nAttached files (in this project; read them with your tools):\n${atts.map((a) => `- ./${a.relPath}${a.name && a.name !== a.relPath ? ` (${a.name})` : ""}`).join("\n")}`
    : "";

  const speakSummary = "\n\n---\nCRITICAL — the UI speaks ONLY the [[SUMMARY]] block below and NOTHING ELSE. If you omit it, the user hears silence. So you MUST ALWAYS include it, on EVERY reply, in EXACTLY this format:\n[[SUMMARY]]\n<1-2 short paragraphs of plain conversational prose — what you did and what should happen next. NO markdown, code, file paths, bullet lists, or tool play-by-play. Write it to be heard, not read.>\n[[/SUMMARY]]\nPut this BEFORE the next-step markers below. Never skip it.";
  const nextSteps = "\n\n---\nAfter your answer, ALWAYS end with 1-3 suggested next steps, each on its own line in EXACTLY this format (nothing after them):\n[[NEXT label=\"<short button text, ≤5 words>\" | prompt=\"<the full instruction to run if clicked>\"]]\nMake them concrete and actionable for THIS context. If you asked the user a question, make the likely answers into next steps.";
  const flowAbility = "\n\nFLOW LAUNCHING — you can run multi-agent flows. ONLY when the user explicitly asks for a flow, parallel agents, multi-agent research, or orchestrated work, emit ONE line in EXACTLY this format (then briefly tell them what the flow will do):\n[[FLOW goal=\"<a self-contained goal statement for the flow planner — include all context it needs, since the planner can't see this conversation>\"]]\nDo NOT emit it for ordinary questions you can answer yourself.";

  const finalPrompt = `${memoryBlock ? memoryBlock + "\n\n" : ""}${userPrompt}${attBlock}${speakSummary}${nextSteps}${flowAbility}`;
  const resumeId = !inject && session.claudeSessionId ? session.claudeSessionId : null;

  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--add-dir", WORKSPACE_DIR,
    "--input-format", "text",
  ];
  if (resumeId) args.push("--resume", resumeId);

  startPersonaRun({
    projectKey: key,
    projectSlug: body?.project,
    projectName: name,
    sessionKey,
    sessionLabel,
    cwd,
    claudeBin,
    args,
    finalPrompt,
    userPrompt,
    priorClaudeId: session.claudeSessionId ?? null,
    isFirstTurn,
    continuity: { mode: inject ? "fresh" : "resume", reason, resumedFrom: resumeId, project: name, projectKey: key, sessionKey, sessionLabel },
  });

  return streamRun(req, key, sessionKey);
}

/** Reattach — a refreshed/reopened tab reconnects to an in-progress run. */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const { key } = await resolveProject(url.searchParams.get("project"));
  const sessionKey = url.searchParams.get("sessionKey");
  if (!sessionKey) return new Response(JSON.stringify({ error: "sessionKey required" }), { status: 400, headers: { "Content-Type": "application/json" } });
  return streamRun(req, key, sessionKey);
}

/** Stop — kill the in-flight run for a session (its partial reply is still saved). */
export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const { key } = await resolveProject(url.searchParams.get("project"));
  const sessionKey = url.searchParams.get("sessionKey");
  if (!sessionKey) return new Response(JSON.stringify({ error: "sessionKey required" }), { status: 400, headers: { "Content-Type": "application/json" } });
  const ok = stopPersonaRun(key, sessionKey);
  return new Response(JSON.stringify({ ok }), { status: 200, headers: { "Content-Type": "application/json" } });
}
