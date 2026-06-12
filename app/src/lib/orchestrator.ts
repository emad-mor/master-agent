/* Aria task orchestrator — Phase 2.
 *
 * The chat path (`/api/persona/run`) is request-scoped: one claude process, one
 * HTTP stream, dies when the request ends. That can't model parallel tasks you
 * watch independently. So tasks live HERE instead — in a server-side registry
 * that outlives any single request:
 *
 *   - A Task owns a spawned `claude -p` process and an append-only event buffer.
 *   - Any number of clients SUBSCRIBE to a task's events (replay buffer + live
 *     tail) via /api/tasks/[id]/stream. "Running" is decoupled from "watching".
 *   - A concurrency cap queues excess tasks; they start as slots free.
 *   - A Flow is a DAG of steps. Independent steps run in parallel; a step's
 *     prompt can interpolate upstream outputs ({{stepN}} / {{input}}), giving
 *     A→B→C hand-off. Each task is plain `claude -p` with full tool access, so
 *     any agent can ALSO fan out via Claude's own Agent/Task tool (claude-native
 *     sub-agents) — those show up in the task's tool-use activity.
 *
 * Module-singleton, in-memory. State lives for the life of the dev/server
 * process; restart = clean slate (tasks are ephemeral by design). The agent
 * DEFINITIONS that tasks reference are persisted separately (lib/agents.ts).
 *
 * Node-only (spawns child processes). Never import from a client component. */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolveProject, WORKSPACE_DIR } from "@/lib/workspace";
import { getAgent, listAgents, type Agent } from "@/lib/agents";
import { buildSkillBrief } from "@/lib/skills";
import { envForAgent } from "@/lib/credentials";
import { getTemplate } from "@/lib/flow-templates";
import { listCore, listThemes, appendTurn, evictIfNeeded } from "@/lib/persona-memory";
import { scheduleFlowSnapshot, loadFlowSnapshotSync } from "@/lib/flow-store";

const CLAUDE_BIN = process.platform === "win32" ? "claude.cmd" : "claude";
// Keep total live claude processes bounded. Tasks beyond this queue.
const MAX_CONCURRENT = Number(process.env.ARIA_MAX_PARALLEL || 4);

export type TaskStatus = "queued" | "running" | "done" | "error" | "stopped";

// One event in a task's append-only log. Mirrors the chat SSE vocabulary so the
// UI can render tasks and chat with the same primitives.
export type TaskEvent =
  | { seq: number; t: "status"; status: TaskStatus; at: number }
  | { seq: number; t: "system"; sessionId?: string | null; model?: string }
  | { seq: number; t: "text"; text: string }
  | { seq: number; t: "tool_use"; name: string; input?: unknown }
  | { seq: number; t: "tool_result" }
  | { seq: number; t: "activity"; label: string }
  | { seq: number; t: "result"; isError: boolean; text?: string; costUsd?: number; durationMs?: number; tokens?: TokenUsage; model?: string }
  | { seq: number; t: "error"; message: string }
  // The agent hit missing info: it proceeded on `assumed`, and surfaces `question`
  // so the user can confirm/override. NON-blocking — the task keeps running.
  | { seq: number; t: "question"; qid: string; question: string; assumed: string }
  | { seq: number; t: "summary"; summary: string }
  | { seq: number; t: "done"; code: number | null };

// Token usage from the CLI's `usage` block. We surface TOKENS (not dollars)
// because the app runs on the user's Claude SUBSCRIPTION login — the CLI's
// total_cost_usd is a notional equivalent, not an amount actually billed.
export type TokenUsage = {
  input: number;          // fresh input tokens
  output: number;         // generated tokens
  cacheRead: number;      // tokens served from prompt cache (cheap)
  cacheWrite: number;     // tokens written to the cache
};

// A surfaced question the agent answered itself (assumption) but the user may
// refine. Lives on the Task so the board can show it after the stream replays.
export type OpenQuestion = {
  qid: string;
  question: string;
  assumed: string;        // the agent's best-guess answer it proceeded with
  answered?: string;      // the user's override/confirmation, once given
  resolvedByTaskId?: string; // the follow-up task spawned to apply the answer
};

export type Task = {
  id: string;
  flowId?: string;            // set when part of a flow run
  stepKey?: string;           // step identifier within the flow (e.g. "1")
  label: string;              // short human label for the board
  project: string;            // project slug (memory/cwd scope)
  projectName: string;
  agentId?: string;           // named agent driving it (optional)
  agentName?: string;
  agentColor?: string;
  title?: string;             // short readable node label (for flow steps)
  promptTemplate: string;     // the ORIGINAL prompt (with {{…}} placeholders) — editable
  prompt: string;             // the resolved prompt actually sent
  summary?: string;           // brief 1-2 sentence gist of the output (Haiku, background)
  status: TaskStatus;
  reply: string;              // accumulated assistant text
  toolUses: string[];
  activity?: string;          // latest live activity label
  sessionId?: string | null;
  dependsOn: string[];        // stepKeys this task waits on (within its flow)
  questions: OpenQuestion[];  // info the agent assumed; user may refine
  parentTaskId?: string;      // for chained/answer follow-ups: the task this came from
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  costUsd?: number;           // notional $ from the CLI (subscription → not actually billed)
  tokens?: TokenUsage;        // real token usage for this run
  model?: string;             // model the CLI actually used (from modelUsage/system)
};

type TaskRecord = {
  task: Task;
  events: TaskEvent[];
  seq: number;
  child?: ChildProcess;
  subscribers: Set<(e: TaskEvent) => void>;
  // Resolves when the task reaches a terminal state — used by the flow runner.
  done: Promise<Task>;
  resolveDone?: (t: Task) => void;
  // Set when WE kill the child intentionally (pause-to-resume / reset), so the
  // child's "close" handler doesn't misreport the SIGTERM as an error.
  intentionalKill?: "pause" | "reset";
};

