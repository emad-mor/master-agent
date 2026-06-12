"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, Mic, ArrowUp, GitBranch, Clock, ArrowRight, AlertCircle, FolderTree, MoreHorizontal, RefreshCw, Loader2, Square, Activity, Paperclip, X, Plus, UploadCloud, FileText, Check, Volume2, VolumeX, Play, Pause, Brain } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { cx } from "@/lib/format";
import { PERSONA, timeOfDay, QUICK_PROMPTS } from "@/components/persona/persona-config";
import { FileTreeRail } from "@/components/home/file-tree";
import { ActivityDrawer } from "@/components/home/activity-drawer";
import { PersonaMemoryDrawer } from "@/components/persona/persona-memory-drawer";
import { Markdown } from "@/components/persona/markdown";
import "@/components/persona/companion.css";

/* ────────────────────────────────────────────────────────────
   Aria Agent-First Homepage
   Conversation front-and-center + briefing panel.
   ──────────────────────────────────────────────────────────── */

const STORAGE_KEY = "aria.lastDraft";
const PROJECT_KEY = "aria.activeProject";
const SPEAK_KEY = "aria.speakReplies";
const WORKSPACE_KEY = "__workspace__";
const SENTENCE_END = /([.!?]+\s+|\n{2,})/;
// Strip markdown/emoji so TTS reads prose, not syntax.
function cleanForSpeech(s: string): string {
  return s
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/gu, "")
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*?([^*]+)\*\*?/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*|]\s+/gm, "")
    .replace(/^\s*#+\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
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
    .replace(/\[\[\s*(NEXT|FLOW)\b[^\]]*\]\]/gi, "")   // complete markers
    .replace(/\[\[\s*(NEXT|FLOW)\b[\s\S]*$/i, "")       // partial trailing marker while streaming
    .replace(/\n?\s*-{3,}\s*$/g, "")                     // trailing --- separator
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export default function Home() {
  // ── Conversation state ──
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const turnSeqRef = useRef(0);
  const hydratedRef = useRef<string | null>(null);   // which session's history is loaded
  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
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

  // ── Voice OUT (TTS) — auto-speak replies + playback controls ──
  const [speakReplies, setSpeakReplies] = useState(false);
  const [ttsPlayback, setTtsPlayback] = useState<"idle" | "playing" | "paused">("idle");
  const [speakingTurn, setSpeakingTurn] = useState<number | null>(null);
  const [ttsEngine, setTtsEngine] = useState<"kokoro" | "browser" | "checking">("checking");
  const speakSupportedRef = useRef(typeof window !== "undefined" && "speechSynthesis" in window);
  const browserVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const speakBufRef = useRef("");                  // un-spoken streamed tail
  const audioQueueRef = useRef<string[]>([]);      // queued kokoro blob URLs
  const audioPlayingRef = useRef(false);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const speechSessionRef = useRef(0);              // bump to cancel in-flight speech

  // ── Attachments (any dropped file: image / text / doc) ──
  // Saved server-side into the project's .aria-drops/ and referenced by path so
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
  const [activityOpen, setActivityOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryRefresh, setMemoryRefresh] = useState(0);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");

  // ── Briefing state ──
  const [recentTasks, setRecentTasks] = useState<TaskInfo[]>([]);
  const [loadingBriefing, setLoadingBriefing] = useState(true);

  const projectName = project === WORKSPACE_KEY
    ? "All projects"
    : projects.find((p) => p.slug === project)?.name ?? project;

  // ── Upload dropped/picked files to the active project's .aria-drops ──
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

  // ── TTS engine: Kokoro (/api/speak) with browser speechSynthesis fallback ──
  // Restore the speak-replies preference + probe the engine + pick a browser voice.
  useEffect(() => { try { if (localStorage.getItem(SPEAK_KEY) === "1") setSpeakReplies(true); } catch {} }, []);
  useEffect(() => { try { localStorage.setItem(SPEAK_KEY, speakReplies ? "1" : "0"); } catch {}; if (!speakReplies) { /* stop on mute */ stopSpeech(); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [speakReplies]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "." }) });
        if (!cancelled) setTtsEngine(res.ok ? "kokoro" : "browser");
      } catch { if (!cancelled) setTtsEngine("browser"); }
    })();
    if (speakSupportedRef.current) {
      const pick = () => {
        const voices = window.speechSynthesis.getVoices();
        if (!voices.length) return;
        browserVoiceRef.current =
          voices.find((v) => /Aria|Sonia|Jenny|Samantha/i.test(v.name) && /en/i.test(v.lang)) ||
          voices.find((v) => /en-US|en-GB/i.test(v.lang)) || voices[0] || null;
      };
      pick();
      window.speechSynthesis.addEventListener("voiceschanged", pick);
      return () => { cancelled = true; window.speechSynthesis.removeEventListener("voiceschanged", pick); };
    }
    return () => { cancelled = true; };
  }, []);

  const playNextAudio = useCallback(() => {
    if (audioPlayingRef.current) return;
    const next = audioQueueRef.current.shift();
    if (!next) { if (!audioPlayingRef.current) setTtsPlayback((p) => p === "playing" ? "idle" : p); return; }
    audioPlayingRef.current = true;
    setTtsPlayback("playing");
    const audio = audioElRef.current ?? new Audio();
    audioElRef.current = audio;
    audio.src = next;
    const after = () => { URL.revokeObjectURL(next); audioPlayingRef.current = false; if (audioQueueRef.current.length) playNextAudio(); else setTtsPlayback("idle"); };
    audio.onended = after;
    audio.onerror = after;
    audio.play().catch(() => { audioPlayingRef.current = false; });
  }, []);

  const enqueueKokoro = useCallback(async (sentence: string, token: number) => {
    const clean = cleanForSpeech(sentence);
    if (!clean) return;
    try {
      const res = await fetch("/api/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: clean }) });
      if (token !== speechSessionRef.current || !res.ok) return;
      const blob = await res.blob();
      if (token !== speechSessionRef.current) return;
      audioQueueRef.current.push(URL.createObjectURL(blob));
      playNextAudio();
    } catch {}
  }, [playNextAudio]);

  const browserSpeak = useCallback((sentence: string) => {
    if (!speakSupportedRef.current) return;
    const clean = cleanForSpeech(sentence);
    if (!clean) return;
    const u = new SpeechSynthesisUtterance(clean);
    u.rate = 1.05;
    if (browserVoiceRef.current) { u.voice = browserVoiceRef.current; u.lang = browserVoiceRef.current.lang; }
    u.onstart = () => setTtsPlayback("playing");
    u.onend = () => { if (!window.speechSynthesis.pending && !window.speechSynthesis.speaking) setTtsPlayback("idle"); };
    window.speechSynthesis.speak(u);
  }, []);

  const speakSentence = useCallback((sentence: string) => {
    if (ttsEngine === "browser") browserSpeak(sentence);
    else void enqueueKokoro(sentence, speechSessionRef.current);
  }, [ttsEngine, browserSpeak, enqueueKokoro]);

  // Stream-time pump: speak complete sentences as the reply crystallizes.
  const pumpSpeech = useCallback((chunk: string) => {
    if (!speakReplies) return;
    speakBufRef.current += chunk;
    const parts = speakBufRef.current.split(SENTENCE_END);
    if (parts.length >= 3) {
      const tail = parts[parts.length - 1] ?? "";
      for (let i = 0; i < parts.length - 1; i += 2) {
        const s = (parts[i] ?? "") + (parts[i + 1] ?? "");
        if (s.trim()) speakSentence(s);
      }
      speakBufRef.current = tail;
    }
  }, [speakReplies, speakSentence]);

  const flushSpeech = useCallback(() => {
    if (!speakReplies) { speakBufRef.current = ""; return; }
    const rest = speakBufRef.current.trim();
    speakBufRef.current = "";
    if (rest) speakSentence(rest);
  }, [speakReplies, speakSentence]);

  const stopSpeech = useCallback(() => {
    speechSessionRef.current += 1;
    speakBufRef.current = "";
    audioQueueRef.current.forEach(URL.revokeObjectURL);
    audioQueueRef.current = [];
    audioPlayingRef.current = false;
    if (audioElRef.current) { audioElRef.current.pause(); audioElRef.current.src = ""; }
    if (speakSupportedRef.current) { try { window.speechSynthesis.cancel(); } catch {} }
    setTtsPlayback("idle");
    setSpeakingTurn(null);
  }, []);

  const pauseSpeech = useCallback(() => {
    if (ttsEngine === "kokoro") audioElRef.current?.pause();
    else if (speakSupportedRef.current) { try { window.speechSynthesis.pause(); } catch {} }
    setTtsPlayback("paused");
  }, [ttsEngine]);

  const resumeSpeech = useCallback(() => {
    if (ttsEngine === "kokoro") { const el = audioElRef.current; if (el?.src) void el.play().catch(() => {}); else playNextAudio(); }
    else if (speakSupportedRef.current) { try { window.speechSynthesis.resume(); } catch {} }
    setTtsPlayback("playing");
  }, [ttsEngine, playNextAudio]);

  // Clear the "which turn is speaking" marker when playback fully stops.
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
        turns: { id: number; ts: string; prompt: string; reply: string; toolUses: string[] }[];
        summaries: { id: number; ts: string; text: string }[];
      };
      if (data.mode === "full" && data.turns.length) {
        const loaded: Turn[] = data.turns.map((t) => ({
          id: t.id, prompt: t.prompt, reply: t.reply, toolUses: t.toolUses ?? [],
          status: "done" as const, startedAt: new Date(t.ts).getTime() || Date.now(),
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
    if (project !== WORKSPACE_KEY && projects.length > 0 && !projects.some((p) => p.slug === project)) {
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
    // Voice-out side effects (auto-speak streamed sentences).
    if (event === "text") pumpSpeech((data as { text?: string })?.text ?? "");
    else if (event === "result" || event === "done") flushSpeech();
    else if (event === "error") stopSpeech();

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
  }, [pumpSpeech, flushSpeech, stopSpeech]);

  const sendToClaude = useCallback(async () => {
    const prompt = text.trim();
    if (!prompt && attachments.length === 0) return;
    if (turns.some((t) => t.status === "streaming")) return;
    const id = ++turnSeqRef.current;
    const sentAtts = attachments;
    const promptLabel = prompt || `(${sentAtts.length} attached file${sentAtts.length === 1 ? "" : "s"})`;
    setTurns((ts) => [...ts, { id, prompt: promptLabel, reply: "", toolUses: [], status: "streaming", startedAt: Date.now(), activity: "Starting..." }]);
    setText("");
    setAttachments([]);
    stopSpeech();                              // cancel any prior speech
    if (speakReplies) { speechSessionRef.current += 1; setSpeakingTurn(id); }   // this turn will be read aloud as it streams

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
  }, [text, attachments, project, activeSession, turns, applyEvent, loadSessions, stopSpeech, speakReplies]);

  const stopTurn = useCallback(() => {
    abortRef.current?.abort();
    setTurns((ts) => ts.map((t) => t.status === "streaming" ? { ...t, status: "done" } : t));
  }, []);

  // ── Scroll transcript ──
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
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
      className={cx("home-root", treePinned && "home-root--railed")}
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
            <span className="aria-head__spark"><Sparkles size={18} /></span>
            <span className="home-header__name">{PERSONA.name}</span>
          </div>
          <div className="home-header__right">
            {speakSupportedRef.current && (
              <button
                className={cx("home-tool-btn", speakReplies && "home-tool-btn--on")}
                onClick={() => setSpeakReplies((v) => !v)}
                title={speakReplies ? `Voice on${ttsEngine === "kokoro" ? " · Kokoro neural" : ttsEngine === "browser" ? " · browser" : ""} — click to mute` : "Read replies aloud"}
              >
                {speakReplies ? <Volume2 size={15} /> : <VolumeX size={15} />} Voice
              </button>
            )}
            <button className="home-tool-btn" onClick={() => setMemoryOpen(true)} title="Aria's memory — core, persistent & this project's recent/mid/long"><Brain size={15} /> Memory</button>
            <button className="home-tool-btn" onClick={() => setActivityOpen(true)} title="Sessions & recent activity"><Clock size={15} /> Activity</button>
            <a href="/tasks" className="home-nav-btn" title="Mission Control">
              <GitBranch size={15} /> Mission Control
            </a>
            <ThemeToggle />
          </div>
        </header>

        {/* Project selector — VERY TOP, under the header */}
        <div className="home-projsel">
          <span className="home-projsel__label"><FolderTree size={12} /> Project</span>
          <div className="home-projsel__pills">
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
          <button className="home-tab home-tab--add" onClick={() => void newSession()} title="New session (own context, shared memory)"><Plus size={12} /> New</button>
          {sessions.length > 4 && (
            <button className="home-tab home-tab--more" onClick={() => setActivityOpen(true)} title="All sessions & activity"><MoreHorizontal size={13} /> More</button>
          )}
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
            <div ref={transcriptRef} className="home-transcript">
              {turns.map((t) => (
                <div key={t.id} className="aria-turn">
                  <div className="aria-bubble">{t.prompt}</div>
                  {t.toolUses.length > 0 && (
                    <div className="aria-tools">
                      {t.toolUses.map((name, i) => (
                        <span key={`${t.id}-${i}`} className="aria-toolchip"><span style={{ fontSize: 9 }}>&#x1F527;</span> {name}</span>
                      ))}
                    </div>
                  )}
                  {(t.reply || t.status === "streaming") && (
                    <div className="aria-reply">
                      <Markdown>{stripSuggestions(t.reply)}</Markdown>
                      {t.status === "streaming" && t.reply && <span className="aria-caret" />}
                      {/* A multi-agent flow Aria launched from this turn */}
                      {t.flow && (
                        t.flow.error
                          ? <div className="aria-err" style={{ marginTop: 8 }}><AlertCircle size={12} style={{ marginTop: 1, flexShrink: 0 }} /><span>{t.flow.error}</span></div>
                          : (
                            <a className="reply-flow" href="/tasks" title="Open Mission Control to watch the flow run">
                              <GitBranch size={13} />
                              <span className="reply-flow__label">Flow launched{t.flow.stepCount ? ` · ${t.flow.stepCount} steps` : ""}</span>
                              <span className="reply-flow__goal">{t.flow.goal}</span>
                              <ArrowRight size={12} />
                            </a>
                          )
                      )}
                      {/* Clickable next-step suggestions parsed from the reply */}
                      {t.status !== "streaming" && (t.suggestions?.length ?? 0) > 0 && (
                        <div className="reply-next">
                          <span className="reply-next__label">Next steps</span>
                          <div className="reply-next__chips">
                            {t.suggestions!.map((s, i) => (
                              <button
                                key={i}
                                className="reply-next__chip"
                                title={s.prompt}
                                onClick={() => { setText(s.prompt); inputRef.current?.focus(); }}
                              >
                                {s.label} <ArrowRight size={12} />
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {t.reply && t.status !== "streaming" && (
                        <ReplyVoice text={t.reply} cleanForSpeech={cleanForSpeech} autoLoad={speakReplies} />
                      )}
                    </div>
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
                  placeholder={hasActiveTurn ? "Aria is working..." : `Ask ${PERSONA.name} anything...`}
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

// Per-reply audio player with a SCRUBBABLE TIMELINE. On "Listen", it synthesizes
// the WHOLE reply into one continuous <audio> element (single /api/speak call),
// giving native currentTime/duration/seek. Self-contained: owns its own audio,
// independent of the streaming auto-speak. Falls back to browser speech (no
// timeline) when Kokoro is unavailable.
function ReplyVoice({ text, cleanForSpeech, autoLoad = false }: { text: string; cleanForSpeech: (s: string) => string; autoLoad?: boolean }) {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "playing" | "paused" | "browser" | "error">("idle");
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const seekingRef = useRef(false);

  // Build the audio element once, lazily on first Listen.
  const ensureAudio = useCallback(async (): Promise<HTMLAudioElement | "browser" | null> => {
    if (audioRef.current) return audioRef.current;
    const clean = cleanForSpeech(text);
    if (!clean) return null;
    const res = await fetch("/api/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: clean.slice(0, 6000) }) });
    if (!res.ok) return "browser";
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    urlRef.current = url;
    const audio = new Audio();
    audio.preload = "auto";
    const grabDur = () => { if (Number.isFinite(audio.duration) && audio.duration > 0) setDur(audio.duration); };
    audio.addEventListener("loadedmetadata", grabDur);
    audio.addEventListener("durationchange", grabDur);   // some browsers populate duration late
    audio.addEventListener("canplay", grabDur);
    audio.addEventListener("canplaythrough", grabDur);
    audio.addEventListener("timeupdate", () => { if (!seekingRef.current) setCur(audio.currentTime); });
    audio.addEventListener("ended", () => { setState("ready"); setCur(0); audio.currentTime = 0; });
    audio.src = url;
    audio.load();                                        // force metadata load so the scrubber's duration is ready
    audioRef.current = audio;
    // Wait briefly for metadata so the timeline appears immediately (don't hang forever).
    await new Promise<void>((resolve) => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) return resolve();
      const done = () => { audio.removeEventListener("loadedmetadata", done); audio.removeEventListener("error", done); resolve(); };
      audio.addEventListener("loadedmetadata", done);
      audio.addEventListener("error", done);
      setTimeout(done, 2500);                            // cap the wait
    });
    return audio;
  }, [text, cleanForSpeech]);

  const play = useCallback(async () => {
    if (state === "playing") return;
    if (audioRef.current) { void audioRef.current.play(); setState("playing"); return; }
    setState("loading");
    try {
      const a = await ensureAudio();
      if (a === "browser") {
        // Fallback: browser speech, no timeline.
        if ("speechSynthesis" in window) {
          const u = new SpeechSynthesisUtterance(cleanForSpeech(text).slice(0, 8000));
          u.rate = 1.05; u.onend = () => setState("ready");
          window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
          setState("browser");
        } else setState("error");
        return;
      }
      if (!a) { setState("idle"); return; }
      await a.play();
      setState("playing");
    } catch { setState("error"); }
  }, [state, ensureAudio, cleanForSpeech, text]);

  const pause = useCallback(() => {
    if (state === "browser") { try { window.speechSynthesis.pause(); } catch {} setState("paused"); return; }
    audioRef.current?.pause(); setState("paused");
  }, [state]);
  const resume = useCallback(() => {
    if (state === "browser") { try { window.speechSynthesis.resume(); } catch {} setState("browser"); return; }
    void audioRef.current?.play(); setState("playing");
  }, [state]);
  const stop = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.currentTime = 0; }
    try { window.speechSynthesis.cancel(); } catch {}
    setCur(0); setState(audioRef.current ? "ready" : "idle");
  }, []);

  const seek = useCallback((t: number) => {
    const a = audioRef.current;
    if (!a || !dur) return;
    a.currentTime = Math.max(0, Math.min(dur, t));
    setCur(a.currentTime);
  }, [dur]);

  // Auto-prepare the timeline when Voice is on: synthesize the clip up front so
  // the scrubber is ready immediately — but DON'T play (the streaming speech
  // already read it live; auto-playing here would double the audio). Leaves the
  // player at "ready" / 0:00 for instant replay + seek.
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (!autoLoad || autoLoadedRef.current) return;
    autoLoadedRef.current = true;   // run exactly once; setState("loading") must NOT re-trigger this
    setState("loading");
    let mounted = true;
    (async () => {
      try {
        const a = await ensureAudio();
        if (!mounted) return;
        setState(a && a !== "browser" ? "ready" : "idle");   // Kokoro down → plain Listen button
      } catch { if (mounted) setState("idle"); }
    })();
    return () => { mounted = false; };
  }, [autoLoad, ensureAudio]);

  // Clean up the blob URL on unmount.
  useEffect(() => () => {
    audioRef.current?.pause();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    try { window.speechSynthesis?.cancel(); } catch {}
  }, []);

  const fmt = (s: number) => { const m = Math.floor(s / 60); const r = Math.floor(s % 60); return `${m}:${String(r).padStart(2, "0")}`; };
  const playing = state === "playing" || state === "browser";
  const hasTimeline = (state === "playing" || state === "paused" || state === "ready") && dur > 0;

  return (
    <div className="reply-voice">
      {state === "idle" || state === "error" ? (
        <button className="reply-voice__btn" onClick={() => void play()} title="Read aloud">
          <Volume2 size={13} /> {state === "error" ? "Retry voice" : "Listen"}
        </button>
      ) : state === "loading" ? (
        <span className="reply-voice__btn reply-voice__btn--on"><Loader2 size={13} className="animate-spin" /> Synthesizing…</span>
      ) : (
        <>
          {playing
            ? <button className="reply-voice__btn reply-voice__btn--on" onClick={pause} title="Pause"><Pause size={13} /></button>
            : <button className="reply-voice__btn reply-voice__btn--on" onClick={() => (state === "ready" ? void play() : resume())} title="Play"><Play size={13} fill="currentColor" /></button>}
          <button className="reply-voice__btn" onClick={stop} title="Stop"><Square size={11} fill="currentColor" /></button>
          {hasTimeline ? (
            <div className="reply-voice__timeline">
              <span className="reply-voice__time">{fmt(cur)}</span>
              <input
                className="reply-voice__scrub"
                type="range" min={0} max={Math.max(dur, 0.1)} step={0.05} value={Math.min(cur, dur)}
                onMouseDown={() => { seekingRef.current = true; }}
                onMouseUp={() => { seekingRef.current = false; }}
                onChange={(e) => { const v = parseFloat(e.target.value); setCur(v); seek(v); }}
                style={{ ["--pct" as string]: `${dur ? (cur / dur) * 100 : 0}%` }}
                aria-label="Seek"
              />
              <span className="reply-voice__time">{fmt(dur)}</span>
            </div>
          ) : (
            <span className="reply-voice__wave" aria-hidden><i /><i /><i /></span>
          )}
        </>
      )}
    </div>
  );
}
