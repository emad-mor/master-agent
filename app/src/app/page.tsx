"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, Mic, ArrowUp, GitBranch, Clock, ArrowRight, AlertCircle, FolderTree, MoreHorizontal, RefreshCw, Loader2, Square, Activity, Paperclip, X, Plus, UploadCloud, FileText, Check, Volume2, VolumeX, Play, Pause, Brain, ChevronDown, Wrench } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { cx } from "@/lib/format";
import { PERSONA, timeOfDay, QUICK_PROMPTS } from "@/components/persona/persona-config";
import { FileTreeRail } from "@/components/home/file-tree";
import { ReposRail } from "@/components/home/repos-rail";
import { ActivityDrawer } from "@/components/home/activity-drawer";
import { StatusBar } from "@/components/home/status-bar";
import { PersonaMemoryDrawer } from "@/components/persona/persona-memory-drawer";
import { Markdown } from "@/components/persona/markdown";
import { useReader, stopAllReaders } from "@/components/tasks/use-reader";
import { VOICE_GROUPS, DEFAULT_VOICE, getVoice, setVoice } from "@/lib/voice-prefs";
import "@/components/persona/companion.css";

/* ────────────────────────────────────────────────────────────
   Aria Agent-First Homepage
   Conversation front-and-center + briefing panel.
   ──────────────────────────────────────────────────────────── */

const STORAGE_KEY = "aria.lastDraft";
const PROJECT_KEY = "aria.activeProject";
const SPEAK_KEY = "aria.speakReplies";
const WORKSPACE_KEY = "__workspace__";
const SELF_KEY = "__self__";              // Daryan's own source code (repo root) — edit the system itself
const MIN_RECORDING_MS = 350;
const WAVE_BARS = 48;

type Project = { slug: string; name: string; path: string };

type TaskInfo = {
  id: string;
  label?: string;
  prompt: string;
  status: string;
  result?: string;
  startedAt?: number;
  finishedAt?: number;
};

type Suggestion = { label: string; prompt: string };
type LaunchedFlow = { flowId?: string; goal: string; stepCount?: number; error?: string };
type Turn = {
  id: number;
  prompt: string;
  reply: string;
  toolUses: string[];
  status: "streaming" | "done" | "error";
  errorMessage?: string;
  startedAt: number;
  activity?: string;
  suggestions?: Suggestion[];
  flow?: LaunchedFlow;        // a multi-agent flow Aria launched from this turn
  kind?: "handoff";           // system-seeded (flow carried over) — render distinctly, not as a typed message
};