type FlowStepSpec = {
  key: string;                // unique within the flow, e.g. "1", "research"
  agentId?: string;
  title?: string;             // short readable label for the node
  prompt: string;             // may contain {{stepKey}} / {{input}} placeholders
  dependsOn?: string[];
  model?: string;             // per-step model override (rarely needed; flow.model usually wins)
};

export type Flow = {
  id: string;
  name: string;
  project: string;
  createdAt: number;
  steps: { key: string; taskId: string }[];
  // Persisted authoring spec so steps can be edited + re-run after the fact,
  // and so the flow can be re-driven (pause/play, rerun) without a live closure.
  specs: FlowStepSpec[];
  rootInput?: string;
  paused: boolean;            // when true, no further queued steps launch
  model?: string;             // flow-level model — OVERRIDES every step's agent model when set
  memorized?: boolean;        // set once the finished flow has been distilled into project memory
};

// ── The registry (module singleton; survives hot-reload via globalThis) ──
type Registry = {
  tasks: Map<string, TaskRecord>;
  flows: Map<string, Flow>;
  running: Set<string>;
  queue: string[];            // task ids waiting for a concurrency slot
};

const g = globalThis as unknown as { __ariaOrch?: Registry };
const reg: Registry = g.__ariaOrch ?? (g.__ariaOrch = (() => {
  const fresh: Registry = { tasks: new Map(), flows: new Map(), running: new Set(), queue: [] };
  rehydrateFromDisk(fresh);   // restore the last snapshot so flows survive restarts
  return fresh;
})());

/* Restore persisted tasks/flows into a fresh registry. Anything that was still
 * queued/running when the process died is marked "stopped" — its claude
 * subprocess is gone — but finished work (outputs, costs, structure) comes back
 * intact and readable. Reconstructs the TaskRecord wrapper around each Task;
 * the live fields (child/subscribers/events) start empty, and `done` resolves
 * immediately since restored tasks are already terminal. */
function rehydrateFromDisk(target: Registry) {
  try {
    const snap = loadFlowSnapshotSync();
    if (!snap) return;
    for (const t of snap.tasks as Task[]) {
      if (!t?.id) continue;
      const task: Task = (["queued", "running"].includes(t.status))
        ? { ...t, status: "stopped", activity: undefined, error: t.error ?? "Interrupted by a server restart" }
        : t;
      const rec: TaskRecord = {
        task, events: [], seq: 0, subscribers: new Set(),
        done: Promise.resolve(task), resolveDone: undefined,
      };
      target.tasks.set(task.id, rec);
    }
    for (const f of snap.flows as Flow[]) {
      if (!f?.id) continue;
      target.flows.set(f.id, { ...f, paused: false });
    }
  } catch (e) {
    console.warn("[orchestrator] registry rehydrate failed (starting empty):", (e as Error).message);
  }
}

/* Snapshot the serializable registry state (debounced). Called after any change
 * that should survive a restart: status transitions, flow creation, clears. */
function persistRegistry() {
  scheduleFlowSnapshot(() => ({
    tasks: [...reg.tasks.values()].map((r) => r.task),
    flows: [...reg.flows.values()],
    savedAt: Date.now(),
  }));
}

// ── Event plumbing ──
// Distributive Omit so the discriminated union keeps each variant's fields.
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
function emit(rec: TaskRecord, e: DistributiveOmit<TaskEvent, "seq">) {
  const full = { ...e, seq: rec.seq++ } as TaskEvent;
  rec.events.push(full);
  for (const sub of rec.subscribers) {
    try { sub(full); } catch { /* a dead subscriber shouldn't break others */ }
  }
}

function setStatus(rec: TaskRecord, status: TaskStatus) {
  rec.task.status = status;
  emit(rec, { t: "status", status, at: Date.now() });
  persistRegistry();
}

// ── Public: subscribe to a task's event log (replay + live) ──
export function subscribe(taskId: string, fn: (e: TaskEvent) => void): { replay: TaskEvent[]; unsubscribe: () => void } | null {
  const rec = reg.tasks.get(taskId);
  if (!rec) return null;
  rec.subscribers.add(fn);
  return {
    replay: [...rec.events],
    unsubscribe: () => { rec.subscribers.delete(fn); },
  };
}

export function getTask(id: string): Task | null {
  return reg.tasks.get(id)?.task ?? null;
}

export function listTasks(project?: string): Task[] {
  const all = [...reg.tasks.values()].map((r) => r.task);
  const filtered = project ? all.filter((t) => t.project === project) : all;
  return filtered.sort((a, b) => b.createdAt - a.createdAt);
}

export function listFlows(project?: string): Flow[] {
  const all = [...reg.flows.values()];
  return (project ? all.filter((f) => f.project === project) : all).sort((a, b) => b.createdAt - a.createdAt);
}

export function stopTask(id: string): boolean {
  const rec = reg.tasks.get(id);
  if (!rec) return false;
  if (rec.task.status === "running" || rec.task.status === "queued") {
    if (rec.child) { try { rec.child.kill("SIGTERM"); } catch {} }
    // queued-but-not-started → remove from queue and mark stopped now
    if (rec.task.status === "queued") {
      reg.queue = reg.queue.filter((q) => q !== id);
      finalize(rec, "stopped", null);
    } else {
      rec.task.status = "stopped"; // close() handler will finalize
    }
    return true;
  }
  return false;
}

/** Remove finished tasks (and any flow that's fully finished) from the registry. */
export function clearFinished(project?: string): number {
  let n = 0;
  for (const [id, rec] of reg.tasks) {
    if (project && rec.task.project !== project) continue;
    if (["done", "error", "stopped"].includes(rec.task.status)) { reg.tasks.delete(id); n++; }
  }
  for (const [id, flow] of reg.flows) {
    if (project && flow.project !== project) continue;
    if (flow.steps.every((s) => !reg.tasks.has(s.taskId))) reg.flows.delete(id);
  }
  if (n) persistRegistry();
  return n;
}

// ── Task creation + execution ──

type CreateTaskInput = {
  prompt: string;
  project?: string;
  agentId?: string;
  label?: string;
  title?: string;
  flowId?: string;
  stepKey?: string;
  dependsOn?: string[];
  parentTaskId?: string;
  resumeSessionId?: string;   // continue a prior claude session (--resume) for answers/refinements
  model?: string;             // explicit model override (task-level or flow-level)
};

