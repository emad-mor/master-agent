"use client";

// FlowGraph — a node-and-edge canvas for a flow. Nodes are laid out in columns
// by dependency depth (topological level); SVG edges connect dependents. Each
// node is a readable card with agent, status, and expandable prompt + output,
// plus per-step view/edit/re-run. A controls bar drives flow play/pause/stop.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Play, Pause, Square, GitBranch, CircleDot, CheckCircle2, XCircle, Clock,
  Loader2, Wrench, ChevronDown, ChevronRight, Pencil, RotateCcw, Check, X, HelpCircle, Save,
  Volume2, Maximize2, Sparkles, Layers, MessageCircle,
} from "lucide-react";
import { cx } from "@/lib/format";
import { useTaskStream } from "./use-task-stream";
import { useReader } from "./use-reader";
import { Markdown } from "@/components/persona/markdown";
import { modelLabel } from "@/lib/models";

type Integration = { name: string; envVar: string };
type Agent = { id: string; name: string; instructions: string; model?: string; color: string; canDelegate: boolean; skillIds: string[]; integrations: Integration[] };
type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };
type Task = {
  id: string; flowId?: string; stepKey?: string; label: string;
  agentName?: string; agentColor?: string; title?: string;
  promptTemplate: string; prompt: string; summary?: string;
  status: "queued" | "running" | "done" | "error" | "stopped";
  reply: string; toolUses: string[]; activity?: string; dependsOn: string[];
  questions: { qid: string; question: string; assumed: string; answered?: string }[];
  startedAt?: number; finishedAt?: number; costUsd?: number; tokens?: TokenUsage; model?: string; error?: string;
};
type FlowSpec = { key: string; agentId?: string; title?: string; prompt: string; dependsOn?: string[] };
type Flow = { id: string; name: string; project: string; createdAt: number; steps: { key: string; taskId: string }[]; specs: FlowSpec[]; rootInput?: string; paused: boolean; model?: string };

