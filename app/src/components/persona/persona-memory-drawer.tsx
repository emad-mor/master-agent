"use client";

import { useCallback, useEffect, useState } from "react";
import { Brain, X, Trash2, Loader2, RefreshCw, Pin, Plus, Pencil, Check, Globe, Tag, ChevronDown, ChevronRight, RotateCcw, AlertTriangle } from "lucide-react";
import { cx } from "@/lib/format";
import "./companion.css";

type CoreFact = { id: string; ts: string; text: string; source: "seed" | "user" | "aria"; category?: string };
type Turn = { id: number; ts: string; prompt: string; reply: string; toolUses: string[]; sessionId?: string; category?: string };
type Summary = { id: number; ts: string; text: string; category?: string };
type Theme = { text: string; derivedFrom: number[]; category?: string };

const UNCAT = "Uncategorized";
function catOf(c?: string) { return c?.trim() || UNCAT; }
// Group items by category, return [category, items][] with each group sorted by
// the provided recency key (desc), groups ordered by their most-recent member.
function groupByCategory<T>(items: T[], cat: (t: T) => string, recency: (t: T) => number): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const it of items) { const k = cat(it); if (!m.has(k)) m.set(k, []); m.get(k)!.push(it); }
  for (const arr of m.values()) arr.sort((a, b) => recency(b) - recency(a));
  return [...m.entries()].sort((a, b) => recency(b[1][0]) - recency(a[1][0]));
}
type Stats = {
  core: number; recentTurns: number; summaries: number; themes: number;
  sessionId: string | null; lastTurnAt: number; onDiskBytes: number;
  limits: { recent: number; mid: number; long: number };
};