/* Compact, durable memory for AGENT tasks: global core facts + the project's
 * long-term themes. Deliberately NOT recent chat turns — agents need stable
 * project context, not the user's conversation history. Capped small because it
 * rides in every step's preamble. */
async function buildAgentMemoryBlock(projectKey: string, projectName: string): Promise<string> {
  try {
    const [core, themes] = await Promise.all([listCore(), listThemes(projectKey)]);
    if (!core.length && !themes.length) return "";
    const parts: string[] = [
      "<project-memory>",
      "Durable context the user's assistant has accumulated. Treat it as known background — don't re-derive it, and don't contradict it without evidence:",
    ];
    if (core.length) { parts.push("", "Core facts (always true):"); for (const c of core) parts.push(`- ${c.text}`); }
    if (themes.length) { parts.push("", `Long-term themes — ${projectName}:`); for (const t of themes) parts.push(`- ${t.text}`); }
    parts.push("</project-memory>");
    const block = parts.join("\n");
    return block.length > 4000 ? block.slice(0, 3950) + "\n…(truncated)\n</project-memory>" : block;
  } catch { return ""; }   // memory is enrichment — never block a launch on it
}

async function makeTask(input: CreateTaskInput): Promise<TaskRecord> {
  const { name: projectName, key: projectKey, cwd } = await resolveProject(input.project);
  let agent: Agent | null = null;
  if (input.agentId) agent = await getAgent(input.agentId);

  const id = randomUUID();
  let resolveDone: ((t: Task) => void) | undefined;
  const done = new Promise<Task>((res) => { resolveDone = res; });

  const task: Task = {
    id,
    flowId: input.flowId,
    stepKey: input.stepKey,
    label: input.label || (input.prompt.length > 48 ? input.prompt.slice(0, 48) + "…" : input.prompt) || "Task",
    project: input.project || "__workspace__",
    projectName,
    agentId: agent?.id,
    agentName: agent?.name,
    agentColor: agent?.color,
    title: input.title,
    promptTemplate: input.prompt,   // keep the original (with placeholders) for edit/re-run
    prompt: input.prompt,
    status: "queued",
    reply: "",
    toolUses: [],
    sessionId: null,
    dependsOn: input.dependsOn ?? [],
    questions: [],
    parentTaskId: input.parentTaskId,
    createdAt: Date.now(),
  };

  // Resolve the agent's integration tokens NOW (server-side, async) so launch()
  // can stay synchronous. These never touch the Task record or any event.
  const credEnv = agent ? await envForAgent(agent.id) : {};
  // Same for the compact memory block (core facts + project themes).
  const memoryBlock = await buildAgentMemoryBlock(projectKey, projectName);

  const rec: TaskRecord = { task, events: [], seq: 0, subscribers: new Set(), done, resolveDone };
  reg.tasks.set(id, rec);
  emit(rec, { t: "status", status: "queued", at: Date.now() });
  persistRegistry();   // the queued task exists from the moment it's created
  // Record the resolved model (explicit override wins over the agent's default)
  // so the board can show what will run before the CLI confirms it.
  const plannedModel = input.model || agent?.model;
  if (plannedModel) task.model = plannedModel;

  // Stash the resolved cwd + agent + creds + resume id for the runner.
  recRuntime.set(id, { cwd, agent, credEnv, resumeSessionId: input.resumeSessionId, modelOverride: input.model, memoryBlock });
  return rec;
}

// Side table for runtime-only data we don't want on the serialized Task.
const recRuntime = new Map<string, { cwd: string; agent: Agent | null; credEnv: Record<string, string>; resumeSessionId?: string; modelOverride?: string; memoryBlock?: string }>();

/** Public: start a single standalone task. Returns the task id immediately. */
export async function startTask(input: CreateTaskInput): Promise<string> {
  const rec = await makeTask(input);
  schedule();
  return rec.task.id;
}

function schedule() {
  // Promote queued tasks (whose deps are satisfied) into running slots.
  for (const rec of reg.tasks.values()) {
    if (reg.running.size >= MAX_CONCURRENT) break;
    if (rec.task.status !== "queued") continue;
    if (reg.queue.length && !reg.queue.includes(rec.task.id)) continue;
    // standalone tasks have no deps; flow steps are launched explicitly by runFlow
    if (rec.task.flowId) continue; // flow steps are scheduled by the flow runner
    launch(rec);
  }
}

// The NEVER-BLOCK operating protocol, prepended to EVERY task (agent or not).
// The task runs headless (`claude -p`), so it can't pause for input. Instead of
// stalling on missing info, the agent makes its best-justified assumption and
// proceeds — and emits a machine-readable marker we parse to surface the
// question (with that best answer) to the user, who can refine it later.
const NEVER_BLOCK_PROTOCOL = [
  "OPERATING RULES — you are running headless and MUST NOT stop to ask for input. There is no interactive user to answer mid-run.",
  "When you lack information you would normally ask about:",
  "  1. Determine the BEST possible answer from the available context (files, conventions, the task itself). State it.",
  "  2. PROCEED on that assumption — never halt, never end your turn waiting for an answer.",
  "  3. Emit ONE line for each such decision, exactly in this format so it can be surfaced to the user:",
  "       [[ASK qid=<short-slug> | question=<the question in plain words> | assumed=<the answer you proceeded with> ]]",
  "     Put these lines inline as you go. Keep doing the work regardless.",
  "Only stop when the task is genuinely complete. Lack of information is never a reason to stop.",
  "NEVER address the user with a clarifying question in prose (no 'Are you asking me to...?', no 'is this for X or Y?', no 'let me make sure I understand'). That stalls the flow. If intent is ambiguous, pick the most useful interpretation, do it, and record the ambiguity with an [[ASK ...]] line.",
  "If your input contains the output of a previous step, that is upstream material to ACT ON — transform it into the requested deliverable. Do not question why it was given to you or ask what to do with it.",
  "Begin your response with the deliverable itself, not meta-commentary about the request.",
].join("\n");

