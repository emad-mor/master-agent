"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Mic, ArrowUp, Sparkles, X, Loader2, Wrench, AlertCircle, Volume2, VolumeX, Brain, ChevronDown, RefreshCw, Square, Play, Pause, Activity, GitBranch } from "lucide-react";
import { cx } from "@/lib/format";
import { PERSONA, timeOfDay, QUICK_PROMPTS } from "./persona-config";
import { PersonaMemoryDrawer } from "./persona-memory-drawer";
import { AriaThinking } from "./aria-thinking";
import "./companion.css";

const STORAGE_KEY = "aria.lastDraft";
const SPEAK_KEY = "aria.speakReplies";
const PROJECT_KEY = "aria.activeProject";
const WORKSPACE_KEY = "__workspace__";
const MIN_RECORDING_MS = 350;
const WAVE_BARS = 48;

// Strip emoji and markdown noise that TTS would read out literally, chunk on
// sentence boundaries. (Unchanged from the original — speech hygiene.)
const SENTENCE_END = /([.!?]+\s+|\n{2,})/;
function cleanForSpeech(s: string): string {
  return s
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/gu, "")
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*?([^*]+)\*\*?/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*#+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

type Project = { slug: string; name: string; path: string };

type Turn = {
  id: number;
  prompt: string;
  reply: string;
  toolUses: string[];
  status: "streaming" | "done" | "error";
  errorMessage?: string;
  startedAt: number;        // ms — when the turn was submitted
  activity?: string;        // latest live activity label (e.g. "Read", "Bash", "Thinking…")
};