// Parse [[NEXT label="..." | prompt="..."]] markers out of a reply.
const NEXT_RE = /\[\[\s*NEXT\s+label="([^"]*)"\s*\|\s*prompt="([^"]*)"\s*\]\]/gi;
function parseSuggestions(reply: string): Suggestion[] {
  const out: Suggestion[] = [];
  let m: RegExpExecArray | null;
  NEXT_RE.lastIndex = 0;
  while ((m = NEXT_RE.exec(reply)) !== null) {
    const label = m[1].trim();
    const prompt = m[2].trim();
    if (label && prompt && !out.some((s) => s.label === label)) out.push({ label, prompt });
  }
  return out;
}
// Remove the marker block (and any partial trailing marker mid-stream, plus a
// trailing "---" separator) from the visible reply text. Covers both [[NEXT]]
// suggestion markers and [[FLOW]] launch markers.
function stripSuggestions(reply: string): string {
  return reply
    .replace(/\[\[\s*(NEXT|FLOW)\b[\s\S]*?\]\]/gi, "")  // complete markers (non-greedy: tolerates a literal ] inside an attribute)
    .replace(/\[\[\s*(NEXT|FLOW)\b[\s\S]*$/i, "")       // partial trailing marker while streaming
    .replace(/\[\[\s*\/?\s*(SUMMARY|SPEAK)\s*\]\]/gi, "")  // stray SUMMARY (or legacy SPEAK) markers — never leak
    .replace(/\n?\s*-{3,}\s*$/g, "")                     // trailing --- separator
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}
// The agent ends voice-first replies with a "More details" action that unlocks
// the full written breakdown for one turn. That ONE suggestion renders as a
// small inline button at the end of the reply (not a full next-step card).
const isMoreDetails = (s: Suggestion) => /^\s*more\s+detail/i.test(s.label);

// The agent wraps a short voice-first recap in [[SUMMARY]]…[[/SUMMARY]]. On the
// home chat that recap IS the default visible+spoken reply; the fuller detail
// the agent wrote sits behind a "More details" expander.
const SUMMARY_RE = /\[\[\s*(?:SUMMARY|SPEAK)\s*\]\]([\s\S]*?)\[\[\s*\/\s*(?:SUMMARY|SPEAK)\s*\]\]/i;
function extractSummary(reply: string): string {
  const m = SUMMARY_RE.exec(reply);
  return m && m[1].trim() ? m[1].trim() : "";
}
// The reply with the whole [[SUMMARY]] (or legacy [[SPEAK]]) block removed → detail.
function stripSummaryBlock(reply: string): string {
  return reply.replace(SUMMARY_RE, "").replace(/\[\[\s*\/?\s*(SUMMARY|SPEAK)\s*\]\]/gi, "").trim();
}

export default function Home() {
  // ── Conversation state ──
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const turnSeqRef = useRef(0);
  const hydratedRef = useRef<string | null>(null);   // which session's history is loaded
  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);   // auto-follow the stream only when at/near the bottom
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // ── Voice state ──
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>(() => new Array(WAVE_BARS).fill(0));
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordStartRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  // ── File attachment state ──
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  // ── Voice OUT (TTS) ──
  // A SINGLE engine drives all reply audio: each reply's <ReplyVoice> owns a
  // useReader instance (streaming, scrubbable, marker-stripped). When "Voice" is
  // on we auto-play the just-finished reply by tagging its turn id; the reader's
  // own controls then sit right on that reply. Readers are globally exclusive, so
  // auto-play + a manual Listen can never overlap. stopAllReaders() stops audio.
  const [speakReplies, setSpeakReplies] = useState(false);
  const [autoPlayTurnId, setAutoPlayTurnId] = useState<number | null>(null);
  const [voice, setVoiceState] = useState(DEFAULT_VOICE);   // reading voice (Kokoro); real value set client-side
  useEffect(() => { setVoiceState(getVoice()); }, []);
  // Play a short sample in the chosen voice so the user hears it on pick.
  const previewVoice = useCallback(async (v: string) => {
    stopAllReaders();
    try {
      const res = await fetch("/api/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `Hi, I'm ${PERSONA.name}.`, voice: v }) });
      if (!res.ok) return;
      const url = URL.createObjectURL(await res.blob());
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      void a.play().catch(() => URL.revokeObjectURL(url));
    } catch {}
  }, []);

  // ── Attachments (any dropped file: image / text / doc) ──
  // Saved server-side into the project's .daryan-drops/ and referenced by path so
  // Claude reads them with its tools.
  const [attachments, setAttachments] = useState<{ relPath: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);

  // ── Project state ──
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<string>(WORKSPACE_KEY);
  const [loadingProjects, setLoadingProjects] = useState(false);

  // ── Sessions ("tabs"), file tree, activity drawer ──
  const [sessions, setSessions] = useState<{ key: string; label: string }[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);   // first sessions fetch resolved
  const [hydrating, setHydrating] = useState(false);             // tab history loading from disk
  const [treePinned, setTreePinned] = useState(false);
  const [reposPinned, setReposPinned] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryRefresh, setMemoryRefresh] = useState(0);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);            // tab-picker dropdown (pinned at end of tab strip)
  const tabPickerRef = useRef<HTMLDivElement | null>(null);

  // ── Briefing state ──
  const [recentTasks, setRecentTasks] = useState<TaskInfo[]>([]);
  const [loadingBriefing, setLoadingBriefing] = useState(true);

  const projectName = project === WORKSPACE_KEY
    ? "All projects"
    : project === SELF_KEY
    ? "Daryan source"
    : projects.find((p) => p.slug === project)?.name ?? project;

  // ── Upload dropped/picked files to the active project's .daryan-drops ──
  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files).slice(0, 8);
    if (arr.length === 0) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.set("project", project);
      for (const f of arr) form.append("files", f);
      const res = await fetch("/api/drops", { method: "POST", body: form });
      if (res.ok) {
        const { saved } = await res.json();
        setAttachments((prev) => [...prev, ...(saved ?? [])]);
      }
    } catch {} finally { setUploading(false); }
  }, [project]);

  const removeAttachment = useCallback((relPath: string) => {
    setAttachments((prev) => prev.filter((a) => a.relPath !== relPath));
  }, []);

  // ── Voice preference: restore from storage; on mute, stop all reader audio ──
  useEffect(() => { try { if (localStorage.getItem(SPEAK_KEY) === "1") setSpeakReplies(true); } catch {} }, []);
  useEffect(() => {
    try { localStorage.setItem(SPEAK_KEY, speakReplies ? "1" : "0"); } catch {}
    if (!speakReplies) { stopAllReaders(); setAutoPlayTurnId(null); }
  }, [speakReplies]);

  // ── Sessions ("tabs") ──
  const loadSessions = useCallback(async () => {
    try {
      const r = await fetch(`/api/persona/sessions?project=${encodeURIComponent(project)}`, { cache: "no-store" });
      if (r.ok) {
        const list: { key: string; label: string }[] = (await r.json()).sessions ?? [];
        setSessions(list);
        setActiveSession((cur) => (cur && list.some((s) => s.key === cur)) ? cur : (list[0]?.key ?? null));
      }
    } catch {}
    finally { setSessionsLoaded(true); }
  }, [project]);

  // Dismiss the tab-picker dropdown on outside-click / Escape.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => { if (tabPickerRef.current && !tabPickerRef.current.contains(e.target as Node)) setPickerOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPickerOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [pickerOpen]);

  // Auto-grow the composer with its content (up to ~5 lines, then it scrolls).
  // Runs on every text change so typing AND programmatic fills (suggestions,
  // pick-up, transcription) resize, and it collapses back after send clears it.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 128) + "px";
  }, [text]);

  const newSession = useCallback(async () => {
    try {
      const r = await fetch("/api/persona/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project }) });
      if (r.ok) {
        const s = (await r.json()).session;
        await loadSessions();
        setActiveSession(s.key);
        hydratedRef.current = s.key;   // brand-new tab — nothing on disk to hydrate
        setTurns([]);
        inputRef.current?.focus();
      }
    } catch {}
  }, [project, loadSessions]);

  // Re-hydrate a tab's transcript from its persisted history (full turns if still
  // in the recent buffer, else its rolled-up summaries — clearly labeled).
  const loadSessionHistory = useCallback(async (key: string) => {
    try {
      const r = await fetch(`/api/persona/sessions?project=${encodeURIComponent(project)}&history=${key}`, { cache: "no-store" });
      if (!r.ok) { setTurns([]); return; }
      const data = await r.json() as {
        mode: "full" | "summary" | "empty";
        turns: { id: number; ts: string; prompt: string; reply: string; toolUses: string[]; kind?: "handoff" }[];
        summaries: { id: number; ts: string; text: string }[];
      };
      if (data.mode === "full" && data.turns.length) {
        const loaded: Turn[] = data.turns.map((t) => ({
          id: t.id, prompt: t.prompt, reply: t.reply, toolUses: t.toolUses ?? [],
          status: "done" as const, startedAt: new Date(t.ts).getTime() || Date.now(),
          kind: t.kind,
          suggestions: parseSuggestions(t.reply),
        }));
        // Keep new live turns from colliding with restored ids.
        turnSeqRef.current = Math.max(turnSeqRef.current, ...loaded.map((t) => t.id));
        setTurns(loaded);
      } else if (data.mode === "summary" && data.summaries.length) {
        // History rolled into long-term memory — show the distilled summaries.
        const loaded: Turn[] = data.summaries.map((s) => ({
          id: s.id, prompt: "(earlier — summarized)", reply: s.text,
          toolUses: [], status: "done" as const, startedAt: new Date(s.ts).getTime() || Date.now(),
        }));
        turnSeqRef.current = Math.max(turnSeqRef.current, ...loaded.map((t) => t.id));
        setTurns(loaded);
      } else {
        setTurns([]);
      }
    } catch { setTurns([]); }
  }, [project]);

  const switchSession = useCallback((key: string) => {
    if (key === activeSession) return;
    setActiveSession(key);
    hydratedRef.current = key;       // we load it here; don't let the mount effect double-load
    setHydrating(true);              // skeleton instead of the old tab's turns
    void loadSessionHistory(key).finally(() => setHydrating(false));
  }, [activeSession, loadSessionHistory]);

  const closeSession = useCallback(async (key: string) => {
    await fetch(`/api/persona/sessions?project=${encodeURIComponent(project)}&key=${key}`, { method: "DELETE" });
    await loadSessions();
  }, [project, loadSessions]);

  const commitRename = useCallback(async (key: string) => {
    const label = renameText.trim();
    setRenamingKey(null);
    if (!label) return;
    setSessions((ss) => ss.map((s) => s.key === key ? { ...s, label } : s));   // optimistic
    await fetch("/api/persona/sessions", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, key, label }) });
    await loadSessions();
  }, [renameText, project, loadSessions]);

  // ── Load projects ──
  const loadProjects = useCallback(async () => {
    setLoadingProjects(true);
    try {
      const res = await fetch("/api/projects", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects ?? []);
      }
    } catch {} finally { setLoadingProjects(false); }
  }, []);

  // ── Load briefing (recent tasks) ──
  const loadBriefing = useCallback(async () => {
    setLoadingBriefing(true);
    try {
      const res = await fetch(`/api/tasks?project=${project === WORKSPACE_KEY ? "" : project}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setRecentTasks((data.tasks ?? []).slice(0, 6));
      }
    } catch {} finally { setLoadingBriefing(false); }
  }, [project]);

  useEffect(() => {
    try { const v = localStorage.getItem(STORAGE_KEY); if (v) setText(v); } catch {}
    try { const p = localStorage.getItem(PROJECT_KEY); if (p) setProject(p); } catch {}
    // Deep link (e.g. a flow handoff from Mission Control): ?project=&session=
    // overrides the saved project and pre-selects the target tab. loadSessions
    // keeps a pre-set activeSession when it exists in the fetched list.
    try {
      const q = new URLSearchParams(window.location.search);
      const qp = q.get("project"), qs = q.get("session");
      if (qp) setProject(qp);
      if (qs) setActiveSession(qs);
      if (qp || qs) window.history.replaceState(null, "", window.location.pathname);
    } catch {}
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => { void loadBriefing(); }, [loadBriefing]);
  // Reload sessions + clear attachments when the project changes.
  useEffect(() => { setSessionsLoaded(false); void loadSessions(); setAttachments([]); hydratedRef.current = null; }, [loadSessions]);
  // Hydrate the active session's transcript from disk on mount/refresh (and when
  // the active session first resolves). Skips if a live turn is streaming.
  useEffect(() => {
    if (!activeSession || hydratedRef.current === activeSession) return;
    if (turns.some((t) => t.status === "streaming")) return;
    hydratedRef.current = activeSession;
    setHydrating(true);
    void loadSessionHistory(activeSession).finally(() => setHydrating(false));
  }, [activeSession, loadSessionHistory, turns]);
  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, text); } catch {} }, [text]);
  useEffect(() => { try { localStorage.setItem(PROJECT_KEY, project); } catch {} }, [project]);

  useEffect(() => {
    if (project !== WORKSPACE_KEY && project !== SELF_KEY && projects.length > 0 && !projects.some((p) => p.slug === project)) {
      setProject(WORKSPACE_KEY);
    }
  }, [projects, project]);

  // ── Whisper recording ──
  const stopMeter = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    analyserRef.current = null;
    if (audioCtxRef.current) { audioCtxRef.current.close().catch(() => {}); audioCtxRef.current = null; }
    setLevels(new Array(WAVE_BARS).fill(0));
  }, []);

  const startMeter = useCallback((stream: MediaStream) => {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.78;
      src.connect(analyser);
      analyserRef.current = analyser;
      const bins = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        const a = analyserRef.current;
        if (!a) return;
        a.getByteFrequencyData(bins);
        const next = new Array(WAVE_BARS).fill(0).map((_, i) => {
          const center = Math.abs(i - WAVE_BARS / 2) / (WAVE_BARS / 2);
          const bin = Math.floor((i / WAVE_BARS) * (bins.length * 0.7));
          const v = (bins[bin] ?? 0) / 255;
          return Math.max(0.06, v * (1 - center * 0.5));
        });
        setLevels(next);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {}
  }, []);

  const transcribe = useCallback(async (blob: Blob) => {
    setTranscribing(true);
    setVoiceError(null);
    try {
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: blob,
      });
      const data = await res.json().catch(() => ({ error: "Bad response" }));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const heard = (data?.text ?? "").trim();
      if (!heard) { setVoiceError("Didn't catch anything. Try speaking louder."); return; }
      setText((prev) => (!prev ? heard : prev.endsWith(" ") || prev.endsWith("\n") ? prev + heard : prev + " " + heard));
      setTimeout(() => inputRef.current?.focus(), 30);
    } catch (err) {
      setVoiceError((err as Error).message ?? "Transcription failed.");
    } finally { setTranscribing(false); }
  }, []);

  const startRecording = useCallback(async () => {
    if (recording || transcribing) return;
    setVoiceError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = (err as DOMException)?.name ?? "";
      setVoiceError(
        name === "NotAllowedError" ? "Mic blocked. Allow microphone access, then try again."
        : name === "NotFoundError" ? "No microphone detected."
        : `Mic error: ${(err as Error)?.message ?? name}`,
      );
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    startMeter(stream);
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      const duration = Date.now() - recordStartRef.current;
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
      stopMeter();
      setRecording(false);
      if (duration < MIN_RECORDING_MS) return;
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
      if (blob.size > 0) void transcribe(blob);
    };
    recorderRef.current = rec;
    recordStartRef.current = Date.now();
    rec.start();
    setRecording(true);
  }, [recording, transcribing, transcribe, startMeter, stopMeter]);

  const stopRecording = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec) return;
    if (rec.state !== "inactive") { try { rec.stop(); } catch {} }
  }, []);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    abortRef.current?.abort();
    stopMeter();
  }, [stopMeter]);

  // ── Claude SSE streaming ──
  const applyEvent = useCallback((turnId: number, event: string, data: unknown) => {
    // When Voice is on, tag a freshly-finished reply so its <ReplyVoice>
    // auto-plays (the single TTS engine; controls live on that reply).
    if (speakReplies && (event === "result" || event === "done")) setAutoPlayTurnId(turnId);

    setTurns((ts) => ts.map((t) => {
      if (t.id !== turnId) return t;
      switch (event) {
        case "text": return { ...t, reply: t.reply + ((data as { text?: string })?.text ?? ""), activity: "Writing reply..." };
        case "tool_use": {
          const name = (data as { name?: string })?.name ?? "tool";
          return { ...t, toolUses: [...t.toolUses, name], activity: `Running ${name}...` };
        }
        case "tool_result": return { ...t, activity: "Thinking..." };
        case "result": {
          const r = data as { isError?: boolean; text?: string };
          const reply = t.reply || r.text || "";
          return { ...t, status: r.isError ? "error" : "done", errorMessage: r.isError ? (r.text ?? "Error") : t.errorMessage, reply, activity: undefined, suggestions: parseSuggestions(reply) };
        }
        case "error": return { ...t, status: "error", errorMessage: (data as { message?: string })?.message ?? "Unknown error", activity: undefined };
        case "flow": return { ...t, flow: data as LaunchedFlow };   // Aria launched a multi-agent flow
        case "done": return t.status === "streaming" ? { ...t, status: "done", activity: undefined, suggestions: t.suggestions ?? parseSuggestions(t.reply) } : t;
        default: return t;
      }
    }));
  }, [speakReplies]);

  const sendToClaude = useCallback(async () => {
    const prompt = text.trim();
    if (!prompt && attachments.length === 0) return;
    if (turns.some((t) => t.status === "streaming")) return;
    const id = ++turnSeqRef.current;
    const sentAtts = attachments;
    const promptLabel = prompt || `(${sentAtts.length} attached file${sentAtts.length === 1 ? "" : "s"})`;
    stickToBottomRef.current = true;   // sending re-pins to the bottom
    setTurns((ts) => [...ts, { id, prompt: promptLabel, reply: "", toolUses: [], status: "streaming", startedAt: Date.now(), activity: "Starting..." }]);
    setText("");
    setAttachments([]);
    stopAllReaders();                          // stop any reply still being read aloud
    setAutoPlayTurnId(null);                   // the next finished reply gets tagged for auto-play

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let res: Response;
    try {
      res = await fetch("/api/persona/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt || "Review the attached file(s).", project, sessionKey: activeSession, attachments: sentAtts }),
        signal: ctrl.signal,
      });
    } catch (err) {
      setTurns((ts) => ts.map((t) => t.id === id ? { ...t, status: "error", errorMessage: (err as Error).message } : t));
      return;
    }
    if (!res.ok || !res.body) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
      setTurns((ts) => ts.map((t) => t.id === id ? { ...t, status: "error", errorMessage: msg } : t));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let currentEvent = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.startsWith("event: ")) { currentEvent = line.slice(7).trim(); continue; }
          if (!line.startsWith("data: ")) continue;
          let parsed: unknown;
          try { parsed = JSON.parse(line.slice(6)); } catch { continue; }
          applyEvent(id, currentEvent, parsed);
        }
      }
    } catch (err) {
      if ((err as DOMException)?.name !== "AbortError") {
        setTurns((ts) => ts.map((t) => t.id === id ? { ...t, status: "error", errorMessage: (err as Error).message } : t));
      }
    }
    // The turn may have created/updated the session (esp. the first turn) — refresh.
    void loadSessions();
    setMemoryRefresh((n) => n + 1);   // memory grew — refresh the panel if open
  }, [text, attachments, project, activeSession, turns, applyEvent, loadSessions]);

  const stopTurn = useCallback(() => {
    abortRef.current?.abort();
    setTurns((ts) => ts.map((t) => t.status === "streaming" ? { ...t, status: "done" } : t));
  }, []);

  // ── Scroll transcript ──
  // Only auto-follow the stream when the user is already at/near the bottom. If
  // they've scrolled up to read, leave them put (don't yank to the bottom on
  // every streamed chunk). Sending a message re-pins to the bottom.
  const onTranscriptScroll = useCallback(() => {
    const el = transcriptRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);
  useEffect(() => {
    const el = transcriptRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // ── Elapsed timer for active turn ──
  const hasActiveTurn = turns.some((t) => t.status === "streaming");
  const activeTurn = turns.find((t) => t.status === "streaming");
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!hasActiveTurn) return;
    const id = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [hasActiveTurn]);
  const elapsed = activeTurn ? Math.max(0, Math.floor((Date.now() - activeTurn.startedAt) / 1000)) : 0;
  const elapsedLabel = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;

  const canSend = (!!text.trim() || attachments.length > 0) && !hasActiveTurn;
  const greeting = PERSONA.greetings[timeOfDay()];
  const inConversation = turns.length > 0;
  // Initial-load state: sessions not fetched yet, or the active tab's history is
  // still coming off disk. Shows a skeleton instead of flashing the empty hero.
  const booting = !sessionsLoaded || hydrating ||
    (activeSession != null && hydratedRef.current !== activeSession && !turns.some((t) => t.status === "streaming"));

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendToClaude(); }
  };

  const micDown = (e: React.SyntheticEvent) => { e.preventDefault(); void startRecording(); };
  const micUp = (e: React.SyntheticEvent) => { e.preventDefault(); stopRecording(); };

  const onProjectChange = useCallback((slug: string) => {
    setProject(slug);
    setTurns([]);
    void loadBriefing();
  }, [loadBriefing]);

  return (
    <main
      className={cx("home-root", treePinned && "home-root--railed", reposPinned && "home-root--repos-railed")}
      onDragEnter={(e) => { e.preventDefault(); if (e.dataTransfer?.types?.includes("Files")) setDragging(true); }}
      onDragOver={(e) => { e.preventDefault(); }}
      onDragLeave={(e) => { if (e.relatedTarget === null || !(e.currentTarget as Node).contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer?.files?.length) void uploadFiles(e.dataTransfer.files); }}
    >
      {/* Hidden picker so the paperclip button can also attach files */}
      <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => { if (e.target.files) void uploadFiles(e.target.files); e.target.value = ""; }} />

      {/* Drag overlay */}
      {dragging && (
        <div className="home-drop" aria-hidden>
          <div className="home-drop__inner"><UploadCloud size={40} /> Drop files to attach to {projectName}</div>
        </div>
      )}

      {/* File tree — docked left rail (hover to peek, pin to keep open) */}
      <FileTreeRail project={project} projectName={projectName} onPinnedChange={setTreePinned} onPick={(rel) => { setAttachments((p) => p.some((a) => a.relPath === rel) ? p : [...p, { relPath: rel, name: rel.split("/").pop() || rel }]); inputRef.current?.focus(); }} />
      {/* Connected repositories — docked right rail with live git state */}
      <ReposRail onPinnedChange={setReposPinned} onPrompt={(t) => { setText(t); inputRef.current?.focus(); }} />
      <ActivityDrawer open={activityOpen} project={project} projectName={projectName} tasks={recentTasks} activeSessionKey={activeSession} onClose={() => setActivityOpen(false)} onOpenSession={(k) => { switchSession(k); }} onPickUp={(t) => { setText(t); inputRef.current?.focus(); }} />
      <PersonaMemoryDrawer open={memoryOpen} onClose={() => setMemoryOpen(false)} refreshKey={memoryRefresh} project={project} projectName={projectName} />

      {/* Background mist — same motif as the Companion sheet */}
      <div className="home-mist" aria-hidden>
        <div className="aria-blob aria-blob--violet" />
        <div className="aria-blob aria-blob--crimson" />
        <div className="aria-blob aria-blob--indigo" />
        <div className="aria-blob aria-blob--rose" />
        <div className="aria-blob aria-blob--core" />
        <div className="aria-blob aria-blob--azure" />
        <div className="aria-blob aria-blob--magenta" />
      </div>
      <div className="home-wash" aria-hidden />

      <div className="home-content">
        {/* Top bar */}
        <header className="home-header">
          <div className="home-header__left">
            <span className="home-header__orb" aria-hidden>
              <span className="home-header__orb-ring" />
              <Sparkles size={18} />
            </span>
            <span className="home-header__name">{PERSONA.name}</span>
          </div>
          <div className="home-header__right">
            <div className={cx("home-voicegroup", speakReplies && "home-voicegroup--on")}>
              <button
                className={cx("home-voicegroup__toggle", speakReplies && "home-voicegroup__toggle--on")}
                onClick={() => setSpeakReplies((v) => !v)}
                title={speakReplies ? "Voice on — replies are read aloud; click to mute" : "Read replies aloud"}
              >
                {speakReplies ? <Volume2 size={15} /> : <VolumeX size={15} />} Voice
              </button>
              {speakReplies && (
                <select
                  className="home-voicegroup__select"
                  value={voice}
                  title="Pick the reading voice (Kokoro) — previews on change"
                  aria-label="Reading voice"
                  onChange={(e) => { const v = e.target.value; setVoice(v); setVoiceState(v); void previewVoice(v); }}
                >
                  {VOICE_GROUPS.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.voices.map((vo) => <option key={vo.id} value={vo.id}>{vo.label}</option>)}
                    </optgroup>
                  ))}
                </select>
              )}
            </div>
            <button className="home-tool-btn" onClick={() => setMemoryOpen(true)} title={`${PERSONA.name}'s memory — core, persistent & this project's recent/mid/long`}><Brain size={15} /> Memory</button>
            <button className="home-tool-btn" onClick={() => setActivityOpen(true)} title="Archive — all sessions & recent activity"><Clock size={15} /> Archive</button>
            <a href="/tasks" className="home-nav-btn" title="Mission Control">
              <GitBranch size={15} /> Mission Control
            </a>
            <StatusBar />
            <ThemeToggle />
          </div>
        </header>

        {/* Project selector — VERY TOP, under the header */}
        <div className="home-projsel">
          <span className="home-projsel__label"><FolderTree size={12} /> Project</span>
          <div className="home-projsel__pills">
            <button
              className={cx("home-projpill", "home-projpill--self", project === SELF_KEY && "home-projpill--active")}
              onClick={() => onProjectChange(SELF_KEY)}
              title={`Edit ${PERSONA.name}'s own source code — point the agent at this system's repo`}
            >
              <Wrench size={12} /> {PERSONA.name} source
            </button>
            <button
              className={cx("home-projpill", project === WORKSPACE_KEY && "home-projpill--active")}
              onClick={() => onProjectChange(WORKSPACE_KEY)}
            >
              All projects
            </button>
            {projects.map((p) => (
              <button
                key={p.slug}
                className={cx("home-projpill", project === p.slug && "home-projpill--active")}
                onClick={() => onProjectChange(p.slug)}
                title={p.path}
              >
                {p.name}
              </button>
            ))}
            {loadingProjects && projects.length === 0 && (
              <>
                <span className="home-skel home-skel--pill" aria-hidden />
                <span className="home-skel home-skel--pill" aria-hidden />
              </>
            )}
          </div>
          <button className="home-rescan" onClick={() => void loadProjects()} title="Rescan workspace">
            {loadingProjects ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
        </div>

        {/* Session tabs — the CONTAINER of the conversation. Each is its own
            claude session; all feed memory. Double-click to rename. */}
        <div className="home-tabsrow">
          {/* Scrollable strip — only the session tabs scroll horizontally */}
          <div className="home-tabs">
            {!sessionsLoaded && (
              <>
                <span className="home-skel home-skel--tab" aria-hidden />
                <span className="home-skel home-skel--tab" aria-hidden />
              </>
            )}
            {sessionsLoaded && sessions.map((s) => (
              renamingKey === s.key ? (
                <span key={s.key} className="home-tab home-tab--active">
                  <input
                    className="home-tab__input"
                    value={renameText}
                    autoFocus
                    onChange={(e) => setRenameText(e.target.value)}
                    onBlur={() => void commitRename(s.key)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commitRename(s.key); } if (e.key === "Escape") setRenamingKey(null); }}
                  />
                  <span className="home-tab__rename-ok" role="button" tabIndex={0} title="Save" onMouseDown={(e) => { e.preventDefault(); void commitRename(s.key); }}><Check size={11} /></span>
                </span>
              ) : (
                <span
                  key={s.key}
                  className={cx("home-tab", s.key === activeSession && "home-tab--active")}
                  role="button" tabIndex={0}
                  title="Click to switch · double-click to rename"
                  onClick={() => switchSession(s.key)}
                  onDoubleClick={() => { setRenamingKey(s.key); setRenameText(s.label); }}
                  onKeyDown={(e) => { if (e.key === "Enter") switchSession(s.key); if (e.key === "F2") { setRenamingKey(s.key); setRenameText(s.label); } }}
                >
                  <span className="home-tab__name">{s.label}</span>
                  {sessions.length > 1 && (
                    <span className="home-tab__close" role="button" tabIndex={0} title="Close session" onClick={(e) => { e.stopPropagation(); void closeSession(s.key); }} onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); void closeSession(s.key); } }}><X size={11} /></span>
                  )}
                </span>
              )
            ))}
          </div>
          {/* Pinned trailing controls — never scroll out of view */}
          <div className="home-tabs__pinned">
            <button className="home-tab home-tab--add" onClick={() => void newSession()} title="New session (own context, shared memory)"><Plus size={12} /> New</button>
            {sessionsLoaded && sessions.length > 0 && (
              <div className="home-tabpick" ref={tabPickerRef}>
                <button
                  className={cx("home-tab home-tab--more", pickerOpen && "home-tab--more-on")}
                  aria-haspopup="menu" aria-expanded={pickerOpen}
                  onClick={() => setPickerOpen((o) => !o)}
                  title="All tabs — jump to any session"
                >
                  <ChevronDown size={14} />
                </button>
                {pickerOpen && (
                  <div className="home-tabpick__menu" role="menu">
                    <div className="home-tabpick__head">{sessions.length} session{sessions.length === 1 ? "" : "s"}</div>
                    {sessions.map((s) => (
                      <button
                        key={s.key}
                        role="menuitem"
                        className={cx("home-tabpick__item", s.key === activeSession && "home-tabpick__item--active")}
                        onClick={() => { switchSession(s.key); setPickerOpen(false); }}
                      >
                        <span className="home-tabpick__name">{s.label}</span>
                        {s.key === activeSession && <Check size={12} />}
                      </button>
                    ))}
                    <button className="home-tabpick__all" role="menuitem" onClick={() => { setPickerOpen(false); setActivityOpen(true); }}>
                      <MoreHorizontal size={13} /> Open archive (all sessions)
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Tab panel: holds this session's conversation + input ── */}
        <div className={cx("home-conv", inConversation && "home-conv--active")}>
          {booting ? (
            /* Loading: session history is coming off disk — don't flash the hero */
            <div className="home-convskel" aria-hidden>
              <span className="home-skel home-skel--bubble" style={{ alignSelf: "flex-end", width: "42%" }} />
              <span className="home-skel home-skel--line" style={{ width: "78%" }} />
              <span className="home-skel home-skel--line" style={{ width: "64%" }} />
              <span className="home-skel home-skel--line" style={{ width: "70%" }} />
            </div>
          ) : !inConversation ? (
            /* Hero greeting — shown when no conversation yet */
            <div className="home-hero">
              <h1 className="home-hero__greeting">{greeting}</h1>
              <p className="home-hero__sub">
                Talk to me about {projectName}. I have full tool access and can reach across your whole workspace.
              </p>
            </div>
          ) : (
            /* Scrollable transcript */
            <div ref={transcriptRef} className="home-transcript" onScroll={onTranscriptScroll}>
              {turns.map((t) => (
                <div key={t.id} className="aria-turn">
                  {t.kind === "handoff"
                    ? <div className="aria-handoff"><GitBranch size={13} /> Carried over from Mission Control</div>
                    : <div className="aria-bubble">{t.prompt}</div>}
                  {t.toolUses.length > 0 && (
                    <div className="aria-tools">
                      {t.toolUses.map((name, i) => (
                        <span key={`${t.id}-${i}`} className="aria-toolchip"><span style={{ fontSize: 9 }}>&#x1F527;</span> {name}</span>
                      ))}
                    </div>
                  )}
                  {(t.reply || t.status === "streaming") && (
                    <AssistantReply turn={t} autoPlay={t.id === autoPlayTurnId} onPick={(p) => { setText(p); inputRef.current?.focus(); }} />
                  )}
                  {t.status === "error" && (
                    <div className="aria-err">
                      <AlertCircle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
                      <span>{t.errorMessage ?? "Something went wrong."}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Task-in-progress indicator */}
          {activeTurn && (
            <div className="aria-task" style={{ margin: "0 0 8px" }}>
              <span className="aria-task__pulse"><Activity size={13} /></span>
              <div className="aria-task__body">
                <div className="aria-task__title">{activeTurn.activity ?? "Working..."}</div>
                <div className="aria-task__sub">
                  {activeTurn.prompt.length > 80 ? activeTurn.prompt.slice(0, 80) + "..." : activeTurn.prompt}
                </div>
              </div>
              {activeTurn.toolUses.length > 0 && (
                <span className="aria-task__count">{activeTurn.toolUses.length} tool{activeTurn.toolUses.length === 1 ? "" : "s"}</span>
              )}
              <span className="aria-task__time">{elapsedLabel}</span>
              <button className="aria-task__stop" onClick={stopTurn}><Square size={11} fill="currentColor" /> Stop</button>
            </div>
          )}

          {/* ── Input bar (inside the tab panel) ── */}
          <div className="home-input-wrap">
            {/* Suggestions for a fresh session */}
            {!inConversation && (
              <div className="home-suggest">
                {QUICK_PROMPTS.slice(0, 4).map((p) => (
                  <button key={p.label} className="aria-chip" onClick={() => { setText(p.prompt); inputRef.current?.focus(); }}>
                    {p.label}
                  </button>
                ))}
              </div>
            )}

            {/* Attachment chips */}
            {(attachments.length > 0 || uploading) && (
              <div className="home-atts">
                {attachments.map((a) => (
                  <span key={a.relPath} className="home-att">
                    <FileText size={12} />
                    <span className="home-att__name">{a.name}</span>
                    <button className="home-att__x" onClick={() => removeAttachment(a.relPath)} aria-label="Remove"><X size={11} /></button>
                  </span>
                ))}
                {uploading && <span className="home-att home-att--uploading"><Loader2 size={11} className="animate-spin" /> uploading…</span>}
              </div>
            )}

            <div className={cx("aria-bar", recording && "aria-bar--recording", hasActiveTurn && "aria-bar--locked")}>
              {recording ? (
                <div className="aria-voice" aria-label="Listening">
                  {levels.map((v, i) => (
                    <span key={i} style={{ height: `${Math.round(4 + v * 30)}px` }} />
                  ))}
                </div>
              ) : transcribing ? (
                <span className="aria-bar__transcribed"><Loader2 size={13} className="animate-spin" style={{ display: "inline", verticalAlign: "-2px", marginRight: 6 }} /> Transcribing...</span>
              ) : (
                <textarea
                  ref={inputRef}
                  className="aria-bar__input"
                  rows={1}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={onKeyDown}
                  disabled={hasActiveTurn}
                  placeholder={hasActiveTurn ? `${PERSONA.name} is working...` : `Ask ${PERSONA.name} anything...`}
                  autoFocus
                />
              )}
              <div className="aria-bar__actions">
                {!transcribing && !hasActiveTurn && (
                  <button className="aria-bar__btn" title="Attach a file" onClick={() => fileInputRef.current?.click()} aria-label="Attach file">
                    <Paperclip size={16} />
                  </button>
                )}
                {!transcribing && !hasActiveTurn && (
                  <button
                    className={cx("aria-bar__btn", recording && "aria-bar__btn--rec")}
                    title={recording ? "Release to transcribe" : "Hold to talk"}
                    onMouseDown={micDown} onMouseUp={micUp}
                    onMouseLeave={(e) => { if (recording) micUp(e); }}
                    onTouchStart={micDown} onTouchEnd={micUp} onTouchCancel={micUp}
                    aria-pressed={recording} aria-label="Hold to talk"
                  >
                    <Mic size={17} />
                  </button>
                )}
                {hasActiveTurn ? (
                  <button className="aria-bar__send aria-bar__send--active" onClick={stopTurn} title="Stop"><Square size={14} fill="currentColor" /></button>
                ) : (
                  <button className={cx("aria-bar__send", canSend && "aria-bar__send--active")} onClick={() => void sendToClaude()} disabled={!canSend} title="Send" aria-label="Send">
                    <ArrowUp size={18} />
                  </button>
                )}
              </div>
            </div>

            {voiceError && (
              <div className="home-voice-err"><AlertCircle size={12} /> {voiceError}</div>
            )}

            <div className="home-input-meta">
              {recording ? (
                <><span className="aria-meta__dot aria-meta__dot--rec" /> Listening... release to transcribe</>
              ) : (
                <span>Enter to send &middot; Shift+Enter for newline &middot; Hold mic for voice</span>
              )}
              {turns.length > 0 && !recording && !hasActiveTurn && (
                <button className="aria-meta__link" onClick={() => setTurns([])} style={{ marginLeft: 8 }}>New chat</button>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

function formatAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

// One assistant reply: the rendered answer + flow link + next-step cards + the
// voice controls, all sharing a SINGLE useReader so the karaoke highlight paints
// on the ANSWER TEXT itself (not a separate caption). While reading, the reply
// renders as its spoken sentences with the active sentence + word lit up; idle,
// it renders normal Markdown. Action markers are stripped inside the reader, and
// readers are globally exclusive so auto-play and a manual Listen never overlap.
function AssistantReply({ turn, autoPlay, onPick }: { turn: Turn; autoPlay: boolean; onPick: (prompt: string) => void }) {
  const { status, currentTime, duration, buffering, sentenceList, activeIndex, activeFraction, play, pause, resume, stop, seek } = useReader();
  const seekingRef = useRef(false);
  const [scrub, setScrub] = useState<number | null>(null);   // local value while dragging
  const didAutoRef = useRef(false);
  const replyRef = useRef<HTMLDivElement | null>(null);      // the rendered (formatted) answer
  const textMapRef = useRef<{ reply: string; map: TextMap } | null>(null);
  const ownsHlRef = useRef(false);                            // did THIS instance set the global highlights?
  const lastIdxRef = useRef(-1);
  const [detailsOpen, setDetailsOpen] = useState(false);      // "More details" expander
  const reply = turn.reply;
  const streaming = turn.status === "streaming";

  // Voice-first: the [[SUMMARY]] recap is the default visible + spoken reply; the
  // fuller detail the agent wrote sits behind "More details". No summary block
  // (old turns / agent omitted it) → fall back to the whole reply.
  const summary = extractSummary(reply);
  const detail = summary ? stripSuggestions(stripSummaryBlock(reply)) : "";
  const hasDetail = !!summary && detail.length > 0 && detail !== summary.trim();
  const spoken = summary || stripSuggestions(reply);          // what the reader speaks
  const visible = streaming
    ? stripSuggestions(reply)                                  // show the live text while streaming
    : summary
      ? (detailsOpen ? detail : stripSuggestions(summary))
      : stripSuggestions(reply);

  // Auto-play exactly once when this reply is tagged (Voice on + just finished).
  useEffect(() => {
    if (autoPlay && !didAutoRef.current && spoken.trim()) { didAutoRef.current = true; void play(spoken); }
  }, [autoPlay, spoken, play]);

  const playing = status === "playing";
  const active = status !== "idle";                 // loading | playing | paused
  const reading = active && status !== "loading" && activeIndex >= 0 && sentenceList.length > 0;

  // Karaoke ON the formatted answer: paint the spoken sentence + word as CSS
  // Custom Highlights over the live Markdown DOM — no DOM swap, so all formatting
  // stays intact. Maps the reader's (markdown-stripped) sentence back to a DOM
  // text Range; gracefully no-ops if the API is unsupported or the text (e.g. a
  // code block) doesn't align. Only the instance that set the highlights clears
  // them (readers are globally exclusive, so just one is reading at a time).
  useEffect(() => {
    if (!supportsHighlight()) return;
    if (!reading || !replyRef.current) {
      if (ownsHlRef.current) { clearSpokenHighlights(); ownsHlRef.current = false; lastIdxRef.current = -1; }
      return;
    }
    ensureHighlightStyles();
    if (!textMapRef.current || textMapRef.current.reply !== visible) {
      textMapRef.current = { reply: visible, map: buildTextMap(replyRef.current) };
    }
    const tm = textMapRef.current.map;
    const ok = applySpokenHighlights(tm, sentenceList, activeIndex, activeFraction);
    ownsHlRef.current = ok;
    if (ok && activeIndex !== lastIdxRef.current) {
      lastIdxRef.current = activeIndex;
      scrollSentenceIntoView(tm, sentenceList, activeIndex);
    }
  }, [reading, visible, sentenceList, activeIndex, activeFraction]);

  // Clear highlights if this instance unmounts mid-read.
  useEffect(() => () => { if (ownsHlRef.current) clearSpokenHighlights(); }, []);

  const fmt = (s: number) => { const m = Math.floor(s / 60); const r = Math.floor(s % 60); return `${m}:${String(r).padStart(2, "0")}`; };
  const cur = scrub ?? currentTime;
  const hasTimeline = active && status !== "loading" && duration > 0;

  return (
    <div className="aria-reply">
      {/* The answer stays fully formatted at all times; the spoken sentence/word
          is painted over it via CSS Custom Highlights (see the effect above). */}
      <div ref={replyRef} className="aria-reply__md">
        <Markdown>{visible}</Markdown>
        {streaming && reply && <span className="aria-caret" />}
      </div>
      {hasDetail && !streaming && (
        <button className="reply-more" onClick={() => setDetailsOpen((o) => !o)} aria-expanded={detailsOpen}>
          <ChevronDown size={13} style={{ transform: detailsOpen ? "rotate(180deg)" : undefined, transition: "transform .15s" }} />
          <span>{detailsOpen ? "Hide details" : "More details"}</span>
        </button>
      )}

      {/* A multi-agent flow Aria launched from this turn */}
      {turn.flow && (
        turn.flow.error
          ? <div className="aria-err" style={{ marginTop: 8 }}><AlertCircle size={12} style={{ marginTop: 1, flexShrink: 0 }} /><span>{turn.flow.error}</span></div>
          : (
            <a className="reply-flow" href="/tasks" title="Open Mission Control to watch the flow run">
              <GitBranch size={13} />
              <span className="reply-flow__label">Flow launched{turn.flow.stepCount ? ` · ${turn.flow.stepCount} steps` : ""}</span>
              <span className="reply-flow__goal">{turn.flow.goal}</span>
              <ArrowRight size={12} />
            </a>
          )
      )}

      {/* Clickable next-step suggestions — title + full prompt. The "more details"
          action (which unlocks the full written breakdown past the SUMMARY-only
          reply) is pulled out and rendered as a compact inline pill at the very
          bottom, not a full card. */}
      {!streaming && (() => {
        const all = turn.suggestions ?? [];
        const moreIdx = all.findIndex(isMoreDetails);
        const more = moreIdx >= 0 ? all[moreIdx] : null;
        const cards = moreIdx >= 0 ? all.filter((_, i) => i !== moreIdx) : all;
        return (
          <>
            {cards.length > 0 && (
              <div className="reply-next">
                <span className="reply-next__label">Next steps</span>
                <div className="reply-next__chips">
                  {cards.map((s, i) => (
                    <button key={i} className="reply-next__chip" title={`Run: ${s.prompt}`} onClick={() => onPick(s.prompt)}>
                      <span className="reply-next__head"><span className="reply-next__title">{s.label}</span><ArrowRight size={13} /></span>
                      <span className="reply-next__desc">{s.prompt}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* Re-ask "More details" only when there's no inline detail to expand
                (the reply was concise); otherwise the inline expander above covers it. */}
            {more && !hasDetail && (
              <button className="reply-more" title={`Run: ${more.prompt}`} onClick={() => onPick(more.prompt)}>
                <ChevronDown size={13} />
                <span>{more.label}</span>
              </button>
            )}
          </>
        );
      })()}

      {/* Voice controls — Listen / synthesizing / play-pause-stop + scrub timeline */}
      {reply && !streaming && (
        <div className="reply-voice">
          {!active ? (
            <button className="reply-voice__btn" onClick={() => void play(reply)} title="Read aloud"><Volume2 size={13} /> Listen</button>
          ) : status === "loading" ? (
            <span className="reply-voice__btn reply-voice__btn--on"><Loader2 size={13} className="animate-spin" /> Synthesizing…</span>
          ) : (
            <>
              {playing
                ? <button className="reply-voice__btn reply-voice__btn--on" onClick={pause} title="Pause"><Pause size={13} /></button>
                : <button className="reply-voice__btn reply-voice__btn--on" onClick={resume} title="Play"><Play size={13} fill="currentColor" /></button>}
              <button className="reply-voice__btn" onClick={stop} title="Stop"><Square size={11} fill="currentColor" /></button>
              {hasTimeline ? (
                <div className="reply-voice__timeline">
                  <span className="reply-voice__time">{fmt(cur)}</span>
                  <input
                    className="reply-voice__scrub"
                    type="range" min={0} max={Math.max(duration, 0.1)} step={0.05} value={Math.min(cur, duration)}
                    onMouseDown={() => { seekingRef.current = true; }}
                    onMouseUp={() => { seekingRef.current = false; if (scrub != null) { seek(scrub); setScrub(null); } }}
                    onChange={(e) => { const v = parseFloat(e.target.value); setScrub(v); if (!seekingRef.current) { seek(v); setScrub(null); } }}
                    style={{ ["--pct" as string]: `${duration ? (cur / duration) * 100 : 0}%` }}
                    aria-label="Seek"
                  />
                  <span className="reply-voice__time">{fmt(duration)}{buffering && "…"}</span>
                </div>
              ) : (
                <span className="reply-voice__wave" aria-hidden><i /><i /><i /></span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Karaoke-over-Markdown via the CSS Custom Highlight API ──
// We highlight the spoken sentence/word IN PLACE on the rendered (formatted)
// answer by mapping the reader's plain-text chunk back to a DOM text Range.
// No DOM mutation — formatting (bold/lists/links/code) stays untouched.

type TextMap = {
  nodes: { node: Text; start: number; end: number }[];   // each text node's span in `text`
  norm: string;                                           // whitespace-collapsed, lowercased
  map: number[];                                          // norm index → original `text` index
};

// Walk the rendered answer's text nodes into one string + a normalized view.
function buildTextMap(root: HTMLElement): TextMap {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = "";
  const nodes: TextMap["nodes"] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = (n as Text).nodeValue || "";
    if (!t) continue;
    nodes.push({ node: n as Text, start: text.length, end: text.length + t.length });
    text += t;
  }
  let norm = "";
  const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) { if (prevSpace) continue; norm += " "; map.push(i); prevSpace = true; }
    else { norm += c.toLowerCase(); map.push(i); prevSpace = false; }
  }
  return { nodes, norm, map };
}

const normChunk = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

// Locate the activeIndex-th spoken chunk inside the DOM text → original char span.
function locateSentence(tm: TextMap, sentences: string[], idx: number): { start: number; end: number; normStart: number } | null {
  const target = normChunk(sentences[idx] ?? "");
  if (!target) return null;
  let hint = 0;                                  // search near where prior chunks end (handles repeats/seeks)
  for (let i = 0; i < idx; i++) hint += normChunk(sentences[i] ?? "").length + 1;
  hint = Math.max(0, Math.min(hint - 40, tm.norm.length));
  let pos = tm.norm.indexOf(target, hint);
  if (pos < 0) pos = tm.norm.indexOf(target);    // fallback: anywhere
  if (pos < 0) return null;
  const start = tm.map[pos];
  const end = tm.map[Math.min(pos + target.length - 1, tm.map.length - 1)] + 1;
  return { start, end, normStart: pos };
}

// The active word's [start,end) within the normalized chunk (time-interpolated).
// Returns the LAST word whose start has passed the cursor, so a word stays lit
// through the space before the next one begins (no flicker between words).
function activeWordSpan(norm: string, fraction: number): { s: number; e: number } | null {
  const cursor = Math.max(0, Math.min(1, fraction)) * (norm.length || 1);
  let pos = 0;
  let best: { s: number; e: number } | null = null;
  for (const tok of norm.split(/(\s+)/)) {
    const start = pos; pos += tok.length;
    if (/^\s+$/.test(tok) || !tok) continue;
    if (start <= cursor) best = { s: start, e: pos };   // last word that has started
    else break;                                          // tokens are in order
  }
  return best;
}

function rangeFromOffsets(tm: TextMap, start: number, end: number): Range | null {
  if (start == null || end == null || end <= start) return null;
  const r = document.createRange();
  let setS = false, setE = false;
  for (const seg of tm.nodes) {
    if (!setS && start >= seg.start && start < seg.end) { r.setStart(seg.node, start - seg.start); setS = true; }
    if (end > seg.start && end <= seg.end) { r.setEnd(seg.node, end - seg.start); setE = true; break; }
  }
  return setS && setE ? r : null;
}

// The ::highlight() pseudo styles are injected at runtime — the build-time CSS
// parser rejects ::highlight(), but the browser understands it fine. Pseudos
// only allow color/background-color/text-decoration/text-shadow.
let highlightStylesInjected = false;
function ensureHighlightStyles() {
  if (highlightStylesInjected || typeof document === "undefined") return;
  highlightStylesInjected = true;
  const el = document.createElement("style");
  el.setAttribute("data-daryan-highlights", "");
  el.textContent =
    "::highlight(daryan-spoken-sentence){background-color:rgba(124,44,255,0.18);}" +
    "::highlight(daryan-spoken-word){background-color:#8c3cff;color:#fff;text-shadow:0 1px 6px rgba(124,44,255,0.55);}";
  document.head.appendChild(el);
}

type HighlightCtor = new (...ranges: Range[]) => unknown;
type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
const highlightRegistry = (): HighlightRegistry | null =>
  (typeof CSS !== "undefined" && (CSS as unknown as { highlights?: HighlightRegistry }).highlights) || null;
function supportsHighlight(): boolean {
  return typeof window !== "undefined" && "Highlight" in window && !!highlightRegistry();
}
function setHighlight(name: string, range: Range) {
  try {
    const H = (window as unknown as { Highlight: HighlightCtor }).Highlight;
    highlightRegistry()?.set(name, new H(range));
  } catch {}
}
const clearHighlight = (name: string) => { try { highlightRegistry()?.delete(name); } catch {} };
const clearSpokenHighlights = () => { clearHighlight("daryan-spoken-sentence"); clearHighlight("daryan-spoken-word"); };

// Paint sentence + word highlights for the current spoken position. Returns
// false (and clears) if the chunk can't be mapped onto the DOM.
function applySpokenHighlights(tm: TextMap, sentences: string[], idx: number, fraction: number): boolean {
  const loc = locateSentence(tm, sentences, idx);
  const sentRange = loc && rangeFromOffsets(tm, loc.start, loc.end);
  if (!loc || !sentRange) { clearSpokenHighlights(); return false; }
  setHighlight("daryan-spoken-sentence", sentRange);
  const w = activeWordSpan(normChunk(sentences[idx] ?? ""), fraction);
  const wr = w && rangeFromOffsets(tm, tm.map[loc.normStart + w.s], tm.map[Math.min(loc.normStart + w.e - 1, tm.map.length - 1)] + 1);
  if (wr) setHighlight("daryan-spoken-word", wr); else clearHighlight("daryan-spoken-word");
  return true;
}

function scrollSentenceIntoView(tm: TextMap, sentences: string[], idx: number) {
  const loc = locateSentence(tm, sentences, idx);
  if (!loc) return;
  const r = rangeFromOffsets(tm, loc.start, Math.min(loc.end, loc.start + 1));
  r?.startContainer.parentElement?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