function buildSystemPreamble(agent: Agent | null): string {
  const lines: string[] = [NEVER_BLOCK_PROTOCOL];
  if (agent) {
    lines.push(`You are "${agent.name}", a specialized agent.`);
    lines.push(agent.instructions.trim());
    const skillBrief = buildSkillBrief(agent.skillIds);
    if (skillBrief) lines.push(skillBrief);
    if (agent.integrations?.length) {
      const list = agent.integrations.map((i) => `${i.name} (token in env var ${i.envVar})`).join(", ");
      lines.push(`You have credentials for these integrations available as environment variables: ${list}. Use them when the task calls for it. Never print or echo a token value.`);
    }
    if (agent.canDelegate) {
      lines.push("You MAY delegate independent sub-tasks to your own sub-agents (use the Task/Agent tool) to parallelize work, then synthesize their results.");
    }
  }
  return lines.join("\n\n");
}

function launch(rec: TaskRecord) {
  const rt = recRuntime.get(rec.task.id);
  const cwd = rt?.cwd ?? WORKSPACE_DIR;
  const agent = rt?.agent ?? null;

  rec.intentionalKill = undefined;   // fresh run — any prior intentional kill is resolved
  reg.running.add(rec.task.id);
  rec.task.status = "running";
  rec.task.startedAt = Date.now();
  setStatus(rec, "running");
  emit(rec, { t: "activity", label: "Starting…" });

  // A resumed task (answer/refinement) continues an existing session, so it
  // already has the full prior context — don't re-send the heavy preamble.
  const resumeId = rt?.resumeSessionId;
  const preamble = buildSystemPreamble(agent);
  const memory = rt?.memoryBlock ? `\n\n${rt.memoryBlock}` : "";
  const finalPrompt = resumeId ? rec.task.prompt : `${preamble}${memory}\n\n---\n\n${rec.task.prompt}`;

  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--add-dir", WORKSPACE_DIR,
    "--input-format", "text",
  ];
  // Model precedence: an explicit override (flow-level, or task-level) wins over
  // the agent's own default model. A flow with a chosen model overrides ALL its
  // agents; a flow with no model lets each step's agent model stand.
  const model = rt?.modelOverride || agent?.model;
  if (model) args.push("--model", model);
  if (resumeId) args.push("--resume", resumeId);

  // Merge the agent's integration tokens into the child's environment. Tokens
  // exist ONLY here, in the process env — not in the prompt, transcript, or log.
  const childEnv = { ...process.env, ...(rt?.credEnv ?? {}) };

  let child: ChildProcess;
  try {
    child = spawn(CLAUDE_BIN, args, {
      cwd,
      env: childEnv,
      windowsHide: true,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    emit(rec, { t: "error", message: `Failed to spawn claude: ${(err as Error).message}` });
    finalize(rec, "error", null);
    return;
  }
  rec.child = child;
  try { child.stdin!.write(finalPrompt); child.stdin!.end(); } catch {}

  let buf = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let evt: Record<string, unknown>;
      try { evt = JSON.parse(line); } catch { continue; }
      handleClaudeEvent(rec, evt);
    }
  });
  child.stderr!.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
  child.on("error", (err) => {
    emit(rec, { t: "error", message: `Process error: ${err.message}` });
    finalize(rec, "error", null);
  });
  child.on("close", (code) => {
    // We killed it on purpose to pause/reset — it's already been re-queued; do
    // not finalize as error/stopped. The flag is cleared by the next launch().
    if (rec.intentionalKill) { rec.child = undefined; return; }
    if (rec.task.status === "stopped") { finalize(rec, "stopped", code); return; }
    if (code !== 0 && code !== null) {
      emit(rec, { t: "error", message: `claude exited ${code}. ${stderr.slice(-300)}` });
      finalize(rec, "error", code);
      return;
    }
    finalize(rec, "done", code);
  });
}

// Parse [[ASK qid=… | question=… | assumed=… ]] markers out of the accumulated
// reply, recording each new one on the task and emitting a question event. Idempotent
// (dedupes by qid), so it's safe to call on every streamed text chunk.
const ASK_RE = /\[\[\s*ASK\s+qid=([^|\]]+?)\s*\|\s*question=([^|\]]+?)\s*\|\s*assumed=([^\]]+?)\s*\]\]/gi;
function scanForQuestions(rec: TaskRecord) {
  ASK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ASK_RE.exec(rec.task.reply)) !== null) {
    const qid = m[1].trim();
    if (rec.task.questions.some((q) => q.qid === qid)) continue;  // already surfaced
    const question = m[2].trim();
    const assumed = m[3].trim();
    rec.task.questions.push({ qid, question, assumed });
    emit(rec, { t: "question", qid, question, assumed });
  }
}

