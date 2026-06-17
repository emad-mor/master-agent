"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Sparkles, Plus, Users, GitBranch, Square, Trash2, Loader2, RefreshCw, X, ArrowLeft,
  Wrench, CircleDot, CheckCircle2, XCircle, Clock, Wand2, Pencil, Check, KeyRound,
  ArrowRight, HelpCircle, Info, Paperclip, FileText, Cpu, Bot,
} from "lucide-react";
import { cx } from "@/lib/format";
import { useDialogs } from "@/components/ui/dialogs";
import { useTaskStream, type TaskView } from "./use-task-stream";
import { FlowGraph } from "./flow-graph";
import { MODELS, modelLabel, DEFAULT_AGENT_MODEL } from "@/lib/models";
import "../persona/companion.css";
import "./tasks.css";

const WORKSPACE_KEY = "__workspace__";

// Compact token count: 1234 → "1.2k", 1500000 → "1.5M".
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

type Project = { slug: string; name: string; path: string };
type Integration = { name: string; envVar: string };
type Agent = { id: string; name: string; instructions: string; model?: string; color: string; canDelegate: boolean; skillIds: string[]; integrations: Integration[] };
type Skill = { id: string; name: string; summary: string; category: string; brief: string; source: string; custom?: boolean; fileName?: string };
type RedactedCred = { envVar: string; preview: string; set: boolean };
type Task = {
  id: string; flowId?: string; stepKey?: string; label: string;
  project: string; projectName: string;
  agentId?: string; agentName?: string; agentColor?: string;
  title?: string; promptTemplate: string;
  prompt: string; status: "queued" | "running" | "done" | "error" | "stopped";
  reply: string; toolUses: string[]; activity?: string;
  dependsOn: string[]; parentTaskId?: string;
  questions: { qid: string; question: string; assumed: string; answered?: string; resolvedByTaskId?: string }[];
  createdAt: number; startedAt?: number; finishedAt?: number; costUsd?: number; tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number }; model?: string; error?: string;
};
type FlowSpec = { key: string; agentId?: string; title?: string; prompt: string; dependsOn?: string[] };
type Flow = { id: string; name: string; project: string; createdAt: number; steps: { key: string; taskId: string }[]; specs: FlowSpec[]; rootInput?: string; paused: boolean };
type FlowTemplate = { id: string; name: string; description: string; category: string; builtin: boolean; steps: { key: string; agentRole?: string; title: string; prompt: string; dependsOn: string[] }[] };

