"use client";

// Bottom→top slide-out drawer combining Recent Activity (tasks) with Sessions
// and memory recall. Selecting a session shows its full turn history if still in
// the recent buffer, else its summaries (clearly labeled).

import { useCallback, useEffect, useState } from "react";
import { Clock, X, Activity, MessageSquare, Loader2, ArrowRight, ChevronLeft, Layers } from "lucide-react";
import { cx } from "@/lib/format";

type Session = { key: string; label: string; claudeSessionId: string | null; createdAt: number; lastTurnAt: number };
type TaskInfo = { id: string; label?: string; prompt: string; status: string; finishedAt?: number };
type Turn = { id: number; ts: string; prompt: string; reply: string; toolUses: string[]; category?: string };
type Summary = { id: number; ts: string; text: string; category?: string };
type Recall = { mode: "full" | "summary" | "empty"; turns: Turn[]; summaries: Summary[] };

export function ActivityDrawer({ open, project, projectName, tasks, activeSessionKey, onClose, onOpenSession, onPickUp }: {
  open: boolean;
  project: string;
  projectName: string;
  tasks: TaskInfo[];
  activeSessionKey: string | null;
  onClose: () => void;
  onOpenSession: (key: string) => void;     // switch the conversation to this session
  onPickUp: (text: string) => void;         // drop a follow-up into the input
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [recallOf, setRecallOf] = useState<Session | null>(null);
  const [recall, setRecall] = useState<Recall | null>(null);
  const [recallLoading, setRecallLoading] = useState(false);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/persona/sessions?project=${encodeURIComponent(project)}`, { cache: "no-store" });
      if (r.ok) setSessions((await r.json()).sessions ?? []);
    } finally { setLoading(false); }
  }, [project]);

  useEffect(() => { if (open) { void loadSessions(); setRecallOf(null); setRecall(null); } }, [open, loadSessions]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { if (recallOf) setRecallOf(null); else onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, recallOf, onClose]);

  const openRecall = useCallback(async (s: Session) => {
    setRecallOf(s); setRecall(null); setRecallLoading(true);
    try {
      const r = await fetch(`/api/persona/sessions?project=${encodeURIComponent(project)}&history=${s.key}`, { cache: "no-store" });
      if (r.ok) setRecall(await r.json());
    } finally { setRecallLoading(false); }
  }, [project]);

  if (!open) return null;
  const running = tasks.filter((t) => t.status === "running" || t.status === "streaming");
  const finished = tasks.filter((t) => t.status === "done" || t.status === "error");

  return (
    <div className="adrawer-portal">
      <div className="adrawer-backdrop" onClick={onClose} aria-hidden />
      <div className="adrawer" role="dialog" aria-label="Activity and sessions">
        <div className="adrawer__handle" aria-hidden />
        <div className="adrawer__head">
          {recallOf ? (
            <>
              <button className="aria-iconbtn" onClick={() => setRecallOf(null)} aria-label="Back"><ChevronLeft size={16} /></button>
              <MessageSquare size={15} style={{ color: "#c79bff" }} />
              <span className="adrawer__title">{recallOf.label}</span>
              {recall && <span className="adrawer__mode">{recall.mode === "full" ? "full history" : recall.mode === "summary" ? "summary (history rolled up)" : "no history yet"}</span>}
            </>
          ) : (
            <>
              <Clock size={15} style={{ color: "#c79bff" }} />
              <span className="adrawer__title">Activity &amp; Sessions</span>
              <span className="adrawer__proj">· {projectName}</span>
            </>
          )}
          <span style={{ flex: 1 }} />
          {recallOf && <button className="adrawer__open" onClick={() => { onOpenSession(recallOf.key); onClose(); }}>Open session <ArrowRight size={12} /></button>}
          <button className="aria-iconbtn" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>

        <div className="adrawer__body">
          {recallOf ? (
            recallLoading ? <div className="adrawer__empty"><Loader2 size={14} className="animate-spin" /> Loading…</div>
            : !recall || recall.mode === "empty" ? <div className="adrawer__empty">This session has no recorded history yet.</div>
            : recall.mode === "full" ? (
              <div className="adrawer__history">
                {recall.turns.map((t) => (
                  <div key={t.id} className="adrawer__turn">
                    <div className="adrawer__turn-user">{t.prompt}</div>
                    <div className="adrawer__turn-aria">{t.reply}</div>
                    {t.category && <span className="adrawer__cat">{t.category}</span>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="adrawer__history">
                <div className="adrawer__summnote">Full turns rolled into long-term memory — showing the distilled summaries:</div>
                {recall.summaries.map((s) => (
                  <div key={s.id} className="adrawer__summ">{s.category && <span className="adrawer__cat">{s.category}</span>} {s.text}</div>
                ))}
              </div>
            )
          ) : (
            <>
              {/* Sessions */}
              <div className="adrawer__section"><Layers size={12} /> Sessions <span className="tk-pill">{sessions.length}</span></div>
              {loading && sessions.length === 0 ? (
                <div className="adrawer__empty"><Loader2 size={14} className="animate-spin" /> Loading…</div>
              ) : sessions.length === 0 ? (
                <div className="adrawer__empty">No sessions yet — start typing to create one.</div>
              ) : (
                <div className="adrawer__sessions">
                  {sessions.map((s) => (
                    <button key={s.key} className={cx("adrawer__session", s.key === activeSessionKey && "adrawer__session--active")} onClick={() => void openRecall(s)}>
                      <MessageSquare size={13} className="adrawer__session-icon" />
                      <span className="adrawer__session-name">{s.label}</span>
                      {s.key === activeSessionKey && <span className="adrawer__session-badge">active</span>}
                      <span className="adrawer__session-time">{formatAgo(s.lastTurnAt)}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Tasks */}
              {(running.length > 0 || finished.length > 0) && (
                <>
                  <div className="adrawer__section" style={{ marginTop: 16 }}><Activity size={12} /> Recent tasks</div>
                  {running.map((t) => (
                    <div key={t.id} className="adrawer__task adrawer__task--running">
                      <span className="home-dot home-dot--running" /> {t.label || t.prompt.slice(0, 60)}
                    </div>
                  ))}
                  {finished.map((t) => (
                    <div key={t.id} className="adrawer__task">
                      <span className={cx("home-briefing__status", t.status === "error" ? "home-briefing__status--err" : "home-briefing__status--ok")} />
                      <span className="adrawer__task-label">{t.label || t.prompt.slice(0, 60)}</span>
                      {t.finishedAt && <span className="adrawer__task-time">{formatAgo(t.finishedAt)}</span>}
                      <button className="home-briefing__pickup" onClick={() => { onPickUp(`The task "${t.label || t.prompt.slice(0, 40)}" just finished. Show me the results and what's next.`); onClose(); }}>Pick up <ArrowRight size={11} /></button>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function formatAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}