function handleClaudeEvent(rec: TaskRecord, evt: Record<string, unknown>) {
  const type = evt.type as string;
  if (type === "system") {
    const sid = (evt.session_id as string) ?? null;
    if (sid) rec.task.sessionId = sid;
    const model = evt.model as string | undefined;
    if (model) rec.task.model = model;
    emit(rec, { t: "system", sessionId: sid, model });
    return;
  }
  if (type === "assistant") {
    const content = (evt.message as { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> })?.content ?? [];
    for (const c of content) {
      if (c.type === "text" && c.text) {
        rec.task.reply += c.text;
        rec.task.activity = "Writing reply…";
        emit(rec, { t: "text", text: c.text });
        scanForQuestions(rec);   // surface any [[ASK ...]] markers the agent emitted
      } else if (c.type === "tool_use" && c.name) {
        rec.task.toolUses.push(c.name);
        rec.task.activity = `Running ${c.name}…`;
        emit(rec, { t: "tool_use", name: c.name, input: c.input });
        emit(rec, { t: "activity", label: rec.task.activity });
      }
    }
    return;
  }
  if (type === "user") {
    const content = (evt.message as { content?: Array<{ type: string }> })?.content ?? [];
    for (const c of content) if (c.type === "tool_result") { rec.task.activity = "Thinking…"; emit(rec, { t: "tool_result" }); }
    return;
  }
  if (type === "result") {
    const r = evt as {
      is_error?: boolean; result?: string; duration_ms?: number; total_cost_usd?: number;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
      modelUsage?: Record<string, unknown>;
    };
    if (!rec.task.reply && r.result) rec.task.reply = r.result;
    if (typeof r.total_cost_usd === "number") rec.task.costUsd = r.total_cost_usd;
    const tokens = r.usage ? {
      input: r.usage.input_tokens ?? 0,
      output: r.usage.output_tokens ?? 0,
      cacheRead: r.usage.cache_read_input_tokens ?? 0,
      cacheWrite: r.usage.cache_creation_input_tokens ?? 0,
    } : undefined;
    if (tokens) rec.task.tokens = tokens;
    // modelUsage keys are the actual model IDs the CLI billed — prefer the first.
    const usedModel = r.modelUsage && Object.keys(r.modelUsage)[0];
    if (usedModel) rec.task.model = usedModel;
    scanForQuestions(rec);   // catch markers only present in the final result text
    emit(rec, { t: "result", isError: !!r.is_error, text: r.result, costUsd: r.total_cost_usd, durationMs: r.duration_ms, tokens, model: usedModel || undefined });
  }
}

function finalize(rec: TaskRecord, status: TaskStatus, code: number | null) {
  reg.running.delete(rec.task.id);
  rec.task.status = status;
  rec.task.finishedAt = Date.now();
  rec.task.activity = undefined;
  if (status === "error" && !rec.task.error) rec.task.error = "Task failed";
  emit(rec, { t: "status", status, at: Date.now() });
  emit(rec, { t: "done", code });
  rec.child = undefined;
  rec.resolveDone?.(rec.task);
  persistRegistry();   // capture the terminal state + final reply/cost/tokens
  // Background: distill a brief gist of the output so the node is readable at a
  // glance without expanding. Cheap Haiku; never blocks anything.
  if (status === "done" && rec.task.reply.trim()) void summarizeTask(rec);
  schedule(); // free slot → promote next queued standalone task
}

const SUMMARY_MODEL = process.env.ARIA_MEMORY_MODEL || "claude-haiku-4-5-20251001";

/** Run a one-shot Haiku prompt and return its text. Shared by summarizeTask,
 *  flow distillation, and the handoff route. Returns "" on any failure. */
export async function runHaiku(prompt: string, timeoutMs = 30_000): Promise<string> {
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(CLAUDE_BIN, ["-p", "--output-format", "text", "--input-format", "text", "--model", SUMMARY_MODEL, "--dangerously-skip-permissions"],
        { cwd: WORKSPACE_DIR, shell: process.platform === "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let o = ""; const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error("timeout")); }, timeoutMs);
      child.stdout!.on("data", (d) => { o += d.toString(); });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", () => { clearTimeout(timer); resolve(o.trim()); });
      child.stdin!.write(prompt); child.stdin!.end();
    });
  } catch { return ""; }
}

async function summarizeTask(rec: TaskRecord) {
  const body = stripAskMarkers(rec.task.reply).slice(0, 4000);
  if (!body) return;
  const prompt = `Summarize the GIST of this agent step's output for a glanceable card, in 1-2 plain sentences. Lead with the key result/finding (e.g. what was produced, decided, or found). Write in the third person about the work ("Compared five memory systems and ranked..."), NOT in the agent's first-person voice. Do NOT echo or quote the output's opening words. If the output is mostly a clarifying question or meta-commentary rather than a deliverable, say so plainly (e.g. "Asked for clarification before proceeding."). No preamble, no markdown.\n\n${body}`;
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(CLAUDE_BIN, ["-p", "--output-format", "text", "--input-format", "text", "--model", SUMMARY_MODEL, "--dangerously-skip-permissions"],
        { cwd: WORKSPACE_DIR, shell: process.platform === "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let o = ""; const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error("timeout")); }, 20_000);
      child.stdout!.on("data", (d) => { o += d.toString(); });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", () => { clearTimeout(timer); resolve(o.trim()); });
      child.stdin!.write(prompt); child.stdin!.end();
    });
    const summary = out.split("\n").map((l) => l.trim()).filter(Boolean).join(" ").slice(0, 280);
    if (summary) { rec.task.summary = summary; emit(rec, { t: "summary", summary }); persistRegistry(); }
  } catch { /* best effort */ }
}

function stripAskMarkers(text: string) {
  return text.replace(/\[\[\s*ASK\b[^\]]*\]\]/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ── Flows: DAG of steps with output piping ──

function interpolate(template: string, outputs: Map<string, string>, rootInput?: string): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, k: string) => {
    if (k === "input" && rootInput != null) return rootInput;
    const out = outputs.get(k);
    if (out == null) return "";
    // Frame an injected upstream output with an explicit delimiter so the agent
    // treats it as material to act on (chain input) — not as an ambiguous user
    // message to interrogate. Without this, vague step prompts ("summarize this")
    // make the agent stop and ask "what do you want me to do with this?".
    return `\n\n----- output of step ${k} (act on this; do not ask the user about it) -----\n${out}\n----- end of step ${k} output -----\n`;
  });
}

/**
 * Start a flow: create all step tasks (queued), then drive the DAG — launch a
 * step once all its deps have finished, piping each finished step's reply into
 * downstream prompts via {{stepKey}}. Independent steps run concurrently (capped
 * by MAX_CONCURRENT). Returns the flow id + the created task ids immediately.
 */