export function TasksDashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<string>(WORKSPACE_KEY);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [placeholders, setPlaceholders] = useState<Integration[]>([]);
  const [templates, setTemplates] = useState<FlowTemplate[]>([]);
  const [panel, setPanel] = useState<null | "agents" | "newtask" | "flow">(null);
  const [loaded, setLoaded] = useState(false);   // first /api/tasks fetch resolved
  const { prompt: askPrompt, alert: notify, dialog: dialogNode } = useDialogs();

  const projectName = project === WORKSPACE_KEY ? "All projects" : projects.find((p) => p.slug === project)?.name ?? project;

  const loadProjects = useCallback(async () => {
    try { const r = await fetch("/api/projects", { cache: "no-store" }); if (r.ok) setProjects((await r.json()).projects ?? []); } catch {}
  }, []);
  const loadAgents = useCallback(async () => {
    try { const r = await fetch("/api/agents", { cache: "no-store" }); if (r.ok) { const d = await r.json(); setAgents(d.agents ?? []); setPlaceholders(d.integrationPlaceholders ?? []); } } catch {}
  }, []);
  const loadSkills = useCallback(async () => {
    try { const r = await fetch("/api/skills", { cache: "no-store" }); if (r.ok) setSkills((await r.json()).skills ?? []); } catch {}
  }, []);
  const loadTemplates = useCallback(async () => {
    try { const r = await fetch("/api/flow-templates", { cache: "no-store" }); if (r.ok) setTemplates((await r.json()).templates ?? []); } catch {}
  }, []);
  const loadTasks = useCallback(async () => {
    try {
      const r = await fetch(`/api/tasks?project=${encodeURIComponent(project)}`, { cache: "no-store" });
      if (r.ok) { const d = await r.json(); setTasks(d.tasks ?? []); setFlows(d.flows ?? []); }
    } catch {}
    finally { setLoaded(true); }
  }, [project]);

  useEffect(() => { void loadProjects(); void loadAgents(); void loadSkills(); void loadTemplates(); }, [loadProjects, loadAgents, loadSkills, loadTemplates]);
  useEffect(() => { setLoaded(false); void loadTasks(); }, [loadTasks]);

  // Poll the board while anything is live (status/activity changes that aren't
  // on a stream we're subscribed to still need to surface on the cards).
  const anyLive = tasks.some((t) => t.status === "running" || t.status === "queued");
  useEffect(() => {
    const id = setInterval(() => void loadTasks(), anyLive ? 1500 : 6000);
    return () => clearInterval(id);
  }, [anyLive, loadTasks]);

  const stopTask = useCallback(async (id: string) => {
    await fetch(`/api/tasks/${id}/stop`, { method: "POST" });
    void loadTasks();
  }, [loadTasks]);

  const clearFinished = useCallback(async () => {
    await fetch(`/api/tasks?project=${encodeURIComponent(project)}&finished=1`, { method: "DELETE" });
    void loadTasks();
  }, [project, loadTasks]);

  // Partition: tasks that belong to a flow (rendered as lanes) vs standalone.
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const flowTaskIds = new Set(flows.flatMap((f) => f.steps.map((s) => s.taskId)));
  const standalone = tasks.filter((t) => !t.flowId && !flowTaskIds.has(t.id));
  const standaloneRunning = standalone.filter((t) => t.status === "running" || t.status === "queued");
  const standaloneFinished = standalone.filter((t) => ["done", "error", "stopped"].includes(t.status));
  // Flows ordered: any with a live step first, then most-recent.
  const orderedFlows = [...flows].sort((a, b) => {
    const liveA = a.steps.some((s) => { const t = byId.get(s.taskId); return t && (t.status === "running" || t.status === "queued"); });
    const liveB = b.steps.some((s) => { const t = byId.get(s.taskId); return t && (t.status === "running" || t.status === "queued"); });
    if (liveA !== liveB) return liveA ? -1 : 1;
    return b.createdAt - a.createdAt;
  });

  const chainTask = async (sourceId: string, prompt: string, agentId?: string) => {
    await fetch(`/api/tasks/${sourceId}/chain`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, agentId: agentId || undefined }) });
    void loadTasks();
  };
  const answerQuestion = async (taskId: string, qid: string, answer: string) => {
    const r = await fetch(`/api/tasks/${taskId}/answer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ qid, answer }) });
    if (!r.ok) {
      const body = await r.json().catch(() => null) as { error?: string } | null;
      // Surface the failure instead of silently swallowing it (a 404 here means
      // the task/question was cleared — the user needs to know the answer didn't land).
      throw new Error(body?.error ?? `Couldn't apply answer (HTTP ${r.status}).`);
    }
    void loadTasks();
  };
  const controlFlow = async (flowId: string, action: "play" | "pause" | "stop") => {
    await fetch(`/api/flows/${flowId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
    void loadTasks();
  };
  const editRerun = async (taskId: string, edit: { prompt?: string; title?: string } | null, rerun: false | "self" | "cascade") => {
    if (edit) await fetch(`/api/tasks/${taskId}/edit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(edit) });
    if (rerun) await fetch(`/api/tasks/${taskId}/rerun`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cascade: rerun === "cascade" }) });
    void loadTasks();
  };
  const saveAsTemplate = async (flow: Flow) => {
    const name = await askPrompt({
      icon: <GitBranch size={18} style={{ color: "#c79bff", flexShrink: 0 }} />,
      title: "Save flow as template",
      body: <>Reuse this flow&apos;s steps and structure to start new flows later.</>,
      inputLabel: "Template name",
      initialValue: flow.name,
      placeholder: "Template name",
      confirmLabel: "Save template",
      confirmIcon: <Check size={13} />,
    });
    if (!name) return;
    const steps = flow.specs.map((s) => ({
      key: s.key,
      agentRole: s.agentId ? agents.find((a) => a.id === s.agentId)?.name : undefined,
      title: s.title || `Step ${s.key}`,
      prompt: s.prompt,
      dependsOn: s.dependsOn ?? [],
    }));
    await fetch("/api/flow-templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, description: "", steps }) });
    await loadTemplates();
    await notify({ icon: <Check size={18} style={{ color: "#7ee0a8", flexShrink: 0 }} />, title: "Template saved", body: <>Saved <b>{name}</b> as a reusable template.</> });
  };

  return (
    <div className="tk-root">
      {/* ambient mist */}
      <div className="tk-mist" aria-hidden>
        <div className="aria-blob aria-blob--indigo" />
        <div className="aria-blob aria-blob--violet" />
        <div className="aria-blob aria-blob--azure" />
        <div className="aria-blob aria-blob--magenta" />
      </div>

      {/* top bar */}
      <header className="tk-top">
        <Link href="/" className="tk-back" title="Back to Daryan"><ArrowLeft size={16} /></Link>
        <span className="aria-head__spark" style={{ width: 32, height: 32 }}><Sparkles size={16} /></span>
        <div className="tk-title">
          <div className="tk-title__main">Mission Control</div>
          <div className="tk-title__sub">parallel tasks · named agents · flows</div>
        </div>
        <span className="aria-head__spacer" />

        <div className="aria-proj" style={{ maxWidth: 240 }}>
          <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
            <option value={WORKSPACE_KEY}>All projects (workspace)</option>
            {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
          </select>
        </div>
        <button className="tk-btn" onClick={() => setPanel("agents")}><Users size={15} /> Agents <span className="tk-pill">{agents.length}</span></button>
        <button className="tk-btn" onClick={() => setPanel("newtask")}><Plus size={15} /> New task</button>
        <button className="tk-btn tk-btn--primary" onClick={() => setPanel("flow")}><GitBranch size={15} /> New flow</button>
        <button className="aria-iconbtn" onClick={() => void loadTasks()} title="Refresh"><RefreshCw size={15} /></button>
      </header>

      {/* split-pane grid of live + recent tasks */}
      <div className="tk-body">
        {!loaded ? (
          <TasksSkeleton />
        ) : tasks.length === 0 ? (
          <div className="tk-empty">
            <Sparkles size={28} style={{ opacity: 0.5 }} />
            <div className="tk-empty__title">No tasks yet</div>
            <div className="tk-empty__hint">
              Start a single task, or build a multi-agent flow where one agent&apos;s output feeds the next.
              Everything runs in parallel and streams live here.
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <button className="tk-btn tk-btn--primary" onClick={() => setPanel("flow")}><GitBranch size={15} /> New flow</button>
              <button className="tk-btn" onClick={() => setPanel("newtask")}><Plus size={15} /> New task</button>
            </div>
          </div>
        ) : (
          <>
            {/* Flows render as node-graph canvases */}
            {orderedFlows.length > 0 && (
              <>
                <div className="tk-section"><GitBranch size={13} /> Flows <span className="tk-pill">{orderedFlows.length}</span> <span className="tk-section__hint">chained steps — each feeds the next</span></div>
                {orderedFlows.map((f) => (
                  <FlowGraph
                    key={f.id} flow={f} byId={byId} agents={agents}
                    onControl={controlFlow} onStop={stopTask} onChain={chainTask} onAnswer={answerQuestion}
                    onEditRerun={editRerun} onSaveTemplate={saveAsTemplate}
                  />
                ))}
              </>
            )}

            {/* Standalone tasks in the parallel grid */}
            {standaloneRunning.length > 0 && (
              <>
                <div className="tk-section" style={{ marginTop: orderedFlows.length ? 22 : 0 }}>Live <span className="tk-pill">{standaloneRunning.length}</span> <span className="tk-section__hint">running in parallel</span></div>
                <div className="tk-grid">
                  {standaloneRunning.map((t) => <TaskPane key={t.id} task={t} live agents={agents} onStop={() => stopTask(t.id)} onChain={chainTask} onAnswer={answerQuestion} />)}
                </div>
              </>
            )}
            {standaloneFinished.length > 0 && (
              <>
                <div className="tk-section" style={{ marginTop: (orderedFlows.length || standaloneRunning.length) ? 22 : 0 }}>
                  Finished <span className="tk-pill">{standaloneFinished.length}</span>
                  <button className="tk-section__action" onClick={clearFinished}><Trash2 size={12} /> Clear</button>
                </div>
                <div className="tk-grid">
                  {standaloneFinished.map((t) => <TaskPane key={t.id} task={t} live={false} agents={agents} onChain={chainTask} onAnswer={answerQuestion} />)}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {panel === "agents" && <AgentsPanel agents={agents} skills={skills} placeholders={placeholders} onClose={() => setPanel(null)} reload={loadAgents} reloadSkills={loadSkills} />}
      {panel === "newtask" && <NewTaskPanel agents={agents} project={project} projectName={projectName} onClose={() => setPanel(null)} onStarted={() => { setPanel(null); void loadTasks(); }} />}
      {panel === "flow" && <FlowPanel agents={agents} templates={templates} project={project} onClose={() => setPanel(null)} onStarted={() => { setPanel(null); void loadTasks(); }} />}
      {dialogNode}
    </div>
  );
}

// ── First-load skeleton — shimmer placeholders so the board doesn't flash an
//    empty "No tasks yet" state before the first fetch resolves. ──
function TasksSkeleton() {
  return (
    <div className="tk-skel" aria-hidden>
      <div className="tk-skel__section"><span className="tk-skel__line tk-skel__line--sm" /></div>
      <div className="tk-skel__flow">
        <div className="tk-skel__row">
          {[0, 1, 2].map((i) => (
            <div className="tk-skel__card" key={i}>
              <div className="tk-skel__line tk-skel__line--head" />
              <div className="tk-skel__line" />
              <div className="tk-skel__line tk-skel__line--lg" />
              <div className="tk-skel__line tk-skel__line--md" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── One task pane: a live (or static) streaming card ──
function TaskPane({ task, live, agents, onStop, onChain, onAnswer }: {
  task: Task; live: boolean; agents: Agent[];
  onStop?: () => void;
  onChain: (sourceId: string, prompt: string, agentId?: string) => Promise<void>;
  onAnswer: (taskId: string, qid: string, answer: string) => Promise<void>;
}) {
  const stream = useTaskStream(task.id, live);
  const questions = (stream.questions.length ? stream.questions : task.questions) ?? [];
  const view: TaskView = live
    ? { ...stream, reply: stream.reply || task.reply, toolUses: stream.toolUses.length ? stream.toolUses : task.toolUses, status: stream.status, questions }
    : { reply: task.reply, toolUses: task.toolUses, status: task.status, costUsd: task.costUsd, tokens: task.tokens, model: task.model, questions };

  const [, force] = useState(0);
  useEffect(() => { if (!live) return; const id = setInterval(() => force((n) => n + 1), 1000); return () => clearInterval(id); }, [live]);
  const elapsed = task.startedAt ? Math.floor(((task.finishedAt ?? Date.now()) - task.startedAt) / 1000) : 0;
  const elapsedLabel = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s` : `${elapsed}s`;

  const [chaining, setChaining] = useState(false);
  // Persisted-answer map so a question pane collapses once answered (server side).
  const answeredQids = new Set(task.questions.filter((q) => q.answered).map((q) => q.qid));

  return (
    <div className={cx("tk-pane", `tk-pane--${view.status}`)}>
      <div className="tk-pane__head">
        {task.agentName ? (
          <span className="tk-agent" style={{ ["--agent-color" as string]: task.agentColor ?? "#8b5cf6" }}>{task.agentName}</span>
        ) : (
          <span className="tk-agent tk-agent--generic">Daryan</span>
        )}
        {task.stepKey && <span className="tk-step">step {task.stepKey}</span>}
        <span className="tk-pane__label" title={task.prompt}>{task.label}</span>
        <span className="aria-head__spacer" />
        <StatusBadge status={view.status} />
        <span className="tk-pane__time">{elapsedLabel}</span>
        {live && (view.status === "running" || view.status === "queued") && onStop && (
          <button className="tk-pane__stop" onClick={onStop} title="Stop"><Square size={11} fill="currentColor" /></button>
        )}
      </div>

      {(view.status === "running" || view.status === "queued") && (
        <div className="tk-pane__activity">
          <Loader2 size={11} className="animate-spin" />
          {view.activity ?? (view.status === "queued" ? "Queued — waiting for a slot/dependency…" : "Working…")}
        </div>
      )}

      {view.toolUses.length > 0 && (
        <div className="tk-pane__tools">
          {view.toolUses.slice(-8).map((n, i) => <span key={i} className="aria-toolchip"><Wrench size={9} /> {n}</span>)}
          {view.toolUses.length > 8 && <span className="tk-pane__toolmore">+{view.toolUses.length - 8}</span>}
        </div>
      )}

      <div className="tk-pane__body">
        {view.reply
          ? <div className="tk-pane__reply">{stripMarkers(view.reply)}{view.status === "running" && <span className="aria-caret" />}</div>
          : view.status === "error"
            ? <div className="aria-err">{view.error ?? task.prompt}</div>
            : <div className="tk-pane__placeholder">{view.status === "queued" ? "Waiting to start…" : "Thinking…"}</div>}
      </div>

      {/* Questions the agent answered itself — refine without ever having blocked */}
      {view.questions.filter((q) => !answeredQids.has(q.qid)).map((q) => (
        <QuestionRow key={q.qid} taskId={task.id} q={q} onAnswer={onAnswer} />
      ))}
      {task.questions.filter((q) => q.answered).map((q) => (
        <div key={q.qid} className="tk-q tk-q--answered"><Check size={11} /> {q.question} → <b>{q.answered}</b> <span className="tk-q__meta">(refining…)</span></div>
      ))}

      {(view.tokens || view.costUsd != null) && view.status !== "running" && (
        <div className="tk-pane__foot" title={[
          view.model ? `Model: ${modelLabel(view.model)}` : null,
          view.tokens ? `Input ${view.tokens.input.toLocaleString()} · Output ${view.tokens.output.toLocaleString()} · Cache read ${view.tokens.cacheRead.toLocaleString()}` : null,
          view.costUsd != null ? `Notional CLI estimate $${view.costUsd.toFixed(4)} — NOT billed (runs on your Claude subscription).` : null,
        ].filter(Boolean).join("\n")}>
          {view.model && <span className="tk-pane__model">{modelLabel(view.model)}</span>}
          {view.tokens && <span>{fmtTokens(view.tokens.input + view.tokens.output)} tok</span>}
        </div>
      )}

      {/* Chain next — turns any task into a flow; source reply wired as {{input}} */}
      {!chaining ? (
        <button className="tk-chainbtn" onClick={() => setChaining(true)} title="Chain a new step onto this task">
          <GitBranch size={12} /> Chain next
        </button>
      ) : (
        <ChainComposer agents={agents} onCancel={() => setChaining(false)} onSubmit={async (prompt, agentId) => { await onChain(task.id, prompt, agentId); setChaining(false); }} />
      )}
    </div>
  );
}

// Hide the [[ASK ...]] markers from the human-readable reply (they're surfaced
// as proper question rows instead).
function stripMarkers(text: string) {
  return text.replace(/\[\[\s*ASK\b[^\]]*\]\]/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}

function QuestionRow({ taskId, q, onAnswer }: { taskId: string; q: { qid: string; question: string; assumed: string }; onAnswer: (taskId: string, qid: string, answer: string) => Promise<void>; }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);   // optimistic: what we submitted
  const [err, setErr] = useState<string | null>(null);
  const submit = async (val: string) => {
    if (!val.trim() || busy) return;
    setBusy(true); setErr(null);
    try { await onAnswer(taskId, q.qid, val.trim()); setSent(val.trim()); }
    catch (e) { setErr(e instanceof Error ? e.message : "Failed to apply answer."); }
    finally { setBusy(false); }
  };
  // Collapse to a confirmed state the instant the POST succeeds, so the chain
  // visibly reacts without waiting for the next poll (which can lag or race).
  if (sent) {
    return <div className="tk-q tk-q--answered"><Check size={11} /> {q.question} → <b>{sent}</b> <span className="tk-q__meta">(refining…)</span></div>;
  }
  return (
    <div className="tk-q">
      <div className="tk-q__head"><HelpCircle size={12} /> {q.question}</div>
      <div className="tk-q__assumed">Proceeded assuming: <b>{q.assumed}</b></div>
      <div className="tk-q__row">
        <input className="tk-input" placeholder="Correct it (or confirm)…" value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void submit(answer); }} />
        <button className="tk-btn" onClick={() => void submit(q.assumed)} disabled={busy} title="Confirm the assumption">{busy ? <Loader2 size={12} className="animate-spin" /> : "Confirm"}</button>
        <button className="tk-btn tk-btn--primary" onClick={() => void submit(answer)} disabled={!answer.trim() || busy}>Apply</button>
      </div>
      {err && <div className="tk-q__err">{err}</div>}
    </div>
  );
}

function ChainComposer({ agents, onCancel, onSubmit }: { agents: Agent[]; onCancel: () => void; onSubmit: (prompt: string, agentId?: string) => Promise<void>; }) {
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="tk-chaincompose">
      <div className="aria-proj" style={{ height: 30 }}>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">No agent — plain Daryan</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <textarea className="aria-mem__textarea" style={{ minHeight: 60 }} placeholder="Next step… this task's output is available as {{input}}" value={prompt} onChange={(e) => setPrompt(e.target.value)} autoFocus />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
        <button className="tk-btn" onClick={onCancel}>Cancel</button>
        <button className="tk-btn tk-btn--primary" disabled={!prompt.trim() || busy} onClick={async () => { setBusy(true); try { await onSubmit(prompt, agentId || undefined); } finally { setBusy(false); } }}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <GitBranch size={13} />} Chain
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: TaskView["status"] }) {
  const map = {
    queued: { icon: <Clock size={11} />, label: "queued", cls: "queued" },
    running: { icon: <CircleDot size={11} />, label: "running", cls: "running" },
    done: { icon: <CheckCircle2 size={11} />, label: "done", cls: "done" },
    error: { icon: <XCircle size={11} />, label: "error", cls: "error" },
    stopped: { icon: <Square size={10} fill="currentColor" />, label: "stopped", cls: "stopped" },
  }[status];
  return <span className={cx("tk-badge", `tk-badge--${map.cls}`)}>{map.icon} {map.label}</span>;
}

// ── Agents manager panel ──
function AgentsPanel({ agents, skills, placeholders, onClose, reload, reloadSkills }: { agents: Agent[]; skills: Skill[]; placeholders: Integration[]; onClose: () => void; reload: () => Promise<void>; reloadSkills: () => Promise<void> }) {
  const [editing, setEditing] = useState<Agent | "new" | null>(null);
  const skillName = (id: string) => skills.find((s) => s.id === id)?.name ?? id;
  const { confirm: askConfirm, dialog: dialogNode } = useDialogs();
  return (
    <>
    <SlideOver title="Agents" subtitle="Reusable roles with skills + integrations you can assign to tasks and flow steps" onClose={onClose} icon={<Users size={16} />} wide>
      {editing ? (
        <AgentEditor
          agent={editing === "new" ? null : editing}
          skills={skills}
          placeholders={placeholders}
          onCancel={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await reload(); }}
          reloadSkills={reloadSkills}
        />
      ) : (
        <>
          <button className="tk-btn tk-btn--primary" style={{ alignSelf: "flex-start" }} onClick={() => setEditing("new")}><Plus size={14} /> New agent</button>
          {agents.map((a) => (
            <div key={a.id} className="tk-card tk-agentrow">
              <span className="tk-dot" style={{ background: a.color }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="tk-agentrow__name">{a.name}{a.canDelegate && <span className="tk-tag">can delegate</span>}{a.model && <span className="tk-tag tk-tag--mono">{a.model}</span>}</div>
                <div className="tk-agentrow__inst">{a.instructions}</div>
                {(a.skillIds.length > 0 || a.integrations.length > 0) && (
                  <div className="tk-agentrow__meta">
                    {a.skillIds.map((id) => {
                      const sk = skills.find((s) => s.id === id);
                      return <span key={id} className="tk-chiplet tk-chiplet--skill" title={sk ? `${sk.summary}\nGrounded in: ${sk.source}` : undefined}><Wand2 size={9} /> {skillName(id)}</span>;
                    })}
                    {a.integrations.map((i) => <span key={i.envVar} className="tk-chiplet tk-chiplet--int"><KeyRound size={9} /> {i.name}</span>)}
                  </div>
                )}
              </div>
              <button className="aria-mem__act" onClick={() => setEditing(a)} title={`Edit "${a.name}"`}><Pencil size={13} /></button>
              <button className="aria-mem__act aria-mem__act--danger" title={`Delete agent "${a.name}"`} onClick={async () => {
                const ok = await askConfirm({
                  tone: "danger",
                  icon: <Trash2 size={18} style={{ color: "#ff6b6b", flexShrink: 0 }} />,
                  title: `Delete "${a.name}"?`,
                  body: <>This removes the agent and its saved credentials. Tasks and flow steps that used it fall back to default Daryan.</>,
                  confirmLabel: "Delete agent",
                  confirmIcon: <Trash2 size={13} />,
                });
                if (!ok) return;
                await fetch(`/api/agents?id=${a.id}`, { method: "DELETE" });
                await reload();
              }}><Trash2 size={13} /></button>
            </div>
          ))}
        </>
      )}
    </SlideOver>
    {dialogNode}
    </>
  );
}

function AgentEditor({ agent, skills, placeholders, onCancel, onSaved, reloadSkills }: { agent: Agent | null; skills: Skill[]; placeholders: Integration[]; onCancel: () => void; onSaved: () => Promise<void>; reloadSkills: () => Promise<void> }) {
  const [name, setName] = useState(agent?.name ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  // New agents (and existing ones with no model saved) default to Opus — not
  // "let the CLI choose". Saving persists the preselected model.
  const [model, setModel] = useState(agent?.model || DEFAULT_AGENT_MODEL);
  const [canDelegate, setCanDelegate] = useState(agent?.canDelegate ?? false);
  const [skillIds, setSkillIds] = useState<string[]>(agent?.skillIds ?? []);
  const [integrations, setIntegrations] = useState<Integration[]>(agent?.integrations ?? []);
  const [saving, setSaving] = useState(false);
  const [viewSkillId, setViewSkillId] = useState<string | null>(null);   // skill being read (modal)
  const [creatingSkill, setCreatingSkill] = useState(false);             // custom-skill form (modal)
  const viewSkill = viewSkillId ? skills.find((s) => s.id === viewSkillId) ?? null : null;
  const { confirm: askConfirm, dialog: dialogNode } = useDialogs();

  const toggleSkill = (id: string) => setSkillIds((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  const hasIntegration = (envVar: string) => integrations.some((i) => i.envVar === envVar);
  const toggleIntegration = (intg: Integration) => setIntegrations((list) => hasIntegration(intg.envVar) ? list.filter((i) => i.envVar !== intg.envVar) : [...list, intg]);
  const addCustomIntegration = (nm: string, envVar: string) => { if (nm.trim() && envVar.trim() && !hasIntegration(envVar.trim())) setIntegrations((l) => [...l, { name: nm.trim(), envVar: envVar.trim() }]); };

  // Group skills by category for the picker.
  const byCat = useMemo(() => {
    const m = new Map<string, Skill[]>();
    for (const s of skills) { if (!m.has(s.category)) m.set(s.category, []); m.get(s.category)!.push(s); }
    return [...m.entries()];
  }, [skills]);

  const save = async () => {
    if (!name.trim() || !instructions.trim()) return;
    setSaving(true);
    try {
      const payload = { name, instructions, model: model || undefined, canDelegate, skillIds, integrations };
      if (agent) await fetch("/api/agents", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: agent.id, ...payload }) });
      else await fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      await onSaved();
    } finally { setSaving(false); }
  };

  return (
    <>
    <div className="tk-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <input className="tk-input" placeholder="Agent name (e.g. Researcher)" value={name} onChange={(e) => setName(e.target.value)} />
      <textarea className="aria-mem__textarea" style={{ minHeight: 100 }} placeholder="Instructions / role — what this agent does, its constraints, its output format…" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      <div>
        <label className="tk-label">Model</label>
        <div className="aria-proj">
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">Default (let Claude choose)</option>
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} — {m.blurb}</option>)}
          </select>
        </div>
      </div>

      {/* Skills */}
      <div>
        <div className="tk-label" style={{ marginBottom: 7, display: "flex", alignItems: "center", gap: 6 }}>
          <Wand2 size={12} /> Skills <span style={{ fontWeight: 400, color: "var(--aria-fg-faint)" }}>— curated practices baked into this agent · ⓘ to read one</span>
          <span className="aria-head__spacer" />
          <button className="tk-btn" style={{ padding: "4px 10px", fontSize: 11.5 }} onClick={() => setCreatingSkill(true)}><Plus size={12} /> New skill</button>
        </div>
        {byCat.map(([cat, list]) => (
          <div key={cat} style={{ marginBottom: 8 }}>
            <div className="tk-skillcat">{cat}</div>
            <div className="tk-skillgrid">
              {list.map((s) => (
                <span key={s.id} className="tk-skillwrap">
                  <button className={cx("tk-skill", skillIds.includes(s.id) && "tk-skill--on")} onClick={() => toggleSkill(s.id)} title={s.summary}>
                    {skillIds.includes(s.id) && <Check size={11} />} {s.name}
                  </button>
                  <button
                    className={cx("tk-skill__info", viewSkillId === s.id && "tk-skill__info--on")}
                    onClick={() => setViewSkillId((v) => v === s.id ? null : s.id)}
                    title={`Read "${s.name}" — full brief + where it comes from`} aria-label={`Read ${s.name}`}
                  ><Info size={11} /></button>
                </span>
              ))}
            </div>
          </div>
        ))}
        {viewSkill && (
          <SkillModal
            skill={viewSkill}
            onClose={() => setViewSkillId(null)}
            onDelete={viewSkill.custom ? async () => {
              const ok = await askConfirm({
                tone: "danger",
                icon: <Trash2 size={18} style={{ color: "#ff6b6b", flexShrink: 0 }} />,
                title: `Delete "${viewSkill.name}"?`,
                body: <>This removes the custom skill. Agents that reference it simply stop applying it.</>,
                confirmLabel: "Delete skill",
                confirmIcon: <Trash2 size={13} />,
              });
              if (!ok) return;
              await fetch(`/api/skills?id=${encodeURIComponent(viewSkill.id)}`, { method: "DELETE" });
              setViewSkillId(null);
              setSkillIds((ids) => ids.filter((x) => x !== viewSkill.id));
              await reloadSkills();
            } : undefined}
          />
        )}
        {creatingSkill && (
          <SkillCreator
            onClose={() => setCreatingSkill(false)}
            onCreated={async (id) => {
              setCreatingSkill(false);
              await reloadSkills();
              setSkillIds((ids) => ids.includes(id) ? ids : [...ids, id]);   // enable it on this agent right away
            }}
          />
        )}
      </div>

      {/* Integrations */}
      <div>
        <div className="tk-label" style={{ marginBottom: 7 }}><KeyRound size={12} style={{ display: "inline", verticalAlign: "-2px", marginRight: 4 }} /> Integrations <span style={{ fontWeight: 400, color: "var(--aria-fg-faint)" }}>— tokens are stored in a gitignored file, injected as env vars</span></div>
        <div className="tk-skillgrid" style={{ marginBottom: 8 }}>
          {placeholders.map((p) => (
            <button key={p.envVar} className={cx("tk-skill", hasIntegration(p.envVar) && "tk-skill--int-on")} onClick={() => toggleIntegration(p)} title={`env var: ${p.envVar}`}>
              {hasIntegration(p.envVar) && <Check size={11} />} {p.name}
            </button>
          ))}
        </div>
        <CustomIntegrationAdder onAdd={addCustomIntegration} />
        {/* Per-integration token entry (only for a saved agent) */}
        {agent && integrations.length > 0 && (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            {integrations.map((i) => <CredentialRow key={i.envVar} agentId={agent.id} integration={i} />)}
          </div>
        )}
        {!agent && integrations.length > 0 && (
          <p className="tk-hint" style={{ marginTop: 8 }}>Save the agent first, then re-open it to enter the tokens for these integrations.</p>
        )}
      </div>

      <label className="tk-check">
        <input type="checkbox" checked={canDelegate} onChange={(e) => setCanDelegate(e.target.checked)} />
        May spawn its own sub-agents (Claude-native delegation)
      </label>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="aria-mem__btn" onClick={onCancel}>Cancel</button>
        <button className="aria-mem__btn aria-mem__btn--primary" onClick={save} disabled={!name.trim() || !instructions.trim() || saving}>
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save agent
        </button>
      </div>
    </div>
    {dialogNode}
    </>
  );
}

function CustomIntegrationAdder({ onAdd }: { onAdd: (name: string, envVar: string) => void }) {
  const [name, setName] = useState("");
  const [envVar, setEnvVar] = useState("");
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <input className="tk-input" style={{ flex: 1 }} placeholder="Custom integration name" value={name} onChange={(e) => { setName(e.target.value); if (!envVar || envVar === guessEnv(name)) setEnvVar(guessEnv(e.target.value)); }} />
      <input className="tk-input" style={{ flex: 1, fontFamily: "var(--font-mono)" }} placeholder="ENV_VAR" value={envVar} onChange={(e) => setEnvVar(e.target.value.toUpperCase())} />
      <button className="tk-btn" onClick={() => { onAdd(name, envVar); setName(""); setEnvVar(""); }} disabled={!name.trim() || !envVar.trim()}><Plus size={13} /></button>
    </div>
  );
}
function guessEnv(name: string) { return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "") + (name.trim() ? "_TOKEN" : ""); }

// One integration's token entry — write-only (shows masked preview if already set).
function CredentialRow({ agentId, integration }: { agentId: string; integration: Integration }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [set, setSet] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/agents/${agentId}/credentials`, { cache: "no-store" });
      if (r.ok) { const creds: RedactedCred[] = (await r.json()).credentials ?? []; const c = creds.find((x) => x.envVar === integration.envVar); setPreview(c?.preview ?? null); setSet(!!c?.set); }
    } catch {}
  }, [agentId, integration.envVar]);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setBusy(true);
    try {
      await fetch(`/api/agents/${agentId}/credentials`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ envVar: integration.envVar, token }) });
      setToken(""); setEditing(false); await load();
    } finally { setBusy(false); }
  };
  const clear = async () => { setBusy(true); try { await fetch(`/api/agents/${agentId}/credentials?envVar=${encodeURIComponent(integration.envVar)}`, { method: "DELETE" }); await load(); } finally { setBusy(false); } };

  return (
    <div className="tk-credrow">
      <span className="tk-credrow__name">{integration.name}</span>
      <code className="tk-credrow__env">{integration.envVar}</code>
      {set && !editing ? (
        <>
          <span className="tk-credrow__preview">{preview}</span>
          <button className="aria-mem__act" onClick={() => setEditing(true)} title="Replace"><Pencil size={12} /></button>
          <button className="aria-mem__act aria-mem__act--danger" onClick={clear} title="Clear"><Trash2 size={12} /></button>
        </>
      ) : (
        <>
          <input className="tk-input" style={{ flex: 1 }} type="password" placeholder={`Paste ${integration.name} token`} value={token} onChange={(e) => setToken(e.target.value)} />
          <button className="aria-mem__btn aria-mem__btn--primary" onClick={save} disabled={!token.trim() || busy}>{busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}</button>
          {editing && <button className="aria-mem__btn" onClick={() => { setEditing(false); setToken(""); }}>Cancel</button>}
        </>
      )}
    </div>
  );
}

// ── New single task panel ──
function NewTaskPanel({ agents, project, projectName, onClose, onStarted }: { agents: Agent[]; project: string; projectName: string; onClose: () => void; onStarted: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState("");
  const [model, setModel] = useState("");   // "" = use the agent's model / default
  const [busy, setBusy] = useState(false);
  const agentModel = agents.find((a) => a.id === agentId)?.model;
  const start = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "task", prompt, project, agentId: agentId || undefined, model: model || undefined }) });
      onStarted();
    } finally { setBusy(false); }
  };
  return (
    <SlideOver title="New task" subtitle={`Runs in ${projectName} · streams live on the board`} onClose={onClose} icon={<Plus size={16} />}>
      <div className="tk-taskcfg">
        <div className="tk-taskcfg__field">
          <label className="tk-label"><Bot size={12} /> Agent <span className="tk-label__opt">optional</span></label>
          <div className="aria-proj">
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">No agent — plain Daryan</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>
        <div className="tk-taskcfg__field">
          <label className="tk-label"><Cpu size={12} /> Model</label>
          <div className="aria-proj">
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">{agentModel ? `Agent default (${modelLabel(agentModel)})` : "Default (let Claude choose)"}</option>
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} — {m.blurb}</option>)}
            </select>
          </div>
        </div>
      </div>
      <label className="tk-label" style={{ marginTop: 2 }}><Wand2 size={12} /> Task</label>
      <textarea className="aria-mem__textarea" style={{ flex: 1, minHeight: 180, resize: "none" }} placeholder="What should this task do? Be specific — the agent runs it autonomously and streams its work live on the board." value={prompt} onChange={(e) => setPrompt(e.target.value)} autoFocus />
      <div className="tk-taskfoot">
        <span className="tk-hint" style={{ margin: 0 }}><CircleDot size={11} style={{ verticalAlign: -1 }} /> Runs in <b>{projectName}</b></span>
        <button className="tk-btn tk-btn--primary" onClick={start} disabled={!prompt.trim() || busy}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Start task
        </button>
      </div>
    </SlideOver>
  );
}

