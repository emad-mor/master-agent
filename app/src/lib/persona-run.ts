/* Server-owned persona chat runs — so a home-chat reply survives a tab refresh.
 *
 * Like the Mission Control orchestrator, a run lives in a globalThis registry
 * independent of the HTTP request that started it: the `claude` child process,
 * an append-only event log, and a set of subscribers. The request that starts a
 * run (POST) just SUBSCRIBES to stream it; a refreshed tab re-subscribes (GET
 * reattach) and gets the whole log replayed, then the live tail. A client
 * disconnect only unsubscribes — it never kills the child. Stopping is explicit.
 *
 * One active run per (projectKey, sessionKey). Persistence to layered memory
 * happens here on process close, so it's done whether or not anyone's watching. */

import { spawn, type ChildProcess } from "node:child_process";
import { appendTurn, autoTagTurn, evictIfNeeded, updateSession, autoNameSession } from "@/lib/persona-memory";
import { planFlow, listAgents } from "@/lib/agents";
import { startFlow } from "@/lib/orchestrator";

export type PersonaEvent = { event: string; data: unknown };
type Subscriber = (e: PersonaEvent) => void;

type PersonaRun = {
  id: string;
  projectKey: string;
  projectSlug: string | undefined;   // workspace slug, for flow launches
  projectName: string;
  sessionKey: string;
  sessionLabel: string;
  prompt: string;                    // the user prompt (for reattach reconstruction)
  startedAt: number;
  status: "running" | "done" | "error";
  events: PersonaEvent[];            // append-only log, replayed to new subscribers
  reply: string;
  toolUses: string[];
  sessionIdFromRun: string | null;
  priorClaudeId: string | null;
  isFirstTurn: boolean;
  child: ChildProcess | null;
  subscribers: Set<Subscriber>;
};

type Registry = { runs: Map<string, PersonaRun> };
const g = globalThis as unknown as { __ariaPersonaRuns?: Registry };
const reg: Registry = g.__ariaPersonaRuns ?? (g.__ariaPersonaRuns = { runs: new Map() });

const runKey = (projectKey: string, sessionKey: string) => `${projectKey}::${sessionKey}`;
let seq = 0;

function emit(run: PersonaRun, event: string, data: unknown) {
  const e: PersonaEvent = { event, data };
  run.events.push(e);
  for (const cb of [...run.subscribers]) { try { cb(e); } catch { /* a dead subscriber never blocks the rest */ } }
}

/** Snapshot the current event log AND register for future events atomically. The
 *  caller replays `replay` (synchronously — no await) before any live event can
 *  arrive, so ordering is preserved. Returns null if no run for this session. */
export function subscribePersonaRun(projectKey: string, sessionKey: string, cb: Subscriber): { replay: PersonaEvent[]; unsubscribe: () => void } | null {
  const run = reg.runs.get(runKey(projectKey, sessionKey));
  if (!run) return null;
  const replay = run.events.slice();
  run.subscribers.add(cb);
  return { replay, unsubscribe: () => { run.subscribers.delete(cb); } };
}

/** Is a run currently in flight for this session? */
export function hasActivePersonaRun(projectKey: string, sessionKey: string): boolean {
  const run = reg.runs.get(runKey(projectKey, sessionKey));
  return !!run && run.status === "running";
}

/** Explicit stop — kills the child (the close handler still persists the partial reply). */
export function stopPersonaRun(projectKey: string, sessionKey: string): boolean {
  const run = reg.runs.get(runKey(projectKey, sessionKey));
  if (!run) return false;
  try { run.child?.kill("SIGTERM"); } catch {}
  return true;
}

export type StartParams = {
  projectKey: string;
  projectSlug: string | undefined;
  projectName: string;
  sessionKey: string;
  sessionLabel: string;
  cwd: string;
  claudeBin: string;
  args: string[];
  finalPrompt: string;
  userPrompt: string;
  priorClaudeId: string | null;
  isFirstTurn: boolean;
  continuity: unknown;               // emitted first so the UI shows continuity mode
};

/** Spawn claude and register the run. Returns immediately; events flow into the
 *  log + subscribers on later ticks. Supersedes any existing run for the session. */