export async function startFlow(input: {
  name: string;
  project?: string;
  rootInput?: string;
  steps: FlowStepSpec[];
  model?: string;             // flow-level model — overrides every step's agent model
}): Promise<{ flowId: string; taskIds: { key: string; taskId: string }[] }> {
  const flowId = randomUUID();
  const project = input.project || "__workspace__";

  // Create a queued task per step (prompt resolved at launch, after deps finish).
  const recs = new Map<string, TaskRecord>();
  for (const step of input.steps) {
    const rec = await makeTask({
      prompt: step.prompt,                 // placeholders resolved at launch
      project,
      agentId: step.agentId,
      flowId,
      stepKey: step.key,
      dependsOn: step.dependsOn ?? [],
      label: step.title || `Step ${step.key}`,
      title: step.title,
      // Flow model overrides everything; else a per-step model; else the agent's.
      model: input.model || step.model,
    });
    recs.set(step.key, rec);
  }

  const flow: Flow = {
    id: flowId,
    name: input.name,
    project,
    createdAt: Date.now(),
    steps: [...recs.entries()].map(([key, rec]) => ({ key, taskId: rec.task.id })),
    specs: input.steps,
    rootInput: input.rootInput,
    paused: false,
    model: input.model,
  };
  reg.flows.set(flowId, flow);

  persistRegistry();   // capture the flow + its queued steps from the start
  driveFlow(flowId);   // idempotent scan-and-launch; reads everything from the flow record
  return { flowId, taskIds: flow.steps };
}

/** Instantiate a saved template into a live flow, resolving agent roles → ids. */
export async function startFlowFromTemplate(templateId: string, project?: string, rootInput?: string, model?: string): Promise<{ flowId: string; taskIds: { key: string; taskId: string }[] } | null> {
  const tmpl = await getTemplate(templateId);
  if (!tmpl) return null;
  const agents = await listAgents();
  const byRole = new Map(agents.map((a) => [a.name.toLowerCase(), a.id]));
  const steps: FlowStepSpec[] = tmpl.steps.map((s) => ({
    key: s.key,
    agentId: s.agentRole ? byRole.get(s.agentRole.toLowerCase()) : undefined,
    title: s.title,
    prompt: s.prompt,
    dependsOn: s.dependsOn,
  }));
  return startFlow({ name: tmpl.name, project, rootInput, steps, model });
}

// Collected final outputs of finished steps in a flow (stepKey → reply).
function flowOutputs(flow: Flow): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of flow.steps) {
    const rec = reg.tasks.get(s.taskId);
    if (rec && rec.task.status === "done") out.set(s.key, rec.task.reply);
  }
  return out;
}

/**
 * Idempotent flow driver. Scans the flow's steps and launches any whose deps are
 * all DONE and that haven't started yet — unless the flow is paused. Re-invoked
 * whenever something changes (a step finishes, pause toggles, a step is re-run),
 * so it doubles as the resume/re-run engine. Each launching step's prompt is
 * (re)interpolated from current upstream outputs.
 */
function driveFlow(flowId: string) {
  const flow = reg.flows.get(flowId);
  if (!flow || flow.paused) return;
  const outputs = flowOutputs(flow);
  const specByKey = new Map(flow.specs.map((s) => [s.key, s]));

  for (const s of flow.steps) {
    const rec = reg.tasks.get(s.taskId);
    if (!rec) continue;
    if (rec.task.status !== "queued") continue;             // already running/done/etc.
    const spec = specByKey.get(s.key);
    const deps = spec?.dependsOn ?? rec.task.dependsOn ?? [];
    if (!deps.every((d) => outputs.has(d))) continue;       // deps not all done
    rec.task.prompt = interpolate(spec?.prompt ?? rec.task.promptTemplate, outputs, flow.rootInput);
    void runFlowStep(flowId, rec);
  }
}

async function runFlowStep(flowId: string, rec: TaskRecord) {
  // Honor the global concurrency cap even for flow steps.
  while (reg.running.size >= MAX_CONCURRENT) {
    await new Promise((r) => setTimeout(r, 150));
    if (rec.task.status !== "queued") return;
    const f = reg.flows.get(flowId);
    if (f?.paused) return;   // paused while we waited — leave it queued
  }
  if (rec.task.status !== "queued") return;
  launch(rec);
  await rec.done;
  driveFlow(flowId);   // a step finished → maybe unblock downstream
  void maybeMemorizeFlow(flowId);   // all steps terminal → distill into project memory
}

/* Everything a handoff needs to carry a flow's results into an Aria chat
 * session: the flow record plus each step's task fields. */
export function getFlowResults(flowId: string): { flow: Flow; steps: Task[] } | null {
  const flow = reg.flows.get(flowId);
  if (!flow) return null;
  const steps = flow.steps.map((s) => reg.tasks.get(s.taskId)?.task).filter((t): t is Task => !!t);
  return { flow, steps };
}

/* Bridge: flow results → project memory. When every step of a flow reaches a
 * terminal state (with at least one success), distill the combined outputs into
 * a compact learning and record it as a memory turn — so Aria genuinely
 * remembers what her agents discovered, and it rolls through the normal
 * Recent → Mid → Long memory lifecycle. Guarded to run once per flow. */