// ── Flow builder panel (dual mode: explicit steps + NL plan) ──
type DraftStep = { key: string; agentId: string; prompt: string; dependsOn: string[]; title?: string };

function FlowPanel({ agents, templates, project, onClose, onStarted }: { agents: Agent[]; templates: FlowTemplate[]; project: string; onClose: () => void; onStarted: () => void }) {
  const [mode, setMode] = useState<"templates" | "steps" | "nl">("nl");   // Describe it is the default
  const [tmplInput, setTmplInput] = useState("");
  const [name, setName] = useState("");
  const [rootInput, setRootInput] = useState("");
  const [steps, setSteps] = useState<DraftStep[]>([{ key: "1", agentId: "", prompt: "", dependsOn: [] }]);
  const [goal, setGoal] = useState("");
  const [model, setModel] = useState("");   // flow-level model; "" = use each step's agent model
  const [busy, setBusy] = useState(false);

  const addStep = () => setSteps((s) => [...s, { key: String(s.length + 1), agentId: "", prompt: "", dependsOn: [] }]);
  const removeStep = (key: string) => setSteps((s) => s.filter((x) => x.key !== key).map((x) => ({ ...x, dependsOn: x.dependsOn.filter((d) => d !== key) })));
  const updateStep = (key: string, patch: Partial<DraftStep>) => setSteps((s) => s.map((x) => x.key === key ? { ...x, ...patch } : x));
  const toggleDep = (key: string, dep: string) => updateStep(key, { dependsOn: steps.find((x) => x.key === key)!.dependsOn.includes(dep) ? steps.find((x) => x.key === key)!.dependsOn.filter((d) => d !== dep) : [...steps.find((x) => x.key === key)!.dependsOn, dep] });

  const canRunSteps = useMemo(() => steps.length > 0 && steps.every((s) => s.prompt.trim()), [steps]);

  const runSteps = async () => {
    if (!canRunSteps) return;
    setBusy(true);
    try {
      await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        kind: "flow", name: name || "Flow", project, rootInput: rootInput || undefined, model: model || undefined,
        steps: steps.map((s) => ({ key: s.key, agentId: s.agentId || undefined, prompt: s.prompt, dependsOn: s.dependsOn, title: s.title })),
      }) });
      onStarted();
    } finally { setBusy(false); }
  };
  const runPlan = async () => {
    if (!goal.trim()) return;
    setBusy(true);
    try {
      await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "plan", goal, project, model: model || undefined }) });
      onStarted();
    } finally { setBusy(false); }
  };
  // Templates are starting points, not runnable as-is — a generic template run
  // is meaningless. Edit loads it into the Build-steps editor; run from there.
  // Agent roles resolve to agent ids by name (same as the server does).
  const editTemplate = (t: FlowTemplate) => {
    const byRole = new Map(agents.map((a) => [a.name.toLowerCase(), a.id]));
    setSteps(t.steps.map((s) => ({
      key: s.key,
      agentId: (s.agentRole && byRole.get(s.agentRole.toLowerCase())) || "",
      prompt: s.prompt,
      dependsOn: s.dependsOn ?? [],
      title: s.title,
    })));
    setName(t.name);
    setRootInput(tmplInput);   // carry the goal across so {{input}} still works
    setMode("steps");
  };

  return (
    <SlideOver title="New flow" subtitle="Start from a template, build steps, or describe a goal" onClose={onClose} icon={<GitBranch size={16} />} wide>
      <div className="tk-flowmodel">
        <label className="tk-label" style={{ margin: 0 }}>Model for this flow</label>
        <div className="aria-proj" style={{ maxWidth: 280 }}>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">Per agent (each step uses its agent&apos;s model)</option>
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} — overrides all agents</option>)}
          </select>
        </div>
        <span className="tk-hint" style={{ margin: 0 }}>{model ? "This model overrides every step's agent model." : "Each step runs on its agent's chosen model (or the default)."}</span>
      </div>
      <div className="tk-tabs">
        <button className={cx("tk-tab", mode === "nl" && "tk-tab--on")} onClick={() => setMode("nl")}><Wand2 size={13} /> Describe it</button>
        <button className={cx("tk-tab", mode === "templates" && "tk-tab--on")} onClick={() => setMode("templates")}><Sparkles size={13} /> Templates</button>
        <button className={cx("tk-tab", mode === "steps" && "tk-tab--on")} onClick={() => setMode("steps")}><GitBranch size={13} /> Build steps</button>
      </div>

      {mode === "templates" ? (
        <>
          <p className="tk-hint">Templates are starting points — pick one and <b>Edit</b> opens it in the step editor, where you tailor the prompts, agents, and dependencies to your goal before running. The goal below carries into <span className="font-mono">{"{{input}}"}</span>.</p>
          <input className="tk-input" placeholder="Goal / subject for this flow (optional but recommended)…" value={tmplInput} onChange={(e) => setTmplInput(e.target.value)} />
          {["Design", "Research", "Writing", "Engineering"].map((cat) => {
            const inCat = templates.filter((t) => t.category === cat);
            if (inCat.length === 0) return null;
            return (
              <div key={cat} className="tk-tmplgroup">
                <div className="tk-tmplgroup__head">{cat}</div>
                {inCat.map((t) => (
                  <div key={t.id} className="tk-card tk-tmpl">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="tk-tmpl__name">{t.name}{t.builtin && <span className="tk-tag">built-in</span>}</div>
                      <div className="tk-tmpl__desc">{t.description}</div>
                      <div className="tk-tmpl__steps">{t.steps.map((s, i) => <span key={s.key}>{i > 0 && <ArrowRight size={10} />}<span className="tk-tmpl__step">{s.agentRole ? `${s.agentRole}: ` : ""}{s.title}</span></span>)}</div>
                    </div>
                    <button className="tk-btn tk-btn--primary" onClick={() => editTemplate(t)} title="Open in the step editor — tailor prompts/agents/deps to your goal, then run">
                      <Pencil size={12} /> Edit
                    </button>
                  </div>
                ))}
              </div>
            );
          })}
        </>
      ) : mode === "steps" ? (
        <>
          <input className="tk-input" placeholder="Flow name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="tk-input" placeholder="Root input — referenced as {{input}} in any step (optional)" value={rootInput} onChange={(e) => setRootInput(e.target.value)} />
          {steps.map((s) => (
            <div key={s.key} className="tk-card tk-stepcard">
              <div className="tk-stepcard__head">
                <span className="tk-step">step {s.key}</span>
                <div className="aria-proj" style={{ flex: 1, height: 30 }}>
                  <select value={s.agentId} onChange={(e) => updateStep(s.key, { agentId: e.target.value })}>
                    <option value="">No agent — plain Daryan</option>
                    {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                <span className="tk-step__model" title={model ? "Overridden by the flow model above" : "From this step's agent"}>
                  {modelLabel(model || agents.find((a) => a.id === s.agentId)?.model)}
                </span>
                {steps.length > 1 && <button className="aria-mem__act aria-mem__act--danger" onClick={() => removeStep(s.key)} title="Remove step"><X size={13} /></button>}
              </div>
              <textarea className="aria-mem__textarea" placeholder={`Prompt for step ${s.key}. Reference an earlier step's output with {{key}}, e.g. {{1}}, or the root input with {{input}}.`} value={s.prompt} onChange={(e) => updateStep(s.key, { prompt: e.target.value })} />
              {steps.filter((x) => x.key !== s.key).length > 0 && (
                <div className="tk-deps">
                  <span className="tk-deps__label">depends on:</span>
                  {steps.filter((x) => x.key !== s.key).map((x) => (
                    <button key={x.key} className={cx("tk-depchip", s.dependsOn.includes(x.key) && "tk-depchip--on")} onClick={() => toggleDep(s.key, x.key)}>step {x.key}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
          <button className="tk-btn" style={{ alignSelf: "flex-start" }} onClick={addStep}><Plus size={14} /> Add step</button>
          <button className="tk-btn tk-btn--primary" style={{ alignSelf: "flex-end" }} onClick={runSteps} disabled={!canRunSteps || busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <GitBranch size={14} />} Run flow
          </button>
        </>
      ) : (
        <>
          <p className="tk-hint">Describe the goal in plain language. Daryan plans a multi-agent flow from your agents, wires the dependencies, and runs it — you watch each step stream live.</p>
          <textarea className="aria-mem__textarea" style={{ flex: 1, minHeight: 180, resize: "none" }} placeholder="e.g. Research how auth works in this project, then implement rate-limiting on the login route, then review the change for security issues." value={goal} onChange={(e) => setGoal(e.target.value)} autoFocus />
          <button className="tk-btn tk-btn--primary" style={{ alignSelf: "flex-end" }} onClick={runPlan} disabled={!goal.trim() || busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} Plan &amp; run
          </button>
        </>
      )}
    </SlideOver>
  );
}

// ── Shared slide-over shell ──
function SlideOver({ title, subtitle, icon, onClose, children, wide }: { title: string; subtitle?: string; icon: React.ReactNode; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="aria-portal" style={{ zIndex: 80 }}>
      <div className="aria-backdrop" onClick={onClose} aria-hidden />
      <div className={cx("aria-mem", wide && "tk-slideover--wide")} role="dialog" aria-label={title}>
        <div className="aria-basewash" aria-hidden style={{ opacity: 0.4 }} />
        <div className="aria-mist" aria-hidden><div className="aria-blob aria-blob--indigo" /><div className="aria-blob aria-blob--violet" /></div>
        <div className="aria-topfade" aria-hidden />
        <div className="aria-mem__inner">
          <div className="aria-mem__head">
            <span style={{ color: "#c79bff", display: "inline-flex" }}>{icon}</span>
            <div className="aria-mem__title" style={{ fontSize: 19 }}>{title}</div>
            <span className="aria-head__spacer" />
            <button className="aria-iconbtn" onClick={onClose} aria-label="Close"><X size={16} /></button>
          </div>
          {subtitle && <div className="aria-mem__tabhint" style={{ marginTop: 4 }}>{subtitle}</div>}
          <div className="aria-mem__body" style={{ gap: 12 }}>{children}</div>
        </div>
      </div>
    </div>
  );
}

// ── Centered modal chrome (stacks ABOVE the slide-over, z-95) ──
// Deliberately does NOT close on outside click — only Escape or the ✕ — so a
// stray click can't blow away a half-written skill.
function TkModal({ title, icon, onClose, children }: { title: React.ReactNode; icon?: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    // Capture phase so Escape closes THIS modal, not the slide-over beneath it.
    window.addEventListener("keydown", onKey, true);
    // Take focus so keyboard interaction lands in the modal (unless a child
    // like an autoFocus input already grabbed it).
    if (!dialogRef.current?.contains(document.activeElement)) dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="aria-portal" style={{ zIndex: 95 }}>
      <div className="aria-backdrop" aria-hidden />
      <div ref={dialogRef} className="tk-modal" role="dialog" aria-modal="true" tabIndex={-1}>
        <div className="tk-modal__head">
          {icon && <span style={{ color: "#c79bff", display: "inline-flex" }}>{icon}</span>}
          <div className="tk-modal__title">{title}</div>
          <span className="aria-head__spacer" />
          <button className="aria-iconbtn" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        <div className="tk-modal__body">{children}</div>
      </div>
    </div>
  );
}

// ── Skill detail modal — the full brief + where the practice comes from ──
function SkillModal({ skill, onClose, onDelete }: { skill: Skill; onClose: () => void; onDelete?: () => Promise<void> }) {
  return (
    <TkModal title={<>{skill.name} <span className="tk-tag">{skill.category}</span>{skill.custom && <span className="tk-tag tk-tag--custom">custom</span>}</>} icon={<Wand2 size={15} />} onClose={onClose}>
      <div className="tk-skillview__summary">{skill.summary}</div>
      <div className="tk-skillview__label">
        {skill.fileName
          ? <>Content of <span className="font-mono">{skill.fileName}</span> — injected into the agent&apos;s instructions ({skill.brief.length.toLocaleString()} chars):</>
          : <>What this injects into the agent&apos;s instructions:</>}
      </div>
      <div className="tk-skillview__brief">{skill.brief}</div>
      <div className="tk-skillview__source">
        Grounded in: <b>{skill.source}</b>
        {" · "}
        {skill.custom
          ? <>created by you{skill.fileName ? <> from <span className="font-mono">{skill.fileName}</span></> : null}, stored in <span className="font-mono">data/skills.json</span></>
          : <>built-in catalog (<span className="font-mono">src/lib/skills.ts</span>)</>}
      </div>
      {onDelete && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="tk-btn" style={{ color: "#ff9d9d" }} onClick={() => void onDelete()}><Trash2 size={13} /> Delete skill</button>
        </div>
      )}
    </TkModal>
  );
}

// ── Custom skill creation modal ──
const SKILL_CATEGORIES = ["research", "engineering", "review", "design", "ops", "writing"] as const;
const MAX_BRIEF_CHARS = 24_000;   // mirror of the server cap (lib/skills.ts)
function SkillCreator({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<string>("engineering");
  const [summary, setSummary] = useState("");
  const [brief, setBrief] = useState("");
  const [source, setSource] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Load a text/markdown file as the brief. The file's CONTENT becomes the
  // practice text (viewable later in the skill modal); the name seeds the
  // skill name if empty.
  const onFile = (f: File | null) => {
    if (!f) return;
    setErr(null);
    if (f.size > 1_000_000) { setErr("File too large (max ~1 MB of text)."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "").trim();
      if (!text) { setErr(`"${f.name}" is empty or not readable as text.`); return; }
      if (text.length > MAX_BRIEF_CHARS) { setErr(`"${f.name}" has ${text.length.toLocaleString()} chars; max ${MAX_BRIEF_CHARS.toLocaleString()}. Trim it to the essential practice — it rides inside every agent prompt.`); return; }
      setBrief(text);
      setFileName(f.name);
      if (!name.trim()) setName(f.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "));
    };
    reader.onerror = () => setErr(`Couldn't read "${f.name}".`);
    reader.readAsText(f);
  };
  const clearFile = () => { setFileName(null); setBrief(""); if (fileRef.current) fileRef.current.value = ""; };

  const create = async () => {
    if (!name.trim() || !brief.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/skills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, category, summary: summary || undefined, brief, source: source || undefined, fileName: fileName || undefined }) });
      const data = await r.json().catch(() => null) as { skill?: { id: string }; error?: string } | null;
      if (!r.ok || !data?.skill) { setErr(data?.error ?? `Couldn't create skill (HTTP ${r.status}).`); return; }
      await onCreated(data.skill.id);
    } finally { setBusy(false); }
  };
  return (
    <TkModal title="New skill" icon={<Wand2 size={15} />} onClose={onClose}>
      <p className="tk-hint" style={{ margin: 0 }}>A skill is a working practice injected into an agent&apos;s instructions when enabled. Write the brief as direct instructions — or upload a file (.md/.txt) to use its content.</p>
      <input className="tk-input" placeholder="Skill name (e.g. API-first design)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <div className="aria-proj">
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          {SKILL_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <input className="tk-input" placeholder="One-line summary (optional — shown on the chip)" value={summary} onChange={(e) => setSummary(e.target.value)} />

      {/* Brief: hand-written, or loaded from an uploaded file */}
      <input ref={fileRef} type="file" accept=".md,.markdown,.txt,.text,text/plain,text/markdown" hidden onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button className="tk-btn" onClick={() => fileRef.current?.click()}><Paperclip size={13} /> Upload file</button>
        {fileName && (
          <span className="tk-filechip" title={`${brief.length.toLocaleString()} chars loaded as the brief`}>
            <FileText size={12} /> {fileName} <span className="tk-filechip__meta">({brief.length.toLocaleString()} chars)</span>
            <button className="tk-filechip__x" onClick={clearFile} title="Remove file" aria-label="Remove file"><X size={11} /></button>
          </span>
        )}
      </div>
      <textarea
        className="aria-mem__textarea" style={{ minHeight: 110, maxHeight: 220 }}
        placeholder="The brief — the practice text injected into the agent's instructions. Be concrete and imperative."
        value={brief}
        onChange={(e) => { setBrief(e.target.value); if (fileName) setFileName(null); /* edited by hand → no longer verbatim the file */ }}
      />
      <input className="tk-input" placeholder="Source / grounding (optional — e.g. a book, spec, or team convention)" value={source} onChange={(e) => setSource(e.target.value)} />
      {err && <div className="tk-q__err" style={{ marginTop: 0 }}>{err}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="tk-btn" onClick={onClose}>Cancel</button>
        <button className="tk-btn tk-btn--primary" onClick={() => void create()} disabled={!name.trim() || !brief.trim() || busy}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Create skill
        </button>
      </div>
    </TkModal>
  );
}