export function FlowGraph({ flow, byId, agents, onControl, onStop, onChain, onAnswer, onEditRerun, onSaveTemplate }: {
  flow: Flow;
  byId: Map<string, Task>;
  agents: Agent[];
  onControl: (flowId: string, action: "play" | "pause" | "stop") => Promise<void>;
  onStop: (taskId: string) => void;
  onChain: (sourceId: string, prompt: string, agentId?: string) => Promise<void>;
  onAnswer: (taskId: string, qid: string, answer: string) => Promise<void>;
  onEditRerun: (taskId: string, edit: { prompt?: string; title?: string } | null, rerun: false | "self" | "cascade") => Promise<void>;
  onSaveTemplate: (flow: Flow) => void;
}) {
  // Build columns by dependency depth (longest path from a root).
  const { columns } = useMemo(() => layout(flow), [flow]);
  const tasks = flow.steps.map((s) => byId.get(s.taskId)).filter((t): t is Task => !!t);
  const anyLive = tasks.some((t) => t.status === "running" || t.status === "queued");
  const allDone = tasks.length > 0 && tasks.every((t) => ["done", "error", "stopped"].includes(t.status));
  const totalCost = tasks.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
  const totalTokens = tasks.reduce((sum, t) => sum + (t.tokens ? t.tokens.input + t.tokens.output : 0), 0);
  // The original prompt the user typed when starting the flow. The header name is
  // a truncated derivation of it, so expose the full text when it adds anything.
  const [showGoal, setShowGoal] = useState(false);
  const goal = flow.rootInput?.trim();
  const hasFullGoal = !!goal && goal !== flow.name && goal.replace(/…$/, "") !== flow.name.replace(/…$/, "");

  // Hand the flow's results off to an Aria chat session — flows aren't a dead
  // end; the user reviews + acts on the research in conversation.
  const [handingOff, setHandingOff] = useState(false);
  const anyDone = tasks.some((t) => t.status === "done" && t.reply.trim());
  const handoff = async () => {
    if (handingOff) return;
    setHandingOff(true);
    try {
      const r = await fetch(`/api/flows/${flow.id}/handoff`, { method: "POST" });
      const data = await r.json().catch(() => null) as { project?: string; sessionKey?: string; error?: string } | null;
      if (!r.ok || !data?.sessionKey) { alert(data?.error ?? "Couldn't hand this flow to Aria."); return; }
      window.location.href = `/?project=${encodeURIComponent(data.project || flow.project)}&session=${encodeURIComponent(data.sessionKey)}`;
    } finally { setHandingOff(false); }
  };

  return (
    <div className="fg">
      <div className="fg__head">
        <GitBranch size={14} style={{ color: "#c79bff" }} />
        <span className="fg__name" title={goal || flow.name}>{flow.name}</span>
        <span className="tk-pill">{tasks.length} steps</span>
        {totalTokens > 0 && (
          <span className="tk-pill fg__cost-pill" title={`Total fresh tokens (input + output) across all steps.\nNotional CLI cost estimate: $${totalCost.toFixed(4)} — NOT billed; this runs on your Claude subscription.`}>{fmtTokens(totalTokens)} tok</span>
        )}
        {flow.model && (
          <span className="tk-pill fg__model-pill" title="This flow forces a model — it overrides each agent's own model for every step.">{modelLabel(flow.model)}</span>
        )}
        {flow.paused && <span className="fg__badge fg__badge--paused">paused</span>}
        {anyLive && !flow.paused && <span className="fg__badge fg__badge--live"><CircleDot size={9} /> live</span>}
        <span className="aria-head__spacer" />
        {/* Controls */}
        {hasFullGoal && (
          <button className="fg__ctrl" onClick={() => setShowGoal((v) => !v)} title="Show the full prompt you started this flow with">
            {showGoal ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Prompt
          </button>
        )}
        {anyDone && (
          <button className="fg__ctrl fg__ctrl--aria" onClick={() => void handoff()} disabled={handingOff} title="Carry these results into an Aria chat session — review and act on them in conversation">
            {handingOff ? <Loader2 size={13} className="animate-spin" /> : <MessageCircle size={13} />} Continue with Aria
          </button>
        )}
        {!flow.paused
          ? <button className="fg__ctrl" onClick={() => onControl(flow.id, "pause")} disabled={!anyLive} title="Pause — running steps stop & resume on Play"><Pause size={13} /> Pause</button>
          : <button className="fg__ctrl fg__ctrl--play" onClick={() => onControl(flow.id, "play")} title="Resume"><Play size={13} fill="currentColor" /> Play</button>}
        <button className="fg__ctrl fg__ctrl--stop" onClick={() => onControl(flow.id, "stop")} disabled={allDone} title="Stop — kill running, cancel queued"><Square size={11} fill="currentColor" /> Stop</button>
        <button className="fg__ctrl" onClick={() => onSaveTemplate(flow)} title="Save this flow as a reusable template"><Save size={12} /> Save</button>
      </div>

      {hasFullGoal && showGoal && (
        <div className="fg__goal">{goal}</div>
      )}

      {/* The graph: columns by dependency depth. A column with >1 node holds
          steps that run IN PARALLEL (same depth → no ordering between them), so
          we wrap those in a labelled bracket. Single-node columns render bare. */}
      <div className="fg__canvas">
        <div className={cx("fg__cols", columns.length <= 1 && "fg__cols--single")}>
          {columns.map((col, ci) => {
            const nodes = col
              .map((k) => { const s = flow.steps.find((x) => x.key === k); return s ? byId.get(s.taskId) : undefined; })
              .filter((t): t is Task => !!t);
            if (!nodes.length) return null;
            const parallel = nodes.length > 1;
            const liveCount = nodes.filter((t) => t.status === "running").length;
            const inner = nodes.map((t) => (
              <FlowNode
                key={t.id} task={t} flow={flow} agents={agents}
                onStop={() => onStop(t.id)} onChain={onChain} onAnswer={onAnswer} onEditRerun={onEditRerun}
              />
            ));
            return (
              <div className="fg__colwrap" key={ci}>
                {ci > 0 && <div className="fg__arrow" aria-hidden><ChevronRight size={18} /></div>}
                {parallel ? (
                  <div className={cx("fg__lane", liveCount > 0 && "fg__lane--live")}>
                    <div className="fg__lane-label">
                      <Layers size={11} /> Parallel <span className="fg__lane-count">{nodes.length} steps</span>
                      {liveCount > 0 && <span className="fg__lane-running"><CircleDot size={8} /> {liveCount} running</span>}
                    </div>
                    <div className="fg__col">{inner}</div>
                  </div>
                ) : (
                  <div className="fg__col">{inner}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Layout: assign each step a column = its longest dependency depth ──
function layout(flow: Flow): { columns: string[][]; depthOf: Map<string, number> } {
  const specByKey = new Map(flow.specs.map((s) => [s.key, s]));
  const depthOf = new Map<string, number>();
  const depth = (key: string, seen = new Set<string>()): number => {
    if (depthOf.has(key)) return depthOf.get(key)!;
    if (seen.has(key)) return 0;               // cycle guard
    seen.add(key);
    const deps = specByKey.get(key)?.dependsOn ?? [];
    const d = deps.length ? Math.max(...deps.map((x) => depth(x, seen) + 1)) : 0;
    depthOf.set(key, d);
    return d;
  };
  for (const s of flow.steps) depth(s.key);
  const maxD = Math.max(0, ...[...depthOf.values()]);
  const columns: string[][] = Array.from({ length: maxD + 1 }, () => []);
  for (const s of flow.steps) columns[depthOf.get(s.key) ?? 0].push(s.key);
  return { columns, depthOf };
}

// ── A single graph node — readable, expandable, editable, re-runnable ──
function FlowNode({ task, flow, agents, onStop, onChain, onAnswer, onEditRerun }: {
  task: Task; flow: Flow; agents: Agent[];
  onStop: () => void;
  onChain: (sourceId: string, prompt: string, agentId?: string) => Promise<void>;
  onAnswer: (taskId: string, qid: string, answer: string) => Promise<void>;
  onEditRerun: (taskId: string, edit: { prompt?: string; title?: string } | null, rerun: false | "self" | "cascade") => Promise<void>;
}) {
  const live = task.status === "running" || task.status === "queued";
  const stream = useTaskStream(task.id, live);
  const reply = (live ? stream.reply : "") || task.reply;
  const toolUses = (live && stream.toolUses.length ? stream.toolUses : task.toolUses) ?? [];
  const status = live ? stream.status : task.status;
  const activity = live ? stream.activity : undefined;
  const questions = (stream.questions.length ? stream.questions : task.questions) ?? [];
  const summary = (live ? stream.summary : undefined) || task.summary;
  // Usage (model + tokens + notional cost): prefer freshly-streamed values, else
  // the persisted task fields from the board poll.
  const usageTask: Task = { ...task, costUsd: stream.costUsd ?? task.costUsd, tokens: stream.tokens ?? task.tokens, model: stream.model ?? task.model };

  const [showPrompt, setShowPrompt] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editPrompt, setEditPrompt] = useState(task.promptTemplate);
  const [editTitle, setEditTitle] = useState(task.title ?? task.label);
  const [chaining, setChaining] = useState(false);
  const [focus, setFocus] = useState(false);
  const reader = useReader();
  const hasDownstream = flow.specs.some((s) => (s.dependsOn ?? []).includes(task.stepKey ?? ""));
  const answeredQids = new Set(task.questions.filter((q) => q.answered).map((q) => q.qid));
  const cleanReply = stripMarkers(reply);

  const askCascade = () => hasDownstream && confirm("Re-run downstream steps too? Their {{input}} depends on this step's output.\n\nOK = this step + downstream · Cancel = only this step");

  return (
    <div className={cx("fg-node", `fg-node--${status}`)}>
      <div className="fg-node__head">
        <span className="fg-node__step">{task.stepKey}</span>
        {task.agentName
          ? <span className="tk-agent" style={{ ["--agent-color" as string]: task.agentColor ?? "#8b5cf6", fontSize: 11 }}>{task.agentName}</span>
          : <span className="tk-agent tk-agent--generic" style={{ fontSize: 11 }}>Aria</span>}
        <span className="fg-node__title" title={task.title ?? task.label}>{task.title ?? task.label}</span>
        <span className="aria-head__spacer" />
        <NodeStatus status={status} />
      </div>

      {live && (
        <div className="fg-node__activity"><Loader2 size={10} className="animate-spin" /> {activity ?? (status === "queued" ? "Queued…" : "Working…")}</div>
      )}

      {/* Brief summary — the glanceable gist, so you rarely need to expand */}
      {summary && (
        <div className="fg-node__summary"><Sparkles size={11} className="fg-node__summary-spark" /> <span>{summary}</span></div>
      )}
      {!summary && status === "done" && cleanReply && (
        <div className="fg-node__summary fg-node__summary--pending"><Loader2 size={10} className="animate-spin" /> summarizing…</div>
      )}

      {/* Prompt (collapsible) */}
      <button className="fg-node__toggle" onClick={() => setShowPrompt((v) => !v)}>
        {showPrompt ? <ChevronDown size={11} /> : <ChevronRight size={11} />} Prompt
      </button>
      {showPrompt && (
        editing ? (
          <div className="fg-node__edit">
            <input className="tk-input" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder="Step title" />
            <textarea className="aria-mem__textarea" style={{ minHeight: 90 }} value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} />
            <div className="fg-node__editactions">
              <button className="tk-btn" onClick={() => { setEditing(false); setEditPrompt(task.promptTemplate); setEditTitle(task.title ?? task.label); }}>Cancel</button>
              <button className="tk-btn" onClick={async () => { await onEditRerun(task.id, { prompt: editPrompt, title: editTitle }, false); setEditing(false); }}><Check size={12} /> Save</button>
              <button className="tk-btn tk-btn--primary" onClick={async () => { await onEditRerun(task.id, { prompt: editPrompt, title: editTitle }, askCascade() ? "cascade" : "self"); setEditing(false); }}><RotateCcw size={12} /> Save &amp; re-run</button>
            </div>
          </div>
        ) : (
          <div className="fg-node__prompt">{task.promptTemplate}</div>
        )
      )}

      {toolUses.length > 0 && (
        <div className="fg-node__tools">
          {toolUses.slice(-6).map((n, i) => <span key={i} className="aria-toolchip"><Wrench size={8} /> {n}</span>)}
          {toolUses.length > 6 && <span className="tk-pane__toolmore">+{toolUses.length - 6}</span>}
        </div>
      )}

      {/* Output — short preview; full reading happens in the focus overlay */}
      <div className="fg-node__out">
        {cleanReply
          ? <div className="fg-node__reply">{cleanReply}{status === "running" && <span className="aria-caret" />}</div>
          : status === "error"
            ? <div className="aria-err">{stream.error ?? task.error ?? "Failed"}</div>
            : <div className="fg-node__placeholder">{status === "queued" ? "Waiting for dependencies…" : "Thinking…"}</div>}
      </div>
      {cleanReply.length > 140 && (
        <button className="fg-node__more" onClick={() => setFocus(true)}><Maximize2 size={11} /> Expand to read</button>
      )}

      {/* Questions (never-block) */}
      {questions.filter((q) => !answeredQids.has(q.qid)).map((q) => (
        <QuestionRow key={q.qid} taskId={task.id} q={q} onAnswer={onAnswer} />
      ))}

      {/* Footer actions */}
      <div className="fg-node__foot">
        {status !== "running" && <UsageChip task={usageTask} />}
        <span className="aria-head__spacer" />
        {cleanReply && <ReaderControls reader={reader} text={cleanReply} compact />}
        {cleanReply && <button className="fg-node__act" onClick={() => setFocus(true)} title="Expand to read"><Maximize2 size={11} /></button>}
        {live && status === "running" && <button className="fg-node__act" onClick={onStop} title="Stop step"><Square size={10} fill="currentColor" /></button>}
        {!editing && <button className="fg-node__act" onClick={() => { setShowPrompt(true); setEditing(true); }} title="Edit prompt"><Pencil size={11} /></button>}
        {!live && <button className="fg-node__act" onClick={async () => { await onEditRerun(task.id, null, askCascade() ? "cascade" : "self"); }} title="Re-run step"><RotateCcw size={11} /></button>}
        <button className="fg-node__act" onClick={() => setChaining((v) => !v)} title="Chain a step after this one"><GitBranch size={11} /></button>
      </div>

      {chaining && (
        <ChainComposer agents={agents} onCancel={() => setChaining(false)} onSubmit={async (prompt, agentId) => { await onChain(task.id, prompt, agentId); setChaining(false); }} />
      )}

      {focus && (
        <FocusOverlay
          task={task} status={status} summary={summary} reply={cleanReply} prompt={task.promptTemplate}
          onClose={() => setFocus(false)}
        />
      )}
    </div>
  );
}

// Audio reader controls (play/pause/stop) wired to /api/speak with browser fallback.
function ReaderControls({ reader, text, compact }: { reader: ReturnType<typeof useReader>; text: string; compact?: boolean }) {
  const { status, play, pause, resume, stop } = reader;
  const idle = status === "idle";
  return (
    <span className={cx("fg-reader", compact && "fg-reader--compact")}>
      {idle && <button className="fg-node__act" onClick={() => void play(text)} title="Read aloud"><Volume2 size={12} /></button>}
      {status === "loading" && <span className="fg-node__act"><Loader2 size={11} className="animate-spin" /></span>}
      {status === "playing" && <button className="fg-node__act fg-node__act--on" onClick={pause} title="Pause"><Pause size={11} /></button>}
      {status === "paused" && <button className="fg-node__act fg-node__act--on" onClick={resume} title="Resume"><Play size={11} fill="currentColor" /></button>}
      {!idle && status !== "loading" && <button className="fg-node__act" onClick={stop} title="Stop"><Square size={9} fill="currentColor" /></button>}
    </span>
  );
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// Compact token count: 1234 → "1.2k", 1500000 → "1.5M".
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

// Usage chip: shows the model + total token throughput for a run. We lead with
// TOKENS (not dollars) because the app runs on a Claude SUBSCRIPTION — the $ is
// a notional CLI estimate, not money billed, so it lives only in the tooltip.
function UsageChip({ task }: { task: Task }) {
  const tk = task.tokens;
  if (!tk && task.costUsd == null) return null;
  const billable = tk ? tk.input + tk.output : 0;           // fresh tokens (cache reads are ~free)
  const total = tk ? billable + tk.cacheRead + tk.cacheWrite : 0;
  const title = [
    task.model ? `Model: ${modelLabel(task.model)}` : null,
    tk ? `Input: ${tk.input.toLocaleString()} · Output: ${tk.output.toLocaleString()}` : null,
    tk ? `Cache read: ${tk.cacheRead.toLocaleString()} · Cache write: ${tk.cacheWrite.toLocaleString()}` : null,
    tk ? `Total context: ${total.toLocaleString()} tokens` : null,
    task.costUsd != null ? `Notional CLI estimate: $${task.costUsd.toFixed(4)} (NOT billed — runs on your Claude subscription)` : null,
  ].filter(Boolean).join("\n");
  return (
    <span className="fg-node__usage" title={title}>
      {task.model && <span className="fg-node__usage-model">{modelLabel(task.model)}</span>}
      {tk
        ? <span className="fg-node__usage-tok">{fmtTokens(billable)} tok</span>
        : task.costUsd != null && <span className="fg-node__usage-tok">~${task.costUsd.toFixed(2)}</span>}
    </span>
  );
}

// Full playback bar — appears once audio is streaming. Shows transport,
// elapsed/total time, a seekable scrubber, and a "buffering" hint while later
// sentences are still being generated.
function ReaderBar({ reader, text }: { reader: ReturnType<typeof useReader>; text: string }) {
  const { status, currentTime, duration, buffering, play, pause, resume, stop, seek } = reader;
  const active = status === "playing" || status === "paused" || status === "loading";
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  if (!active) {
    return (
      <button className="fg-bar__listen" onClick={() => void play(text)} title="Read this step aloud">
        <Volume2 size={13} /> Listen
      </button>
    );
  }
  return (
    <div className="fg-bar">
      {status === "loading"
        ? <span className="fg-bar__btn"><Loader2 size={13} className="animate-spin" /></span>
        : status === "playing"
          ? <button className="fg-bar__btn fg-bar__btn--on" onClick={pause} title="Pause"><Pause size={13} /></button>
          : <button className="fg-bar__btn fg-bar__btn--on" onClick={resume} title="Resume"><Play size={13} fill="currentColor" /></button>}
      <span className="fg-bar__time">{fmtTime(currentTime)}</span>
      <input
        className="fg-bar__seek"
        type="range" min={0} max={Math.max(duration, 0.1)} step={0.1}
        value={Math.min(currentTime, duration)}
        onChange={(e) => seek(parseFloat(e.target.value))}
        style={{ ["--pct" as string]: `${pct}%` }}
        disabled={duration === 0}
        aria-label="Seek"
      />
      <span className="fg-bar__time fg-bar__time--total">
        {fmtTime(duration)}{buffering && <span className="fg-bar__buf" title="Still generating audio">…</span>}
      </span>
      <button className="fg-bar__btn" onClick={stop} title="Stop"><Square size={10} fill="currentColor" /></button>
    </div>
  );
}

// Wide focus overlay for comfortable reading of a node's full output.
function FocusOverlay({ task, status, summary, reply, prompt, onClose }: {
  task: Task; status: Task["status"]; summary?: string; reply: string; prompt: string; onClose: () => void;
}) {
  const reader = useReader();
  const [showPrompt, setShowPrompt] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, [onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="aria-portal" style={{ zIndex: 90 }}>
      <div className="aria-backdrop" onClick={onClose} aria-hidden />
      <div className="fg-focus" role="dialog" aria-label={task.title ?? task.label}>
        <div className="fg-focus__head">
          <span className="fg-node__step">{task.stepKey}</span>
          {task.agentName
            ? <span className="tk-agent" style={{ ["--agent-color" as string]: task.agentColor ?? "#8b5cf6", fontSize: 12 }}>{task.agentName}</span>
            : <span className="tk-agent tk-agent--generic" style={{ fontSize: 12 }}>Aria</span>}
          <span className="fg-focus__title">{task.title ?? task.label}</span>
          <NodeStatus status={status} />
          <span className="aria-head__spacer" />
          <button className="aria-iconbtn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        {reply && <div className="fg-focus__bar"><ReaderBar reader={reader} text={reply} /></div>}
        {summary && <div className="fg-focus__summary"><Sparkles size={13} className="fg-node__summary-spark" /> {summary}</div>}
        <div className="fg-focus__body">
          <button className="fg-node__toggle" onClick={() => setShowPrompt((v) => !v)} style={{ marginBottom: 8 }}>
            {showPrompt ? <ChevronDown size={11} /> : <ChevronRight size={11} />} Prompt
          </button>
          {showPrompt && <div className="fg-node__prompt" style={{ maxHeight: "none", marginBottom: 14 }}>{prompt}</div>}
          <div className="fg-focus__reply">
            {reply
              ? (status === "running"
                  ? <>{reply}<span className="aria-caret" /></>   // streaming: raw text + caret, markdown would re-layout every chunk
                  : <Markdown>{reply}</Markdown>)
              : "No output yet."}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function NodeStatus({ status }: { status: Task["status"] }) {
  const m = {
    queued: { icon: <Clock size={10} />, cls: "queued" },
    running: { icon: <CircleDot size={10} />, cls: "running" },
    done: { icon: <CheckCircle2 size={10} />, cls: "done" },
    error: { icon: <XCircle size={10} />, cls: "error" },
    stopped: { icon: <Square size={9} fill="currentColor" />, cls: "stopped" },
  }[status];
  return <span className={cx("tk-badge", `tk-badge--${m.cls}`)} style={{ fontSize: 9.5 }}>{m.icon} {status}</span>;
}

function stripMarkers(text: string) {
  return text.replace(/\[\[\s*ASK\b[^\]]*\]\]/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}

function QuestionRow({ taskId, q, onAnswer }: { taskId: string; q: { qid: string; question: string; assumed: string }; onAnswer: (taskId: string, qid: string, answer: string) => Promise<void> }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (val: string) => {
    if (!val.trim() || busy) return;
    setBusy(true); setErr(null);
    try { await onAnswer(taskId, q.qid, val.trim()); setSent(val.trim()); }
    catch (e) { setErr(e instanceof Error ? e.message : "Failed to apply answer."); }
    finally { setBusy(false); }
  };
  if (sent) {
    return <div className="tk-q tk-q--answered" style={{ margin: "8px 0 0" }}><Check size={11} /> {q.question} → <b>{sent}</b> <span className="tk-q__meta">(refining…)</span></div>;
  }
  return (
    <div className="tk-q" style={{ margin: "8px 0 0" }}>
      <div className="tk-q__head"><HelpCircle size={11} /> {q.question}</div>
      <div className="tk-q__assumed">Assumed: <b>{q.assumed}</b></div>
      <div className="tk-q__row">
        <input className="tk-input" placeholder="Correct or confirm…" value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void submit(answer); }} />
        <button className="tk-btn" onClick={() => void submit(q.assumed)} disabled={busy}>{busy ? <Loader2 size={11} className="animate-spin" /> : "Confirm"}</button>
        <button className="tk-btn tk-btn--primary" onClick={() => void submit(answer)} disabled={!answer.trim() || busy}>Apply</button>
      </div>
      {err && <div className="tk-q__err">{err}</div>}
    </div>
  );
}

function ChainComposer({ agents, onCancel, onSubmit }: { agents: Agent[]; onCancel: () => void; onSubmit: (prompt: string, agentId?: string) => Promise<void> }) {
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="tk-chaincompose" style={{ margin: "8px 0 0" }}>
      <div className="aria-proj" style={{ height: 28 }}>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">No agent — plain Aria</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <textarea className="aria-mem__textarea" style={{ minHeight: 54 }} placeholder="Next step… this step's output is {{input}}" value={prompt} onChange={(e) => setPrompt(e.target.value)} autoFocus />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
        <button className="tk-btn" onClick={onCancel}>Cancel</button>
        <button className="tk-btn tk-btn--primary" disabled={!prompt.trim() || busy} onClick={async () => { setBusy(true); try { await onSubmit(prompt, agentId || undefined); } finally { setBusy(false); } }}><GitBranch size={12} /> Chain</button>
      </div>
    </div>
  );
}