export function PersonaMemoryDrawer({ open, onClose, refreshKey, project, projectName }: {
  open: boolean;
  onClose: () => void;
  refreshKey: number;
  project: string;
  projectName: string;
}) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [core, setCore] = useState<CoreFact[]>([]);
  const [recent, setRecent] = useState<Turn[]>([]);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [themes, setThemes] = useState<Theme[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"core" | "recent" | "summaries" | "themes">("core");
  const [draft, setDraft] = useState("");
  const [draftCat, setDraftCat] = useState("");          // category for a new core fact
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState("All");           // active category filter (per the current tab)
  // Reset the category filter to All when switching tabs (categories differ per tier).
  useEffect(() => { setFilter("All"); }, [tab]);
  // Hard-reset (type-to-confirm) modal state.
  const [resetOpen, setResetOpen] = useState(false);
  const [resetText, setResetText] = useState("");
  const [resetting, setResetting] = useState(false);
  const CONFIRM_PHRASE = "reset memory";
  const canReset = resetText.trim().toLowerCase() === CONFIRM_PHRASE;

  const q = `project=${encodeURIComponent(project)}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/persona/memory?${q}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setStats(data.stats);
        setCore(data.core ?? []);
        setRecent(data.recent ?? []);
        setSummaries(data.summaries ?? []);
        setThemes(data.themes ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => { if (open) void load(); }, [open, refreshKey, load]);

  // Close on Escape (capture-phase so it beats the widget's own Escape handler).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  const pinFact = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setSaving(true);
    try {
      await fetch("/api/persona/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, category: draftCat.trim() || undefined }),
      });
      setDraft(""); setDraftCat("");
      await load();
    } finally { setSaving(false); }
  }, [draft, draftCat, load]);

  const saveEdit = useCallback(async (id: string, category?: string) => {
    const text = editText.trim();
    if (!text) return;
    setSaving(true);
    try {
      await fetch("/api/persona/memory", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, text, category }),
      });
      setEditingId(null);
      setEditText("");
      await load();
    } finally { setSaving(false); }
  }, [editText, load]);

  // Re-tag a recent turn's category inline (prompt for a new one).
  const retagTurn = useCallback(async (id: number, current?: string) => {
    const next = prompt("Category for this turn:", current ?? "");
    if (next === null) return;
    await fetch("/api/persona/memory", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, turnId: id, category: next.trim() }),
    });
    await load();
  }, [project, load]);

  const unpinFact = useCallback(async (id: string, text: string) => {
    const preview = text.length > 80 ? text.slice(0, 80) + "…" : text;
    if (!confirm(`Delete this core fact? It's global and won't be restored.\n\n"${preview}"`)) return;
    await fetch(`/api/persona/memory?coreId=${encodeURIComponent(id)}`, { method: "DELETE" });
    await load();
  }, [load]);

  const forgetTurn = useCallback(async (id: number, prompt: string) => {
    const preview = prompt.length > 80 ? prompt.slice(0, 80) + "…" : prompt;
    if (!confirm(`Forget turn ${id}? This removes it from ${projectName}'s recent memory.\n\n"${preview}"`)) return;
    await fetch(`/api/persona/memory?${q}&turnId=${id}`, { method: "DELETE" });
    await load();
  }, [q, projectName, load]);

  const wipeAll = useCallback(async () => {
    if (!confirm(`Wipe ${projectName}'s conversational memory? Core facts survive. Daryan starts fresh on this project next Send.`)) return;
    await fetch(`/api/persona/memory?${q}&all=1`, { method: "DELETE" });
    await load();
  }, [q, projectName, load]);

  // HARD reset: wipe ALL memory (every project + global core). Type-to-confirm
  // gated. On success, reload so the whole app (sessions, turns) starts fresh.
  const hardReset = useCallback(async () => {
    if (!canReset || resetting) return;
    setResetting(true);
    try {
      const r = await fetch(`/api/persona/memory?hardReset=1`, { method: "DELETE" });
      if (r.ok) { window.location.reload(); return; }
      setResetting(false);
    } catch { setResetting(false); }
  }, [canReset, resetting]);

  if (!open) return null;

  const TABS = [
    { key: "core" as const, label: "Core", icon: <Globe size={11} />, count: core.length, hint: "Global · always injected" },
    { key: "recent" as const, label: "Recent", count: recent.length, hint: `Verbatim · last ${stats?.limits.recent ?? 20}` },
    { key: "summaries" as const, label: "Mid", count: summaries.length, hint: "Haiku-summarized" },
    { key: "themes" as const, label: "Long", count: themes.length, hint: "Distilled themes" },
  ];

  // Distinct categories present in the active tab, for the filter dropdown.
  const activeCats = (() => {
    const src: { category?: string }[] = tab === "core" ? core : tab === "recent" ? recent : tab === "summaries" ? summaries : themes;
    const set = new Set(src.map((x) => catOf(x.category)));
    return ["All", ...[...set].sort((a, b) => a === UNCAT ? 1 : b === UNCAT ? -1 : a.localeCompare(b))];
  })();
  const passFilter = (c?: string) => filter === "All" || catOf(c) === filter;

  return (
    <div className="aria-portal" style={{ zIndex: 70 }}>
      <div className="aria-backdrop" onClick={onClose} aria-hidden />
      <div className="aria-mem" role="dialog" aria-label="Aria memory">
        {/* subtle mist so it matches the chat sheet */}
        <div className="aria-basewash" aria-hidden style={{ opacity: 0.4 }} />
        <div className="aria-mist" aria-hidden>
          <div className="aria-blob aria-blob--indigo" />
          <div className="aria-blob aria-blob--violet" />
          <div className="aria-blob aria-blob--azure" />
        </div>
        <div className="aria-topfade" aria-hidden />
        <div className="aria-handle" aria-hidden />

        <div className="aria-mem__inner">
          {/* Header */}
          <div className="aria-mem__head">
            <Brain size={17} style={{ color: "#c79bff", flexShrink: 0 }} />
            <div className="aria-mem__title">Memory</div>
            <span className="aria-mem__proj">· {projectName}</span>
            <span className="aria-head__spacer" />
            <button className="aria-iconbtn" onClick={() => void load()} title="Refresh" aria-label="Refresh memory">
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            </button>
            <button className="aria-iconbtn" onClick={wipeAll} title={`Wipe ${projectName}'s conversational memory`} aria-label="Wipe project memory" style={{ color: "#ff9d9d" }}>
              <Trash2 size={14} />
            </button>
            <button className="aria-iconbtn" onClick={() => { setResetText(""); setResetOpen(true); }} title="Hard reset ALL memory — every project + core (type-to-confirm)" aria-label="Hard reset all memory" style={{ color: "#ff6b6b" }}>
              <RotateCcw size={14} />
            </button>
            <button className="aria-iconbtn" onClick={onClose} aria-label="Close memory"><X size={16} /></button>
          </div>

          {/* Stat summary */}
          {stats && (
            <div className="aria-mem__stats">
              <span><b>{stats.core}</b> core</span>
              <span><b>{stats.recentTurns}</b>/{stats.limits.recent} recent</span>
              <span><b>{stats.summaries}</b> mid</span>
              <span><b>{stats.themes}</b> long</span>
              <span style={{ opacity: 0.6 }}>{(stats.onDiskBytes / 1024).toFixed(1)} KB on disk</span>
            </div>
          )}

          {/* Tabs */}
          <div className="aria-mem__tabs">
            {TABS.map((t) => (
              <button key={t.key} onClick={() => setTab(t.key)} className={cx("aria-mem__tab", tab === t.key && "aria-mem__tab--active")}>
                {t.icon} {t.label} <span className="aria-mem__tabcount">{t.count}</span>
              </button>
            ))}
          </div>
          <div className="aria-mem__tabhint">{TABS.find((t) => t.key === tab)?.hint} · grouped by category, most-recent first</div>

          {/* Category filter */}
          {activeCats.length > 1 && (
            <div className="aria-mem__filter">
              {activeCats.map((c) => (
                <button key={c} onClick={() => setFilter(c)} className={cx("aria-mem__catfilter", filter === c && "aria-mem__catfilter--on")}>
                  {c}
                </button>
              ))}
            </div>
          )}

          {/* Body */}
          <div className="aria-mem__body">
            {tab === "core" && (
              <>
                <p className="aria-mem__note">
                  <span style={{ color: "#c79bff", fontWeight: 600 }}><Globe size={11} style={{ display: "inline", verticalAlign: "-1px" }} /> Global</span> — injected on every project, never summarized or forgotten. Project-specific memory lives in the other tabs.
                </p>
                <div className="aria-mem__card">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void pinFact(); } }}
                    placeholder="Pin a durable fact for Daryan… (⌘/Ctrl+Enter to add)"
                    className="aria-mem__textarea"
                  />
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
                    <input className="aria-mem__catinput" placeholder="Category (optional)" value={draftCat} onChange={(e) => setDraftCat(e.target.value)} />
                    <button onClick={() => void pinFact()} disabled={!draft.trim() || saving} className="aria-mem__btn aria-mem__btn--primary">
                      {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Pin
                    </button>
                  </div>
                </div>

                {core.length === 0
                  ? <Empty label="No core facts yet. Pin the things Daryan should never forget." />
                  : groupByCategory(core.filter((c) => passFilter(c.category)), (c) => catOf(c.category), (c) => new Date(c.ts).getTime()).map(([cat, items]) => (
                    <CategoryGroup key={cat} cat={cat} count={items.length}>
                      {items.map((c) => (
                        <article key={c.id} className="aria-mem__card aria-mem__row">
                          {editingId === c.id ? (
                            <div style={{ width: "100%" }}>
                              <textarea value={editText} onChange={(e) => setEditText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveEdit(c.id, c.category); } }} className="aria-mem__textarea" autoFocus />
                              <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 8 }}>
                                <button onClick={() => { setEditingId(null); setEditText(""); }} className="aria-mem__btn">Cancel</button>
                                <button onClick={() => void saveEdit(c.id, c.category)} disabled={!editText.trim() || saving} className="aria-mem__btn aria-mem__btn--primary">
                                  {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Save
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="aria-mem__row-main">
                                <Pin size={12} style={{ color: "#c79bff", flexShrink: 0, marginTop: 3 }} />
                                <span className="aria-mem__text">{c.text}{c.source !== "user" && <span className="aria-mem__src"> · {c.source}</span>}</span>
                              </div>
                              <div className="aria-mem__row-actions">
                                <button onClick={() => { setEditingId(c.id); setEditText(c.text); }} className="aria-mem__act" title="Edit"><Pencil size={12} /></button>
                                <button onClick={() => void unpinFact(c.id, c.text)} className="aria-mem__act aria-mem__act--danger" title="Delete fact"><Trash2 size={12} /></button>
                              </div>
                            </>
                          )}
                        </article>
                      ))}
                    </CategoryGroup>
                  ))
                }
              </>
            )}

            {tab === "recent" && (
              recent.length === 0
                ? <Empty label={`No recent turns for ${projectName} yet. Send Daryan a message to start.`} />
                : groupByCategory(recent.filter((t) => passFilter(t.category)), (t) => catOf(t.category), (t) => t.id).map(([cat, items]) => (
                  <CategoryGroup key={cat} cat={cat} count={items.length}>
                    {items.map((t) => (
                      <article key={t.id} className="aria-mem__card aria-mem__turn">
                        <div className="aria-mem__turn-head">
                          <span className="aria-mem__meta">turn {t.id} · {new Date(t.ts).toLocaleString()}</span>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button onClick={() => retagTurn(t.id, t.category)} className="aria-mem__act" title="Re-tag category"><Tag size={12} /></button>
                            <button onClick={() => forgetTurn(t.id, t.prompt)} className="aria-mem__act aria-mem__act--danger" title={`Forget turn ${t.id}`}><Trash2 size={12} /></button>
                          </div>
                        </div>
                        <div className="aria-mem__text" style={{ marginTop: 6 }}><span style={{ color: "#c79bff", fontWeight: 600 }}>You:</span> {t.prompt}</div>
                        <div className="aria-mem__text" style={{ marginTop: 5 }}><span style={{ color: "var(--aria-fg-dim)", fontWeight: 600 }}>Aria:</span> {t.reply}</div>
                        {t.toolUses.length > 0 && <div className="aria-mem__meta" style={{ marginTop: 6 }}>tools: {t.toolUses.join(", ")}</div>}
                      </article>
                    ))}
                  </CategoryGroup>
                ))
            )}

            {tab === "summaries" && (
              summaries.length === 0
                ? <Empty label="Summaries appear here once a turn rolls out of the recent buffer." />
                : groupByCategory(summaries.filter((s) => passFilter(s.category)), (s) => catOf(s.category), (s) => s.id).map(([cat, items]) => (
                  <CategoryGroup key={cat} cat={cat} count={items.length}>
                    {items.map((s) => (
                      <article key={s.id} className="aria-mem__card">
                        <div className="aria-mem__meta">turn {s.id} · {new Date(s.ts).toLocaleString()}</div>
                        <div className="aria-mem__text" style={{ marginTop: 6 }}>{s.text}</div>
                      </article>
                    ))}
                  </CategoryGroup>
                ))
            )}

            {tab === "themes" && (
              themes.length === 0
                ? <Empty label="Long-term themes crystallize after ~100 turns on this project." />
                : groupByCategory(themes.filter((t) => passFilter(t.category)).map((t, i) => ({ ...t, _i: i })), (t) => catOf(t.category), (t) => t._i).map(([cat, items]) => (
                  <CategoryGroup key={cat} cat={cat} count={items.length}>
                    <article className="aria-mem__card">
                      <ul className="aria-mem__themes">
                        {items.map((t) => <li key={t._i}><span style={{ color: "#c79bff" }}>·</span> {t.text}</li>)}
                      </ul>
                    </article>
                  </CategoryGroup>
                ))
            )}
          </div>
        </div>
      </div>

      {/* Hard-reset confirm — type the phrase to enable the destructive action */}
      {resetOpen && (
        <div className="aria-backdrop" style={{ zIndex: 95, display: "grid", placeItems: "center", padding: 24 }} onClick={() => !resetting && setResetOpen(false)}>
          <div role="dialog" aria-label="Hard reset memory" onClick={(e) => e.stopPropagation()}
               style={{ width: "min(440px,100%)", borderRadius: 16, border: "1px solid rgba(255,107,107,.4)", background: "rgba(20,13,31,.97)", boxShadow: "0 30px 90px rgba(0,0,0,.6)", padding: 22 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
              <AlertTriangle size={18} style={{ color: "#ff6b6b", flexShrink: 0 }} />
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "var(--aria-fg)" }}>Hard reset memory</h3>
            </div>
            <p style={{ margin: "0 0 14px", fontSize: 13.5, lineHeight: 1.55, color: "var(--aria-fg-dim)" }}>
              This wipes <b>all</b> of Daryan&apos;s memory — every project&apos;s recent turns, summaries, themes and sessions, <b>and</b> the global core facts. Daryan starts completely fresh. This <b>cannot be undone</b>.
            </p>
            <label style={{ display: "block", fontSize: 12, color: "var(--aria-fg-faint)", marginBottom: 6 }}>
              Type <span style={{ fontFamily: "var(--font-mono)", color: "#ff8a8a", fontWeight: 600 }}>reset memory</span> to confirm
            </label>
            <input className="tk-input" autoFocus value={resetText} disabled={resetting}
                   onChange={(e) => setResetText(e.target.value)}
                   onKeyDown={(e) => { if (e.key === "Enter" && canReset) void hardReset(); if (e.key === "Escape") setResetOpen(false); }}
                   placeholder="reset memory"
                   style={{ width: "100%", padding: "9px 11px", borderRadius: 10, fontFamily: "var(--font-mono)", border: `1px solid ${canReset ? "rgba(255,107,107,.7)" : "var(--aria-stroke-strong)"}`, background: "var(--aria-fill)", color: "var(--aria-fg)", outline: "none" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button className="aria-mem__btn" onClick={() => setResetOpen(false)} disabled={resetting}>Cancel</button>
              <button onClick={() => void hardReset()} disabled={!canReset || resetting}
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 9, fontSize: 12.5, fontWeight: 600, border: "1px solid transparent", color: "#fff", cursor: canReset && !resetting ? "pointer" : "not-allowed", opacity: canReset && !resetting ? 1 : 0.5, background: "linear-gradient(135deg,#e0453c,#b3261e)" }}>
                {resetting ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Reset memory
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="aria-mem__empty">{label}</p>;
}

// Collapsible category header wrapping a group of memory entries.
function CategoryGroup({ cat, count, children }: { cat: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="aria-mem__group">
      <button className="aria-mem__grouphead" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Tag size={11} style={{ color: "#c79bff" }} />
        <span className="aria-mem__groupname">{cat}</span>
        <span className="aria-mem__groupcount">{count}</span>
      </button>
      {open && <div className="aria-mem__groupbody">{children}</div>}
    </div>
  );
}