export function startPersonaRun(p: StartParams): PersonaRun {
  const k = runKey(p.projectKey, p.sessionKey);
  const existing = reg.runs.get(k);
  if (existing) { try { existing.child?.kill("SIGTERM"); } catch {} reg.runs.delete(k); }

  const run: PersonaRun = {
    id: `prun_${Date.now().toString(36)}_${(seq++).toString(36)}`,
    projectKey: p.projectKey, projectSlug: p.projectSlug, projectName: p.projectName,
    sessionKey: p.sessionKey, sessionLabel: p.sessionLabel, prompt: p.userPrompt,
    startedAt: Date.now(), status: "running", events: [], reply: "", toolUses: [],
    sessionIdFromRun: null, priorClaudeId: p.priorClaudeId, isFirstTurn: p.isFirstTurn,
    child: null, subscribers: new Set(),
  };
  reg.runs.set(k, run);

  // First log entries: `begin` carries the prompt so a reattaching tab can rebuild
  // the turn from scratch; `continuity` mirrors the old inline event.
  emit(run, "begin", { runId: run.id, prompt: p.userPrompt, startedAt: run.startedAt });
  emit(run, "continuity", p.continuity);

  let child: ChildProcess;
  try {
    child = spawn(p.claudeBin, p.args, { cwd: p.cwd, windowsHide: true, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
    run.child = child;
    child.stdin!.write(p.finalPrompt);
    child.stdin!.end();
  } catch (err) {
    emit(run, "error", { message: `Failed to spawn claude: ${(err as Error).message}` });
    run.status = "error";
    emit(run, "done", { code: null });
    void finishAndPersist(run, null);
    return run;
  }

  // Mid-stream [[FLOW goal="…"]] — plan + start a flow once, surface it to the UI.
  let flowLaunched = false;
  let flowLaunchPromise: Promise<void> | null = null;
  const FLOW_RE = /\[\[\s*FLOW\s+goal="([^"]+)"\s*\]\]/i;
  const maybeLaunchFlow = () => {
    if (flowLaunched) return;
    const m = FLOW_RE.exec(run.reply);
    if (!m) return;
    flowLaunched = true;
    const goal = m[1].trim();
    flowLaunchPromise = (async () => {
      try {
        const agents = await listAgents();
        const steps = await planFlow(goal, agents);
        const { flowId } = await startFlow({ name: goal.length > 40 ? goal.slice(0, 40) + "…" : goal, project: p.projectSlug, rootInput: goal, steps });
        emit(run, "flow", { flowId, goal, stepCount: steps.length });
      } catch (e) {
        emit(run, "flow", { goal, error: `Flow launch failed: ${(e as Error).message}` });
      }
    })();
  };

  let buf = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let evt: { type?: string; [k: string]: unknown };
      try { evt = JSON.parse(line); } catch { continue; }
      handle(evt);
    }
  });
  child.stderr!.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });

  function handle(evt: { type?: string; [k: string]: unknown }) {
    if (evt.type === "system") {
      const sid = (evt as { session_id?: string }).session_id ?? null;
      if (sid) run.sessionIdFromRun = sid;
      emit(run, "system", { sessionId: sid, model: (evt as { model?: string }).model });
      return;
    }
    if (evt.type === "assistant") {
      const content = (evt as { message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> } }).message?.content ?? [];
      for (const c of content) {
        if (c.type === "text" && c.text) { run.reply += c.text; emit(run, "text", { text: c.text }); maybeLaunchFlow(); }
        else if (c.type === "tool_use" && c.name) { run.toolUses.push(c.name); emit(run, "tool_use", { name: c.name, input: c.input }); }
      }
      return;
    }
    if (evt.type === "user") {
      const content = (evt as { message?: { content?: Array<{ type: string; tool_use_id?: string }> } }).message?.content ?? [];
      for (const c of content) if (c.type === "tool_result") emit(run, "tool_result", {});
      return;
    }
    if (evt.type === "result") {
      const r = evt as { is_error?: boolean; result?: string; duration_ms?: number; total_cost_usd?: number };
      if (!run.reply && r.result) run.reply = r.result;
      maybeLaunchFlow();
      emit(run, "result", { isError: !!r.is_error, text: r.result, durationMs: r.duration_ms, costUsd: r.total_cost_usd });
      return;
    }
  }

  child.on("error", (err) => {
    emit(run, "error", { message: `Claude process error: ${err.message}` });
    run.status = "error";
    emit(run, "done", { code: null });
    void finishAndPersist(run, flowLaunchPromise);
  });
  child.on("close", (code) => {
    if (code !== 0 && code !== null) emit(run, "error", { message: `Claude exited with code ${code}. ${stderr.slice(-400)}` });
    run.status = code && code !== 0 ? "error" : "done";
    emit(run, "done", { code });
    void finishAndPersist(run, flowLaunchPromise);
  });

  return run;
}

/** Persist the (possibly partial) turn + enrich memory, then drop the run from
 *  the registry. Runs server-side regardless of any connected client. */
async function finishAndPersist(run: PersonaRun, flowLaunchPromise: Promise<void> | null) {
  try {
    if (run.reply) {
      const saved = await appendTurn(run.projectKey, { prompt: run.prompt, reply: run.reply, toolUses: run.toolUses, sessionId: run.sessionIdFromRun ?? undefined, sessionKey: run.sessionKey, sessionLabel: run.sessionLabel });
      await autoTagTurn(run.projectKey, saved.id);
    }
    await updateSession(run.projectKey, run.sessionKey, { claudeSessionId: run.sessionIdFromRun ?? run.priorClaudeId, lastTurnAt: Date.now() });
    if (run.isFirstTurn) await autoNameSession(run.projectKey, run.sessionKey, run.prompt);
    await evictIfNeeded(run.projectKey);
  } catch (err) {
    console.warn("[persona-run] post-turn persistence failed:", (err as Error).message);
  }
  if (flowLaunchPromise) { try { await flowLaunchPromise; } catch {} }
  reg.runs.delete(runKey(run.projectKey, run.sessionKey));
}