async function maybeMemorizeFlow(flowId: string) {
  const flow = reg.flows.get(flowId);
  if (!flow || flow.memorized) return;
  const recs = flow.steps.map((s) => reg.tasks.get(s.taskId)).filter((r): r is TaskRecord => !!r);
  if (!recs.length) return;
  if (!recs.every((r) => ["done", "error", "stopped"].includes(r.task.status))) return;   // still running
  if (!recs.some((r) => r.task.status === "done")) return;                                // nothing succeeded
  flow.memorized = true;   // claim BEFORE the async work so a racing step can't double-fire
  persistRegistry();       // persist the claim so a restart mid-distill doesn't re-run it

  try {
    const { key: projectKey } = await resolveProject(flow.project);
    // Feed the distiller each step's gist (summary if we have one, else a slice
    // of its output), bounded so the prompt stays small.
    const stepLines = recs
      .filter((r) => r.task.status === "done")
      .map((r) => `Step ${r.task.stepKey} (${r.task.agentName ?? "Aria"} — ${r.task.title ?? r.task.label}): ${(r.task.summary || stripAskMarkers(r.task.reply)).slice(0, 700)}`);
    const prompt = [
      "A multi-agent flow just completed. Distill its DURABLE learnings into 2-4 plain sentences for the assistant's long-term project memory.",
      "Capture: what was investigated/produced, the key findings or decisions, and anything the user is likely to reference later. Write in the third person, past tense. No markdown, no preamble.",
      "You are writing to a memory file — there is NO ONE to ask for more context. Never refuse, never ask questions. If the content is trivial or test-like, simply state in one sentence what the flow ran and produced.",
      "",
      `Flow: ${flow.name}`,
      flow.rootInput ? `Goal: ${flow.rootInput.slice(0, 500)}` : "",
      "",
      ...stepLines,
    ].filter(Boolean).join("\n");

    const distilled = await new Promise<string>((resolve, reject) => {
      const child = spawn(CLAUDE_BIN, ["-p", "--output-format", "text", "--input-format", "text", "--model", SUMMARY_MODEL, "--dangerously-skip-permissions"],
        { cwd: WORKSPACE_DIR, shell: process.platform === "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let o = ""; const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error("timeout")); }, 25_000);
      child.stdout!.on("data", (d) => { o += d.toString(); });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", () => { clearTimeout(timer); resolve(o.trim()); });
      child.stdin!.write(prompt); child.stdin!.end();
    });
    if (!distilled) return;

    await appendTurn(projectKey, {
      prompt: `[flow completed] ${flow.name}`,
      reply: distilled.slice(0, 1200),
      toolUses: [],
      category: "Flow",
    });
    await evictIfNeeded(projectKey);
  } catch (e) {
    console.warn("flow→memory distillation failed (non-fatal):", e);
  }
}

// ── Flow controls: pause / play / stop ──

export function pauseFlow(flowId: string): boolean {
  const flow = reg.flows.get(flowId);
  if (!flow) return false;
  flow.paused = true;
  // Kill+remember any currently-running steps so Play can --resume them.
  for (const s of flow.steps) {
    const rec = reg.tasks.get(s.taskId);
    if (rec && rec.task.status === "running") {
      // Mark for resume: re-queue it, remembering its session so launch() resumes.
      const rt = recRuntime.get(rec.task.id);
      if (rt) rt.resumeSessionId = rec.task.sessionId ?? rt.resumeSessionId;
      rec.intentionalKill = "pause";
      rec.task.status = "queued";
      reg.running.delete(rec.task.id);
      if (rec.child) { try { rec.child.kill("SIGTERM"); } catch {} }
      emit(rec, { t: "activity", label: "Paused — will resume on Play" });
      emit(rec, { t: "status", status: "queued", at: Date.now() });
    }
  }
  return true;
}

export function playFlow(flowId: string): boolean {
  const flow = reg.flows.get(flowId);
  if (!flow) return false;
  flow.paused = false;
  driveFlow(flowId);   // resume launching queued steps (incl. ones paused mid-run)
  return true;
}

export function stopFlow(flowId: string): boolean {
  const flow = reg.flows.get(flowId);
  if (!flow) return false;
  flow.paused = true;   // prevent any further launches
  for (const s of flow.steps) {
    const rec = reg.tasks.get(s.taskId);
    if (!rec) continue;
    if (rec.task.status === "running") {
      rec.task.status = "stopped";
      if (rec.child) { try { rec.child.kill("SIGTERM"); } catch {} }
    } else if (rec.task.status === "queued") {
      finalize(rec, "stopped", null);
    }
  }
  return true;
}

// ── Editing a step + re-running (with optional downstream cascade) ──

export function editStep(taskId: string, patch: { prompt?: string; title?: string }): boolean {
  const rec = reg.tasks.get(taskId);
  if (!rec) return false;
  if (patch.prompt != null) {
    rec.task.promptTemplate = patch.prompt;
    // keep the flow spec in sync so re-drives use the new text
    if (rec.task.flowId) {
      const flow = reg.flows.get(rec.task.flowId);
      const spec = flow?.specs.find((s) => s.key === rec.task.stepKey);
      if (spec) spec.prompt = patch.prompt;
    }
  }
  if (patch.title != null) {
    rec.task.title = patch.title;
    rec.task.label = patch.title || rec.task.label;
    if (rec.task.flowId) {
      const flow = reg.flows.get(rec.task.flowId);
      const spec = flow?.specs.find((s) => s.key === rec.task.stepKey);
      if (spec) spec.title = patch.title;
    }
  }
  return true;
}

/** Step keys that (transitively) depend on the given step within its flow. */
function downstreamOf(flow: Flow, startKey: string): string[] {
  const result: string[] = [];
  const queue = [startKey];
  while (queue.length) {
    const k = queue.shift()!;
    for (const spec of flow.specs) {
      if ((spec.dependsOn ?? []).includes(k) && !result.includes(spec.key)) {
        result.push(spec.key);
        queue.push(spec.key);
      }
    }
  }
  return result;
}

/**
 * Re-run a step. Resets it (and, if cascade, every step downstream) to queued,
 * clearing prior output, then re-drives the flow so they run again with fresh
 * upstream inputs. Standalone tasks (no flow) are simply re-launched.
 * Returns the list of step keys that were reset.
 */
export async function rerunStep(taskId: string, cascade: boolean): Promise<string[] | null> {
  const rec = reg.tasks.get(taskId);
  if (!rec) return null;

  // Standalone task: re-run in place.
  if (!rec.task.flowId || !rec.task.stepKey) {
    resetTask(rec);
    schedule();
    if (rec.task.status === "queued" && !rec.task.flowId) { /* schedule handles it */ }
    return [rec.task.stepKey ?? rec.task.id];
  }

  const flow = reg.flows.get(rec.task.flowId);
  if (!flow) return null;
  const keys = cascade ? [rec.task.stepKey, ...downstreamOf(flow, rec.task.stepKey)] : [rec.task.stepKey];
  for (const key of keys) {
    const step = flow.steps.find((s) => s.key === key);
    const r = step && reg.tasks.get(step.taskId);
    if (r) resetTask(r);
  }
  flow.paused = false;
  driveFlow(flow.id);
  return keys;
}

// Reset a task back to queued, clearing its prior run state (keeps the template).
function resetTask(rec: TaskRecord) {
  if (rec.task.status === "running" && rec.child) { rec.intentionalKill = "reset"; try { rec.child.kill("SIGTERM"); } catch {} }
  reg.running.delete(rec.task.id);
  rec.task.status = "queued";
  rec.task.reply = "";
  rec.task.toolUses = [];
  rec.task.questions = [];
  rec.task.activity = undefined;
  rec.task.error = undefined;
  rec.task.costUsd = undefined;
  rec.task.startedAt = undefined;
  rec.task.finishedAt = undefined;
  rec.task.sessionId = null;
  rec.task.prompt = rec.task.promptTemplate;
  rec.task.summary = undefined;
  // fresh terminal promise so flow driver can await this run
  rec.done = new Promise<Task>((res) => { rec.resolveDone = res; });
  const rt = recRuntime.get(rec.task.id);
  if (rt) rt.resumeSessionId = undefined;
  emit(rec, { t: "status", status: "queued", at: Date.now() });
  emit(rec, { t: "activity", label: "Re-queued" });
}

// ── Chaining work onto an existing task (turns any task into a flow) ──

/**
 * Append a new step that depends on an existing task, wiring that task's final
 * reply into the new prompt as {{input}}. If the source is standalone, both are
 * pulled into a NEW flow so the board can render them as a chain. The new step
 * launches once the source finishes (or right away if it already has).
 */
export async function chainTask(sourceTaskId: string, input: { prompt: string; agentId?: string; label?: string }): Promise<string | null> {
  const source = reg.tasks.get(sourceTaskId);
  if (!source) return null;

  // Find or create the flow this chain belongs to.
  let flow: Flow | undefined = source.task.flowId ? reg.flows.get(source.task.flowId) : undefined;
  if (!flow) {
    // Promote the standalone source into a fresh flow as step "1".
    const flowId = randomUUID();
    source.task.flowId = flowId;
    source.task.stepKey = source.task.stepKey ?? "1";
    flow = {
      id: flowId, name: source.task.label, project: source.task.project, createdAt: source.task.createdAt,
      steps: [{ key: source.task.stepKey, taskId: source.task.id }],
      specs: [{ key: source.task.stepKey, agentId: source.task.agentId, title: source.task.title, prompt: source.task.promptTemplate, dependsOn: [] }],
      paused: false,
    };
    reg.flows.set(flowId, flow);
  }

  const stepKey = String(flow.steps.length + 1);
  const rec = await makeTask({
    prompt: input.prompt,                 // resolved at launch with {{input}} = source reply
    project: source.task.project,
    agentId: input.agentId,
    flowId: flow.id,
    stepKey,
    dependsOn: [source.task.stepKey!],
    parentTaskId: source.task.id,
    label: input.label || `Step ${stepKey}`,
    title: input.label,
  });
  flow.steps.push({ key: stepKey, taskId: rec.task.id });
  flow.specs.push({ key: stepKey, agentId: input.agentId, title: input.label, prompt: input.prompt, dependsOn: [source.task.stepKey!] });

  // Launch when the source is done, piping its reply into {{input}}.
  const runWhenReady = async () => {
    if (!["done", "error", "stopped"].includes(source.task.status)) {
      await source.done.catch(() => {});
    }
    rec.task.prompt = interpolate(input.prompt, new Map(), source.task.reply);
    while (reg.running.size >= MAX_CONCURRENT) {
      await new Promise((r) => setTimeout(r, 150));
      if (rec.task.status === "stopped") return;
    }
    if (rec.task.status === "queued") launch(rec);
  };
  void runWhenReady();
  return rec.task.id;
}

// ── Answering an agent's surfaced question (never-block refinement) ──

/**
 * The agent proceeded on an assumption; the user now supplies the real answer.
 * We mark the question answered and spawn a follow-up task that --resumes the
 * source's claude session, telling it to revise its work given the correction.
 * The original task is untouched (it already ran); this refines on top.
 */
export async function answerQuestion(taskId: string, qid: string, answer: string): Promise<string | null> {
  const source = reg.tasks.get(taskId);
  if (!source) return null;
  const q = source.task.questions.find((x) => x.qid === qid);
  if (!q) return null;
  q.answered = answer;

  // No session to resume? Fall back to a fresh follow-up that carries the context.
  const resumeSessionId = source.task.sessionId ?? undefined;
  const prompt = resumeSessionId
    ? `Correction on an earlier assumption. You asked: "${q.question}" and proceeded assuming "${q.assumed}". The actual answer is: "${answer}". Revise your work accordingly and report what changed.`
    : `Earlier task: ${source.task.prompt}\n\nYou had to assume "${q.assumed}" for: "${q.question}". The actual answer is "${answer}". Redo/adjust the relevant part and report what changed.`;

  const stepKey = source.task.flowId ? `${source.task.stepKey}a` : undefined;
  const rec = await makeTask({
    prompt,
    project: source.task.project,
    agentId: source.task.agentId,
    parentTaskId: source.task.id,
    flowId: source.task.flowId,
    stepKey,
    label: `↻ ${q.question.slice(0, 32)}`,
    resumeSessionId,
    model: source.task.model,   // refine with the same model the source ran on
  });
  q.resolvedByTaskId = rec.task.id;

  if (source.task.flowId) {
    // Register the refining step as a real flow step (with a spec + dep on the
    // source) so the flow OWNS it: driveFlow launches it, and when it finishes
    // driveFlow re-runs to unblock anything downstream. Launching it bare (the
    // old behavior) left the flow unaware, so the chain never reacted.
    const flow = reg.flows.get(source.task.flowId);
    if (flow) {
      flow.steps.push({ key: stepKey!, taskId: rec.task.id });
      flow.specs.push({
        key: stepKey!,
        agentId: source.task.agentId,
        title: rec.task.label,
        prompt,
        dependsOn: source.task.stepKey ? [source.task.stepKey] : [],
      });
      driveFlow(source.task.flowId);   // flow-aware launch + downstream re-drive
      return rec.task.id;
    }
  }

  schedule();
  return rec.task.id;
}