export function PersonaWidget() {
  // The homepage IS a full chat, so the floating widget is redundant there.
  // It stays on every other route (e.g. /tasks) as the way to reach Aria.
  const pathname = usePathname();
  const hidden = pathname === "/";
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryRefresh, setMemoryRefresh] = useState(0);
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<string>(WORKSPACE_KEY);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordStartRef = useRef(0);
  const turnSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // ── Live waveform (Web Audio analyser, wired to the real mic) ──
  const [levels, setLevels] = useState<number[]>(() => new Array(WAVE_BARS).fill(0));
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  // ── TTS state (Kokoro primary, browser fallback) — unchanged backend ──
  const [speakReplies, setSpeakReplies] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [ttsEngine, setTtsEngine] = useState<"kokoro" | "browser" | "checking">("checking");
  const speakBufRef = useRef("");
  const speakSupportedRef = useRef(typeof window !== "undefined" && "speechSynthesis" in window);
  const browserVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const audioQueueRef = useRef<string[]>([]);
  const audioPlayingRef = useRef(false);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const speechSessionRef = useRef(0);
  // Playback state surfaced to the UI so the user can play/pause/stop the voice.
  // "idle" = nothing queued/playing; "playing" = audio in flight; "paused" = held.
  const [ttsPlayback, setTtsPlayback] = useState<"idle" | "playing" | "paused">("idle");

  const projectName = project === WORKSPACE_KEY
    ? "All projects"
    : projects.find((p) => p.slug === project)?.name ?? project;

  const loadProjects = useCallback(async () => {
    setLoadingProjects(true);
    try {
      const res = await fetch("/api/projects", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects ?? []);
      }
    } catch {
      // non-fatal
    } finally {
      setLoadingProjects(false);
    }
  }, []);

  useEffect(() => {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v) setText(v);
      const p = localStorage.getItem(PROJECT_KEY);
      if (p) setProject(p);
    } catch {}
    void loadProjects();
  }, [loadProjects]);
  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, text); } catch {} }, [text]);
  useEffect(() => { try { localStorage.setItem(PROJECT_KEY, project); } catch {} }, [project]);
  useEffect(() => { if (open) void loadProjects(); }, [open, loadProjects]);

  useEffect(() => {
    if (project !== WORKSPACE_KEY && projects.length > 0 && !projects.some((p) => p.slug === project)) {
      setProject(WORKSPACE_KEY);
    }
  }, [projects, project]);

  useEffect(() => {
    try { const v = localStorage.getItem(SPEAK_KEY); if (v === "1") setSpeakReplies(true); } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem(SPEAK_KEY, speakReplies ? "1" : "0"); } catch {}
    if (!speakReplies && speakSupportedRef.current) {
      try { window.speechSynthesis.cancel(); } catch {}
    } else if (speakReplies) setTtsError(null);
  }, [speakReplies]);

  useEffect(() => {
    if (!speakSupportedRef.current) return;
    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) return;
      browserVoiceRef.current =
        voices.find((v) => /Aria|Sonia|Jenny|Libby/i.test(v.name) && /en/i.test(v.lang)) ||
        voices.find((v) => /Microsoft|Google/i.test(v.name) && /en/i.test(v.lang)) ||
        voices.find((v) => /en-US|en-GB|en-CA/i.test(v.lang)) ||
        voices[0] || null;
    };
    pick();
    window.speechSynthesis.addEventListener("voiceschanged", pick);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", pick);
  }, []);

  // Probe Kokoro once so we know which engine to use.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "." }),
        });
        if (!cancelled) setTtsEngine(res.ok ? "kokoro" : "browser");
      } catch {
        if (!cancelled) setTtsEngine("browser");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const playNext = useCallback(() => {
    if (audioPlayingRef.current) return;
    const next = audioQueueRef.current.shift();
    if (!next) { setTtsPlayback("idle"); return; }
    audioPlayingRef.current = true;
    setTtsPlayback("playing");
    const audio = audioElRef.current ?? new Audio();
    audioElRef.current = audio;
    audio.src = next;
    audio.onended = () => { URL.revokeObjectURL(next); audioPlayingRef.current = false; playNext(); };
    audio.onerror = () => { URL.revokeObjectURL(next); audioPlayingRef.current = false; playNext(); };
    audio.play().catch(() => {
      audioPlayingRef.current = false;
      audioQueueRef.current.forEach(URL.revokeObjectURL);
      audioQueueRef.current = [];
      setTtsPlayback("idle");
      setTtsError("Browser blocked autoplay. Click the speaker icon once to grant audio permission, then try again.");
    });
  }, []);

  const kokoroSpeak = useCallback(async (sentence: string, sessionToken: number) => {
    const clean = cleanForSpeech(sentence);
    if (!clean) return;
    try {
      const res = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean }),
      });
      if (sessionToken !== speechSessionRef.current) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (sessionToken !== speechSessionRef.current) return;
      audioQueueRef.current.push(URL.createObjectURL(blob));
      playNext();
    } catch (err) {
      setTtsError(`Kokoro failed: ${(err as Error).message}. Run \`npm run dev\` so the voice sidecar starts.`);
    }
  }, [playNext]);

  const browserSpeak = useCallback((sentence: string) => {
    if (!speakSupportedRef.current) return;
    const clean = cleanForSpeech(sentence);
    if (!clean) return;
    const u = new SpeechSynthesisUtterance(clean);
    u.rate = 1.05; u.pitch = 1.0; u.volume = 1.0;
    if (browserVoiceRef.current) { u.voice = browserVoiceRef.current; u.lang = browserVoiceRef.current.lang; }
    u.onstart = () => setTtsPlayback("playing");
    u.onend = () => {
      // Back to idle only when nothing else is queued to speak.
      if (!window.speechSynthesis.pending && !window.speechSynthesis.speaking) setTtsPlayback("idle");
    };
    u.onerror = (e) => {
      const err = (e as SpeechSynthesisErrorEvent).error;
      if (err && err !== "interrupted" && err !== "canceled") setTtsError(`Speech error: ${err}.`);
    };
    window.speechSynthesis.speak(u);
  }, []);

  const speakSentence = useCallback((sentence: string) => {
    const token = speechSessionRef.current;
    if (ttsEngine === "kokoro") void kokoroSpeak(sentence, token);
    else if (ttsEngine === "browser") browserSpeak(sentence);
  }, [ttsEngine, kokoroSpeak, browserSpeak]);

  const testVoice = useCallback(() => {
    setTtsError(null);
    speechSessionRef.current += 1;
    audioQueueRef.current.forEach(URL.revokeObjectURL);
    audioQueueRef.current = [];
    audioPlayingRef.current = false;
    if (audioElRef.current) { audioElRef.current.pause(); audioElRef.current.src = ""; }
    if (speakSupportedRef.current) { try { window.speechSynthesis.cancel(); window.speechSynthesis.resume(); } catch {} }
    speakSentence(`Hi, I'm ${PERSONA.name}. Voice is working.`);
  }, [speakSentence]);

  const pumpSpeech = useCallback((newText: string) => {
    if (!speakReplies) return;
    speakBufRef.current += newText;
    const parts = speakBufRef.current.split(SENTENCE_END);
    let tail = speakBufRef.current;
    if (parts.length >= 3) {
      tail = parts[parts.length - 1] ?? "";
      for (let i = 0; i < parts.length - 1; i += 2) {
        const sentence = (parts[i] ?? "") + (parts[i + 1] ?? "");
        if (sentence.trim()) speakSentence(sentence);
      }
    }
    speakBufRef.current = tail;
  }, [speakReplies, speakSentence]);

  const flushSpeech = useCallback(() => {
    if (!speakReplies) { speakBufRef.current = ""; return; }
    const rest = speakBufRef.current.trim();
    speakBufRef.current = "";
    if (rest) speakSentence(rest);
  }, [speakReplies, speakSentence]);

  const cancelSpeech = useCallback(() => {
    speakBufRef.current = "";
    speechSessionRef.current += 1;
    audioQueueRef.current.forEach(URL.revokeObjectURL);
    audioQueueRef.current = [];
    audioPlayingRef.current = false;
    if (audioElRef.current) { audioElRef.current.pause(); audioElRef.current.src = ""; }
    if (speakSupportedRef.current) { try { window.speechSynthesis.cancel(); } catch {} }
    setTtsPlayback("idle");
  }, []);

  // ── User-facing voice controls (work across both engines) ──
  const pauseSpeech = useCallback(() => {
    if (ttsEngine === "kokoro") {
      audioElRef.current?.pause();   // queue stays intact; resume picks up here
    } else if (speakSupportedRef.current) {
      try { window.speechSynthesis.pause(); } catch {}
    }
    setTtsPlayback("paused");
  }, [ttsEngine]);

  const resumeSpeech = useCallback(() => {
    if (ttsEngine === "kokoro") {
      const el = audioElRef.current;
      if (el && el.src) { void el.play().catch(() => {}); }
      else playNext();               // nothing mid-clip — pull the next queued one
    } else if (speakSupportedRef.current) {
      try { window.speechSynthesis.resume(); } catch {}
    }
    setTtsPlayback("playing");
  }, [ttsEngine, playNext]);

  // stopSpeech = cancelSpeech, but kept as a named control for clarity in the UI.
  const stopSpeech = useCallback(() => { cancelSpeech(); }, [cancelSpeech]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // ── Live waveform animation loop — reads the analyser into bar heights ──
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
        // map the low/mid frequency bins across the bar count, symmetric-ish
        const next = new Array(WAVE_BARS).fill(0).map((_, i) => {
          const center = Math.abs(i - WAVE_BARS / 2) / (WAVE_BARS / 2); // 0 center → 1 edge
          const bin = Math.floor((i / WAVE_BARS) * (bins.length * 0.7));
          const v = (bins[bin] ?? 0) / 255;
          // boost center bars so it reads like a waveform, with a small floor
          return Math.max(0.06, v * (1 - center * 0.5));
        });
        setLevels(next);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      // Web Audio unavailable — leave bars flat; recording still works.
    }
  }, []);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    abortRef.current?.abort();
    stopMeter();
    audioQueueRef.current.forEach(URL.revokeObjectURL);
    audioQueueRef.current = [];
    if (audioElRef.current) { audioElRef.current.pause(); audioElRef.current.src = ""; }
    if (typeof window !== "undefined" && "speechSynthesis" in window) { try { window.speechSynthesis.cancel(); } catch {} }
  }, [stopMeter]);

  // ── Whisper recording ──
  const transcribe = useCallback(async (blob: Blob) => {
    setTranscribing(true);
    setVoiceError(null);
    try {
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: blob,
      });
      const data = await res.json().catch(() => ({ error: "Bad response from /api/transcribe" }));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const heard = (data?.text ?? "").trim();
      if (!heard) { setVoiceError("Didn't catch anything. Try speaking louder or closer to the mic."); return; }
      setText((prev) => (!prev ? heard : prev.endsWith(" ") || prev.endsWith("\n") ? prev + heard : prev + " " + heard));
      setTimeout(() => inputRef.current?.focus(), 30);
    } catch (err) {
      setVoiceError((err as Error).message ?? "Transcription failed.");
    } finally {
      setTranscribing(false);
    }
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
        name === "NotAllowedError" ? "Mic blocked. Allow microphone access for this site, then try again."
        : name === "NotFoundError" ? "No microphone detected. Check your system sound input."
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

  // ── Claude SSE streaming — unchanged backend ──
  const applyEvent = useCallback((turnId: number, event: string, data: unknown) => {
    if (event === "text") {
      pumpSpeech((data as { text?: string })?.text ?? "");
    } else if (event === "result" || event === "done") {
      flushSpeech();
      setMemoryRefresh((n) => n + 1);
    } else if (event === "error") {
      cancelSpeech();
    }

    setTurns((ts) => ts.map((t) => {
      if (t.id !== turnId) return t;
      switch (event) {
        case "text": return { ...t, reply: t.reply + ((data as { text?: string })?.text ?? ""), activity: "Writing reply…" };
        case "tool_use": {
          const name = (data as { name?: string })?.name ?? "tool";
          return { ...t, toolUses: [...t.toolUses, name], activity: `Running ${name}…` };
        }
        case "tool_result": return { ...t, activity: "Thinking…" };
        case "result": {
          const r = data as { isError?: boolean; text?: string };
          return { ...t, status: r.isError ? "error" : "done", errorMessage: r.isError ? (r.text ?? "Claude returned an error") : t.errorMessage, reply: t.reply || r.text || "", activity: undefined };
        }
        case "error": return { ...t, status: "error", errorMessage: (data as { message?: string })?.message ?? "Unknown error", activity: undefined };
        case "done": return t.status === "streaming" ? { ...t, status: "done", activity: undefined } : t;
        default: return t;
      }
    }));
  }, [pumpSpeech, flushSpeech, cancelSpeech]);

  const sendToClaude = useCallback(async () => {
    const prompt = text.trim();
    if (!prompt) return;
    if (turns.some((t) => t.status === "streaming")) return;  // one turn at a time (until Phase 2 parallel tasks)
    const id = ++turnSeqRef.current;
    setTurns((ts) => [...ts, { id, prompt, reply: "", toolUses: [], status: "streaming", startedAt: Date.now(), activity: "Starting…" }]);
    setText("");
    cancelSpeech();

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let res: Response;
    try {
      res = await fetch("/api/persona/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, project }),
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
          let data: unknown;
          try { data = JSON.parse(line.slice(6)); } catch { continue; }
          applyEvent(id, currentEvent, data);
        }
      }
    } catch (err) {
      if ((err as DOMException)?.name !== "AbortError") {
        setTurns((ts) => ts.map((t) => t.id === id ? { ...t, status: "error", errorMessage: (err as Error).message } : t));
      }
    }
  }, [text, project, turns, cancelSpeech, applyEvent]);

  const stopTurn = useCallback(() => {
    abortRef.current?.abort();
    cancelSpeech();
    setTurns((ts) => ts.map((t) => t.status === "streaming" ? { ...t, status: "done" } : t));
  }, [cancelSpeech]);

  const onProjectChange = useCallback((slug: string) => {
    setProject(slug);
    setTurns([]);
    cancelSpeech();
    setMemoryRefresh((n) => n + 1);
  }, [cancelSpeech]);

  // ── Open/close with slide-out animation ──
  const closeSheet = useCallback(() => {
    stopRecording();
    setClosing(true);
    setTimeout(() => { setOpen(false); setClosing(false); }, 340);
  }, [stopRecording]);

  useEffect(() => {
    if (hidden) return;   // no ⌘K capture on the homepage (its own chat owns the page)
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) closeSheet(); else setOpen(true);
      }
      if (e.key === "Escape" && open && !memoryOpen) closeSheet();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden, open, memoryOpen, closeSheet]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 60);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendToClaude(); }
  };

  const greeting = PERSONA.greetings[timeOfDay()];
  const micDown = (e: React.SyntheticEvent) => { e.preventDefault(); void startRecording(); };
  const micUp = (e: React.SyntheticEvent) => { e.preventDefault(); stopRecording(); };

  const hasActiveTurn = turns.some((t) => t.status === "streaming");
  const activeTurn = turns.find((t) => t.status === "streaming");
  // The latest streaming turn that hasn't produced text yet → show thinking star.
  const lastTurn = turns[turns.length - 1];
  const showThinking = lastTurn?.status === "streaming" && !lastTurn.reply;
  const canSend = !!text.trim() && !hasActiveTurn;

  // Tick once a second while a turn runs, so the elapsed-time readout updates.
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!hasActiveTurn) return;
    const id = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [hasActiveTurn]);
  const elapsed = activeTurn ? Math.max(0, Math.floor((Date.now() - activeTurn.startedAt) / 1000)) : 0;
  const elapsedLabel = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;

  if (hidden) return null;   // redundant on the homepage; rendered on all other routes

  return (
    <>
      {/* Floating launcher */}
      <button
        onClick={() => setOpen(true)}
        aria-label={`Open ${PERSONA.name}`}
        title={`Talk to ${PERSONA.name} (Ctrl/⌘+K)`}
        className={cx("aria-launcher", open && "aria-launcher--hidden")}
      >
        <Sparkles size={24} />
        <span className={cx("aria-launcher__pulse", hasActiveTurn ? "aria-launcher__pulse--busy" : "aria-launcher__pulse--idle")} />
      </button>

      {open && (
        <div className="aria-portal">
          <div className={cx("aria-backdrop", closing && "aria-backdrop--out")} onClick={closeSheet} aria-hidden />

          <div className={cx("aria-sheet", closing && "aria-sheet--out")} role="dialog" aria-label={`${PERSONA.name}`}>
            {/* mist background */}
            <div className="aria-basewash" aria-hidden />
            <div className="aria-mist" aria-hidden>
              <div className="aria-blob aria-blob--violet" />
              <div className="aria-blob aria-blob--crimson" />
              <div className="aria-blob aria-blob--indigo" />
              <div className="aria-blob aria-blob--rose" />
              <div className="aria-blob aria-blob--core" />
              <div className="aria-blob aria-blob--azure" />
              <div className="aria-blob aria-blob--amber" />
              <div className="aria-blob aria-blob--magenta" />
            </div>
            <div className="aria-topfade" aria-hidden />
            <div className="aria-handle" aria-hidden />

            <div className="aria-content">
              {/* Header */}
              <div className="aria-head">
                <span className="aria-head__spark"><Sparkles size={18} /></span>
                <div>
                  <div className="aria-head__title">{PERSONA.name}</div>
                  <div className="aria-head__sub">Claude Code · {projectName}</div>
                </div>
                <span className="aria-head__spacer" />
                <a className="aria-iconbtn" href="/tasks" title="Mission Control — parallel tasks & flows" aria-label="Mission Control">
                  <GitBranch size={16} />
                </a>
                <button className="aria-iconbtn" onClick={() => setMemoryOpen(true)} title="View memory" aria-label="Memory">
                  <Brain size={16} />
                </button>
                {speakSupportedRef.current && (
                  <button
                    className={cx("aria-iconbtn", speakReplies && "aria-iconbtn--on")}
                    onClick={() => setSpeakReplies((v) => !v)}
                    title={speakReplies ? "Mute Aria's voice" : "Have Aria read replies aloud"}
                    aria-pressed={speakReplies}
                    aria-label={speakReplies ? "Mute voice" : "Enable voice"}
                  >
                    {speakReplies ? <Volume2 size={16} /> : <VolumeX size={16} />}
                  </button>
                )}
                <button className="aria-iconbtn" onClick={closeSheet} aria-label="Close"><X size={16} /></button>
              </div>

              {/* Project switcher */}
              <div className="aria-projrow">
                <div className="aria-proj">
                  <select value={project} onChange={(e) => onProjectChange(e.target.value)} aria-label="Active project" title="Which project Aria works in">
                    <option value={WORKSPACE_KEY}>All projects (whole workspace)</option>
                    {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
                  </select>
                  <ChevronDown size={14} className="aria-proj__chev" />
                </div>
                <button className="aria-iconbtn" onClick={() => void loadProjects()} title="Rescan workspace" aria-label="Rescan projects">
                  {loadingProjects ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                </button>
              </div>

              {/* Body: thinking star, or transcript, or greeting */}
              {showThinking && turns.length === 1 && !turns[0].reply ? (
                <div className="aria-transcript" style={{ justifyContent: "center" }}>
                  <AriaThinking />
                </div>
              ) : turns.length === 0 ? (
                <div className="aria-transcript" style={{ justifyContent: "center" }}>
                  <div className="aria-hello">
                    <div className="aria-hello__greet aria-stagger aria-stagger--1">{greeting}</div>
                    <div className="aria-hello__hint aria-stagger aria-stagger--2">
                      Pick a project, then type or hold the mic. I run Claude Code in that project with full tool access — and can reach across your whole workspace.
                    </div>
                    <div className="aria-chips aria-stagger aria-stagger--3">
                      {QUICK_PROMPTS.slice(0, 4).map((p) => (
                        <button key={p.label} className="aria-chip" onClick={() => { setText((c) => (c ? c + "\n\n" : "") + p.prompt); inputRef.current?.focus(); }}>
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div ref={transcriptRef} className="aria-transcript">
                  {turns.map((t) => <TurnView key={t.id} turn={t} />)}
                </div>
              )}

              {/* Errors / status */}
              {voiceError && (
                <div className="aria-meta" style={{ color: "#ff9d9d" }}>
                  <AlertCircle size={12} /> {voiceError}
                </div>
              )}
              {ttsError && (
                <div className="aria-meta" style={{ color: "#ff9d9d" }}>
                  <AlertCircle size={12} /> {ttsError}
                </div>
              )}

              {/* Input dock */}
              <div className="aria-dock">
                {/* Task-in-progress panel — tells you exactly what's running so you don't re-fire */}
                {activeTurn && (
                  <div className="aria-task" role="status" aria-live="polite">
                    <span className="aria-task__pulse"><Activity size={13} /></span>
                    <div className="aria-task__body">
                      <div className="aria-task__title">{activeTurn.activity ?? "Working…"}</div>
                      <div className="aria-task__sub">
                        {activeTurn.prompt.length > 64 ? activeTurn.prompt.slice(0, 64) + "…" : activeTurn.prompt}
                      </div>
                    </div>
                    {activeTurn.toolUses.length > 0 && (
                      <span className="aria-task__count" title="Tools used so far">{activeTurn.toolUses.length} tool{activeTurn.toolUses.length === 1 ? "" : "s"}</span>
                    )}
                    <span className="aria-task__time">{elapsedLabel}</span>
                    <button className="aria-task__stop" onClick={stopTurn} title="Stop this task" aria-label="Stop task">
                      <Square size={11} fill="currentColor" /> Stop
                    </button>
                  </div>
                )}

                {/* Voice playback controls — appear whenever speech is playing or paused */}
                {ttsPlayback !== "idle" && (
                  <div className="aria-voicebar" role="group" aria-label="Voice playback controls">
                    <span className={cx("aria-voicebar__wave", ttsPlayback === "playing" && "aria-voicebar__wave--on")} aria-hidden>
                      <i /><i /><i /><i />
                    </span>
                    <span className="aria-voicebar__label">
                      {ttsPlayback === "playing" ? "Aria is speaking" : "Voice paused"}
                    </span>
                    {ttsPlayback === "playing" ? (
                      <button className="aria-voicebar__btn" onClick={pauseSpeech} title="Pause voice" aria-label="Pause voice"><Pause size={14} /></button>
                    ) : (
                      <button className="aria-voicebar__btn" onClick={resumeSpeech} title="Resume voice" aria-label="Resume voice"><Play size={14} fill="currentColor" /></button>
                    )}
                    <button className="aria-voicebar__btn" onClick={stopSpeech} title="Stop voice" aria-label="Stop voice"><Square size={12} fill="currentColor" /></button>
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
                    <span className="aria-bar__transcribed"><Loader2 size={13} className="animate-spin" style={{ display: "inline", verticalAlign: "-2px", marginRight: 6 }} /> Transcribing…</span>
                  ) : (
                    <textarea
                      ref={inputRef}
                      className="aria-bar__input"
                      rows={1}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      onKeyDown={onKeyDown}
                      disabled={hasActiveTurn}
                      placeholder={hasActiveTurn ? "Aria is working — Stop to interrupt, or wait…" : `Ask ${PERSONA.name} about ${projectName}…`}
                    />
                  )}

                  <div className="aria-bar__actions">
                    {!transcribing && !hasActiveTurn && (
                      <button
                        className={cx("aria-bar__btn", recording && "aria-bar__btn--rec")}
                        title={recording ? "Release to transcribe" : "Press and hold to talk"}
                        onMouseDown={micDown}
                        onMouseUp={micUp}
                        onMouseLeave={(e) => { if (recording) micUp(e); }}
                        onTouchStart={micDown}
                        onTouchEnd={micUp}
                        onTouchCancel={micUp}
                        aria-pressed={recording}
                        aria-label="Hold to talk"
                      >
                        <Mic size={17} />
                      </button>
                    )}
                    {hasActiveTurn ? (
                      <button className="aria-bar__send aria-bar__send--active" onClick={stopTurn} title="Stop" aria-label="Stop">
                        <Square size={14} fill="currentColor" />
                      </button>
                    ) : (
                      <button
                        className={cx("aria-bar__send", canSend && "aria-bar__send--active")}
                        onClick={() => void sendToClaude()}
                        disabled={!canSend}
                        title="Send to Claude"
                        aria-label="Send"
                      >
                        <ArrowUp size={18} />
                      </button>
                    )}
                  </div>
                </div>

                {/* status line */}
                <div className="aria-meta">
                  {recording ? (
                    <><span className="aria-meta__dot aria-meta__dot--rec" /> Listening… release to transcribe</>
                  ) : hasActiveTurn ? (
                    <span style={{ opacity: 0.7 }}>One task at a time for now · parallel tasks coming soon</span>
                  ) : speakReplies ? (
                    <>
                      <span className="aria-meta__dot aria-meta__dot--ok" />
                      {ttsEngine === "checking" && "Checking voice…"}
                      {ttsEngine === "kokoro" && <>Voice: Kokoro · af_heart (neural, local)</>}
                      {ttsEngine === "browser" && <>Voice: {browserVoiceRef.current?.name ?? "browser"} · Kokoro offline</>}
                      <button className="aria-meta__link" onClick={testVoice} style={{ marginLeft: 4 }}>Test</button>
                    </>
                  ) : (
                    <span style={{ opacity: 0.7 }}>Enter to send · Shift+Enter for newline · ⌘K to toggle</span>
                  )}
                  {turns.length > 0 && !recording && !hasActiveTurn && (
                    <button className="aria-meta__link" onClick={() => { setTurns([]); cancelSpeech(); }} style={{ marginLeft: 8 }}>New chat</button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <PersonaMemoryDrawer
        open={memoryOpen}
        onClose={() => setMemoryOpen(false)}
        refreshKey={memoryRefresh}
        project={project}
        projectName={projectName}
      />
    </>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  return (
    <div className="aria-turn">
      <div className="aria-bubble">{turn.prompt}</div>

      {turn.toolUses.length > 0 && (
        <div className="aria-tools">
          {turn.toolUses.map((name, i) => (
            <span key={`${turn.id}-${i}`} className="aria-toolchip"><Wrench size={9} /> {name}</span>
          ))}
        </div>
      )}

      {(turn.reply || turn.status === "streaming") && (
        <div className="aria-reply">
          {turn.reply}
          {turn.status === "streaming" && turn.reply && <span className="aria-caret" />}
        </div>
      )}

      {turn.status === "error" && (
        <div className="aria-err">
          <AlertCircle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
          <span>{turn.errorMessage ?? "Something went wrong."}</span>
        </div>
      )}
    </div>
  );
}
