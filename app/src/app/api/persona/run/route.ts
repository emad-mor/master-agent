import { NextRequest } from "next/server";
import { spawn } from "node:child_process";
import {
  appendTurn, autoTagTurn, buildMemoryBlock, evictIfNeeded, shouldInject,
  listSessions, getSessionByKey, createSession, updateSession, autoNameSession,
} from "@/lib/persona-memory";
import { resolveProject, WORKSPACE_DIR } from "@/lib/workspace";
import { planFlow, listAgents } from "@/lib/agents";
import { startFlow } from "@/lib/orchestrator";

/* Persona send → spawns `claude -p` against the ACTIVE PROJECT and streams its
 * NDJSON output back to the browser as Server-Sent Events.
 *
 * Multi-project model:
 *   - The request carries { prompt, project } where project is a folder slug
 *     from /api/projects (or omitted / "__workspace__" for the whole workspace).
 *   - Claude runs with cwd = that project's directory, so it auto-loads the
 *     project's CLAUDE.md and relative paths resolve there. It is ALSO granted
 *     --add-dir <workspace root>, so it can reach sibling projects when asked.
 *   - Memory is scoped per project: continuity, eviction, and the injected
 *     memory block all key off this project. Core memory is global.
 *
 * Continuity model (per project):
 *   - First Send for this project (or after a long idle gap): inject the full
 *     layered memory block as a prefix, run a fresh session, save the session id.
 *   - Subsequent warm Sends: pass --resume <sessionId> so Claude continues the
 *     same in-process session; the memory block is NOT re-injected. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StreamEvent =
  | { type: "system"; subtype?: string; session_id?: string; cwd?: string; model?: string }
  | { type: "assistant"; message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> } }
  | { type: "user"; message?: { content?: Array<{ type: string; text?: string; tool_use_id?: string; content?: unknown }> } }
  | { type: "result"; subtype: string; is_error?: boolean; result?: string; duration_ms?: number; total_cost_usd?: number }
  | { type: string };

const IDLE_REINJECT_MS = 4 * 60 * 1000;

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

  // Resolve the session ("tab"). If none supplied or it's gone, fall back to the
  // most recent session, or create the first one. Continuity is now PER SESSION:
  // each tab resumes its own claude id and re-injects memory only when cold.
  let session = body?.sessionKey ? await getSessionByKey(key, body.sessionKey) : null;
  if (!session) {
    const all = await listSessions(key);
    session = all[0] ?? await createSession(key, "Session 1");
  }
  const sessionKey = session.key;
  const sessionLabel = session.label;

  // Inject memory when this session has no resumable claude id yet, or it's been
  // idle long enough that the prompt cache likely expired.
  const isFirstTurn = !session.claudeSessionId;   // session has never produced a turn yet
  const cold = !session.claudeSessionId || (Date.now() - session.lastTurnAt > IDLE_REINJECT_MS);
  const reason = !session.claudeSessionId ? "first" : cold ? "idle" : "fresh";
  const inject = cold;
  const memoryBlock = inject ? await buildMemoryBlock(key, name) : "";

  // Attached files (drag-and-drop) — referenced by path so the agent reads them.
  const atts = body?.attachments ?? [];
  const attBlock = atts.length
    ? `\n\nAttached files (in this project; read them with your tools):\n${atts.map((a) => `- ./${a.relPath}${a.name && a.name !== a.relPath ? ` (${a.name})` : ""}`).join("\n")}`
    : "";

  // A short, ear-friendly spoken summary the UI extracts and reads aloud INSTEAD
  // of the full reply. The on-screen reply keeps the detailed working narrative;
  // this marker carries a 1-2 paragraph plain recap so TTS isn't jarring.
  const speakSummary = "\n\n---\nCRITICAL — the UI speaks ONLY the [[SUMMARY]] block below and NOTHING ELSE. If you omit it, the user hears silence. So you MUST ALWAYS include it, on EVERY reply, in EXACTLY this format:\n[[SUMMARY]]\n<1-2 short paragraphs of plain conversational prose — what you did and what should happen next. NO markdown, code, file paths, bullet lists, or tool play-by-play. Write it to be heard, not read.>\n[[/SUMMARY]]\nPut this BEFORE the next-step markers below. Never skip it.";

  // Always ask for clickable next-step suggestions as a machine-readable trailer
  // the UI parses into chips (and strips from the visible reply). Same marker
  // style as the orchestrator's [[ASK]] protocol.
  const nextSteps = "\n\n---\nAfter your answer, ALWAYS end with 1-3 suggested next steps, each on its own line in EXACTLY this format (nothing after them):\n[[NEXT label=\"<short button text, ≤5 words>\" | prompt=\"<the full instruction to run if clicked>\"]]\nMake them concrete and actionable for THIS context. If you asked the user a question, make the likely answers into next steps.";

  // Aria can LAUNCH multi-agent flows. When the user asks for orchestrated /
  // parallel / multi-agent work, she emits a machine marker the server parses
  // mid-stream — the flow is planned + started immediately and surfaced as a
  // card in the conversation (and in Mission Control).
  const flowAbility = "\n\nFLOW LAUNCHING — you can run multi-agent flows. ONLY when the user explicitly asks for a flow, parallel agents, multi-agent research, or orchestrated work, emit ONE line in EXACTLY this format (then briefly tell them what the flow will do):\n[[FLOW goal=\"<a self-contained goal statement for the flow planner — include all context it needs, since the planner can't see this conversation>\"]]\nDo NOT emit it for ordinary questions you can answer yourself.";

  const finalPrompt = `${memoryBlock ? memoryBlock + "\n\n" : ""}${userPrompt}${attBlock}${speakSummary}${nextSteps}${flowAbility}`;
  const resumeId = !inject && session.claudeSessionId ? session.claudeSessionId : null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      // Guard every write: once the client disconnects (navigates away, or hits
      // Stop, which aborts the fetch) the controller is closed and any further
      // enqueue throws. Track that and make send()/closeStream() no-op after.
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;   // controller already torn down — stop trying to write
        }
      };
      const closeStream = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch {}
      };

      // Tell the UI what project + continuity mode we're in this turn.
      send("continuity", { mode: inject ? "fresh" : "resume", reason, resumedFrom: resumeId, project: name, projectKey: key, sessionKey, sessionLabel });

      const args = [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--add-dir", WORKSPACE_DIR,   // reach every project in the workspace
        "--input-format", "text",
      ];
      if (resumeId) args.push("--resume", resumeId);

      let child;
      try {
        child = spawn(claudeBin, args, {
          cwd,                          // the active project's directory
          windowsHide: true,
          shell: process.platform === "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.stdin.write(finalPrompt);
        child.stdin.end();
      } catch (err) {
        send("error", { message: `Failed to spawn claude: ${(err as Error).message}` });
        closeStream();
        return;
      }

      // Accumulators for capturing the turn to memory.
      let replyText = "";
      const toolUses: string[] = [];
      let sessionIdFromRun: string | null = null;

      // Mid-stream [[FLOW goal="…"]] detection — Aria asked to launch a flow.
      // Plan + start it immediately (same process → same orchestrator registry
      // as /api/tasks) and surface it to the UI as a "flow" event. Once only.
      let flowLaunched = false;
      let flowLaunchPromise: Promise<void> | null = null;   // close handler awaits this so the "flow" event isn't dropped
      const FLOW_RE = /\[\[\s*FLOW\s+goal="([^"]+)"\s*\]\]/i;
      const maybeLaunchFlow = () => {
        if (flowLaunched) return;
        const m = FLOW_RE.exec(replyText);
        if (!m) return;
        flowLaunched = true;
        const goal = m[1].trim();
        flowLaunchPromise = (async () => {
          try {
            const agents = await listAgents();
            const steps = await planFlow(goal, agents);
            const { flowId } = await startFlow({
              name: goal.length > 40 ? goal.slice(0, 40) + "…" : goal,
              project: body?.project,
              rootInput: goal,
              steps,
            });
            send("flow", { flowId, goal, stepCount: steps.length });
          } catch (e) {
            send("flow", { goal, error: `Flow launch failed: ${(e as Error).message}` });
          }
        })();
      };

      // NDJSON parser — buffer until newline, parse, emit a typed event.
      let buf = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let evt: StreamEvent;
          try { evt = JSON.parse(line); }
          catch { continue; }
          handle(evt);
        }
      });

      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

      child.on("error", (err) => {
        send("error", { message: `Claude process error: ${err.message}` });
        closeStream();
      });

      child.on("close", async (code) => {
        if (code !== 0 && code !== null) {
          send("error", { message: `Claude exited with code ${code}. ${stderr.slice(-400)}` });
        }
        // Tell the client we're done up front so the UI unlocks immediately…
        send("done", { code });

        // …but KEEP the request alive while we persist + enrich memory. If we
        // closed the stream now, Next.js could tear down this context and orphan
        // the background Haiku spawn that tags the turn. So we await that work
        // (it's invisible to the user — they already got "done") then close.
        try {
          if (replyText) {
            const saved = await appendTurn(key, { prompt: userPrompt, reply: replyText, toolUses, sessionId: sessionIdFromRun ?? undefined, sessionKey, sessionLabel });
            await autoTagTurn(key, saved.id);   // topic category for the categorized memory view
          }
          // Update THIS session's claude id + last-activity so the next turn resumes it.
          await updateSession(key, sessionKey, { claudeSessionId: sessionIdFromRun ?? session.claudeSessionId, lastTurnAt: Date.now() });
          // On the session's first turn, auto-name it 2 words from the prompt
          // (skips if the user already renamed it). Background-safe.
          if (isFirstTurn) await autoNameSession(key, sessionKey, userPrompt);
          await evictIfNeeded(key);
        } catch (err) {
          console.warn("[persona-memory] post-turn persistence failed:", (err as Error).message);
        }
        // If Aria asked to launch a flow, wait for the launch to settle so the
        // "flow" SSE event reaches the client before the stream closes (flow
        // planning can outlast memory persistence).
        if (flowLaunchPromise) { try { await flowLaunchPromise; } catch {} }
        closeStream();
      });

      function handle(evt: StreamEvent) {
        if (evt.type === "system") {
          const sid = (evt as { session_id?: string }).session_id ?? null;
          if (sid) sessionIdFromRun = sid;
          send("system", { sessionId: sid, model: (evt as { model?: string }).model });
          return;
        }
        if (evt.type === "assistant") {
          const content = (evt as { message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> } }).message?.content ?? [];
          for (const c of content) {
            if (c.type === "text" && c.text) {
              replyText += c.text;
              send("text", { text: c.text });
              maybeLaunchFlow();   // marker may complete on any chunk
            } else if (c.type === "tool_use" && c.name) {
              toolUses.push(c.name);
              send("tool_use", { name: c.name, input: c.input });
            }
          }
          return;
        }
        if (evt.type === "user") {
          const content = (evt as { message?: { content?: Array<{ type: string; tool_use_id?: string }> } }).message?.content ?? [];
          for (const c of content) {
            if (c.type === "tool_result") send("tool_result", {});
          }
          return;
        }
        if (evt.type === "result") {
          const r = evt as { is_error?: boolean; result?: string; duration_ms?: number; total_cost_usd?: number };
          if (!replyText && r.result) replyText = r.result;
          maybeLaunchFlow();   // catch a marker only present in the final result
          send("result", {
            isError: !!r.is_error,
            text: r.result,
            durationMs: r.duration_ms,
            costUsd: r.total_cost_usd,
          });
          return;
        }
      }

      req.signal.addEventListener("abort", () => {
        // Client hit Stop or navigated away. Kill claude and mark the stream
        // closed so the child's trailing "close" handler doesn't enqueue.
        closed = true;
        try { child.kill("SIGTERM"); } catch {}
        try { controller.close(); } catch {}
      });
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
