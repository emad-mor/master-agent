"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* Streaming text-to-speech reader for node output.
 *
 * Primary engine is Kokoro via /api/speak (the same neural voice Aria uses on
 * the homepage). We split the text into sentences and fetch each clip as the
 * previous one plays, so audio STARTS on the first sentence instead of waiting
 * for the whole thing to render. As clips arrive we measure their duration and
 * build a seekable timeline, so the UI can show "0:04 / 0:37" and let the user
 * scrub. When the sidecar is offline we fall back to the browser's
 * speechSynthesis ONCE (no retry loop — that was the old CPU-spin bug).
 *
 * Each reader instance is independent; multiple nodes can each have controls,
 * but only one should play at a time in practice (the user drives it). */

type ReaderStatus = "idle" | "loading" | "playing" | "paused";
type Engine = "kokoro" | "browser" | "unknown";

// One generated audio clip on the timeline.
type Clip = { url: string; duration: number; sentence: string };

// Split into sentence-ish chunks so we can stream. Keep terminators attached.
function sentences(text: string): string[] {
  const clean = text
    .replace(/```[\s\S]*?```/g, " code block. ")
    // Drop action-marker blocks (and any partial trailing one) — their payloads
    // are prompts, not prose, and must never be read aloud.
    .replace(/\[\[\s*(ASK|NEXT|FLOW)\b[^\]]*\]\]/gi, "")
    .replace(/\[\[\s*(ASK|NEXT|FLOW)\b[\s\S]*$/i, "");
  const out: string[] = [];
  // Split on sentence enders but keep groups reasonably sized so a single
  // mega-paragraph still streams in pieces.
  const parts = clean.split(/(?<=[.!?])\s+/);
  let buf = "";
  for (const p of parts) {
    buf += (buf ? " " : "") + p;
    if (buf.length >= 180 || /[.!?]\s*$/.test(p)) { out.push(buf); buf = ""; }
  }
  if (buf.trim()) out.push(buf);
  return out.map((s) => cleanForSpeech(s)).filter(Boolean);
}

// Strip markdown so TTS doesn't read syntax aloud.
function cleanForSpeech(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*?([^*]+)\*\*?/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/^\s*[-*|]\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// Probe Kokoro once per session (module-level cache so every reader shares it).
let enginePromise: Promise<Engine> | null = null;
function detectEngine(): Promise<Engine> {
  if (!enginePromise) {
    enginePromise = fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "." }),
    })
      .then((r) => (r.ok ? "kokoro" : "browser") as Engine)
      .catch(() => "browser" as Engine);
  }
  return enginePromise;
}

// Global "one reader at a time" registry. Every live reader registers its stop()
// here; starting playback in one reader stops every other. This is what keeps
// the auto-spoken reply and a manual "Listen" (or two different replies) from
// ever playing over each other. Stop ALL readers with stopAllReaders().
const readerStops = new Set<() => void>();
export function stopAllReaders() { for (const s of [...readerStops]) s(); }

export function useReader() {
  const [status, setStatus] = useState<ReaderStatus>("idle");
  // Timeline surfaced to the control bar.
  const [currentTime, setCurrentTime] = useState(0);   // seconds elapsed across all clips
  const [duration, setDuration] = useState(0);          // total known seconds (grows as clips arrive)
  const [buffering, setBuffering] = useState(false);    // still generating later sentences
  // Karaoke surface: which spoken sentence is playing + how far into it (0..1).
  // sentenceList holds the SAME plain-text chunks the reader synthesizes, so the
  // consumer can highlight them 1:1 without mapping into the rendered markdown.
  const [sentenceList, setSentenceList] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);   // index of the sentence currently speaking (-1 = none)
  const [activeFraction, setActiveFraction] = useState(0);   // elapsed fraction within the active sentence

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const clipsRef = useRef<Clip[]>([]);
  const idxRef = useRef(0);                  // which clip is playing
  const tokenRef = useRef(0);                // bumped to cancel an in-flight session
  const browserRef = useRef(typeof window !== "undefined" && "speechSynthesis" in window);
  const rafRef = useRef<number | null>(null);
  const fracRef = useRef(0);                 // last pushed activeFraction (throttle React updates)
  // Mirrors of buffering/duration so the long-lived playFrom closure (bound to
  // audio.onended for the whole session) always reads CURRENT values instead of
  // a stale snapshot — otherwise a reply finalizes early when playback outruns
  // sentence generation (the common case).
  const bufferingRef = useRef(false);
  const durationRef = useRef(0);
  const waitingRef = useRef(false);         // playback caught up to generation and is waiting for the next clip
  const pausedRef = useRef(false);          // user paused — suppress auto-resume of a parked playback

  // Sum of durations of clips BEFORE index i (the timeline offset of clip i).
  const offsetOf = useCallback((i: number) => {
    let s = 0;
    for (let k = 0; k < i && k < clipsRef.current.length; k++) s += clipsRef.current[k].duration;
    return s;
  }, []);

  const tick = useCallback(() => {
    const a = audioRef.current;
    if (a && !a.paused) {
      setCurrentTime(offsetOf(idxRef.current) + (a.currentTime || 0));
      // Fraction through the current clip → drives the approximate word highlight.
      // Throttle React updates to ~2% steps so we don't re-render every frame.
      const dur = clipsRef.current[idxRef.current]?.duration || 0;
      const frac = dur > 0 ? Math.min(1, (a.currentTime || 0) / dur) : 0;
      if (Math.abs(frac - fracRef.current) > 0.02) { fracRef.current = frac; setActiveFraction(frac); }
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [offsetOf]);

  const stopRaf = useCallback(() => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  }, []);

  const teardown = useCallback(() => {
    tokenRef.current++;
    stopRaf();
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ""; }
    clipsRef.current.forEach((c) => URL.revokeObjectURL(c.url));
    clipsRef.current = [];
    idxRef.current = 0;
    if (browserRef.current) { try { window.speechSynthesis.cancel(); } catch {} }
  }, [stopRaf]);

  const stop = useCallback(() => {
    teardown();
    setStatus("idle"); setCurrentTime(0); setDuration(0); setBuffering(false);
    durationRef.current = 0; bufferingRef.current = false; waitingRef.current = false; pausedRef.current = false;
    setActiveIndex(-1); setActiveFraction(0); fracRef.current = 0; setSentenceList([]);
  }, [teardown]);

  // Register this instance in the global registry with a STABLE wrapper (so the
  // Set identity stays constant across renders) that always calls the latest stop.
  const stopRef = useRef(stop);
  useEffect(() => { stopRef.current = stop; }, [stop]);
  const selfStopRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const fn = () => stopRef.current();
    selfStopRef.current = fn;
    readerStops.add(fn);
    return () => { readerStops.delete(fn); };
  }, []);

  // Play clip at idxRef from its start. Advances on end.
  const playFrom = useCallback((i: number) => {
    const clips = clipsRef.current;
    if (i >= clips.length) {
      // Caught up to what's generated. If still buffering, park as "waiting" — the
      // next clip's arrival (in streamKokoro) resumes us; else playback is done.
      if (bufferingRef.current) { waitingRef.current = true; setStatus("playing"); return; }
      setStatus("idle"); setCurrentTime(durationRef.current); stopRaf();
      setActiveIndex(-1); setActiveFraction(0); fracRef.current = 0;
      return;
    }
    waitingRef.current = false;
    idxRef.current = i;
    setActiveIndex(i); setActiveFraction(0); fracRef.current = 0;   // new sentence is now speaking
    const audio = audioRef.current ?? new Audio();
    audioRef.current = audio;
    audio.src = clips[i].url;
    audio.onended = () => playFrom(idxRef.current + 1);
    audio.onerror = () => playFrom(idxRef.current + 1);
    void audio.play().then(() => {
      setStatus("playing");
      stopRaf(); rafRef.current = requestAnimationFrame(tick);
    }).catch(() => { setStatus("idle"); });
  }, [tick, stopRaf]);   // stable: buffering/duration read via refs, so onended always sees fresh values

  // Generate clips sentence-by-sentence; start playback as soon as the first lands.
  const streamKokoro = useCallback(async (text: string, token: number) => {
    const list = sentences(text);
    if (!list.length) { setStatus("idle"); return; }
    setSentenceList(list);   // caption renders these exact chunks; activeIndex points into them
    setBuffering(true); bufferingRef.current = true;
    let started = false;
    for (const sentence of list) {
      if (token !== tokenRef.current) return;
      try {
        const res = await fetch("/api/speak", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: sentence.slice(0, 1000) }),
        });
        if (token !== tokenRef.current) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (token !== tokenRef.current) { return; }
        const url = URL.createObjectURL(blob);
        // Push the clip with a provisional duration and START PLAYING IMMEDIATELY
        // — don't block the first sound on a metadata round-trip. We backfill the
        // real duration (for the scrubber timeline) right after.
        const clip: Clip = { url, duration: 0, sentence };
        clipsRef.current.push(clip);
        if (!started) { started = true; playFrom(0); }
        else if (waitingRef.current && !pausedRef.current) { waitingRef.current = false; playFrom(idxRef.current + 1); }   // resume stalled playback (unless user paused)
        void measureDuration(url).then((dur) => {
          if (token !== tokenRef.current) return;
          const delta = dur - clip.duration;
          clip.duration = dur;
          if (delta) { durationRef.current += delta; setDuration((d) => d + delta); }
        });
      } catch {
        // Sidecar died mid-stream — stop generating, keep what we have.
        break;
      }
    }
    setBuffering(false); bufferingRef.current = false;
    // Generation finished (or aborted mid-stream). Reconcile playback now that
    // bufferingRef is false: if playback parked waiting for a clip, kick it once
    // more — it plays a remaining clip, or finalizes cleanly if there is none
    // (covers a sidecar that died during a buffering gap). Otherwise, if playback
    // already ran past the end, finalize.
    if (token === tokenRef.current) {
      if (waitingRef.current && !pausedRef.current) { waitingRef.current = false; playFrom(idxRef.current + 1); }
      else if (!waitingRef.current && idxRef.current >= clipsRef.current.length) {
        setStatus("idle"); setActiveIndex(-1); setActiveFraction(0); fracRef.current = 0;
      }
    }
  }, [playFrom]);

  const play = useCallback(async (text: string) => {
    // Exclusive playback: stop every OTHER live reader first so two narrations
    // can never overlap (auto-spoken reply vs. a manual Listen, etc.).
    for (const s of [...readerStops]) if (s !== selfStopRef.current) s();
    teardown();                  // bumps tokenRef, cancelling any prior session
    const token = tokenRef.current;
    setStatus("loading"); setCurrentTime(0); setDuration(0); durationRef.current = 0; waitingRef.current = false; pausedRef.current = false;
    setActiveIndex(-1); setActiveFraction(0); fracRef.current = 0; setSentenceList([]);
    const engine = await detectEngine();
    if (token !== tokenRef.current) return;
    if (engine === "kokoro") {
      void streamKokoro(text, token);
      return;
    }
    // Browser fallback — single utterance, no retry loop.
    if (browserRef.current) {
      const u = new SpeechSynthesisUtterance(cleanForSpeech(text).slice(0, 8000));
      u.rate = 1.05;
      u.onstart = () => setStatus("playing");
      u.onend = () => setStatus("idle");
      u.onerror = () => setStatus("idle");
      try { window.speechSynthesis.speak(u); setStatus("playing"); } catch { setStatus("idle"); }
    } else {
      setStatus("idle");
    }
  }, [teardown, streamKokoro]);

  const pause = useCallback(() => {
    if (browserRef.current && window.speechSynthesis.speaking) { try { window.speechSynthesis.pause(); } catch {} setStatus("paused"); return; }
    // Mark user-paused so a buffering-gap clip arrival won't auto-resume against
    // intent; pause the element too if it's actually mid-clip (vs. parked/ended).
    pausedRef.current = true;
    if (audioRef.current && !audioRef.current.paused) { audioRef.current.pause(); stopRaf(); }
    setStatus("paused");
  }, [stopRaf]);

  const resume = useCallback(() => {
    pausedRef.current = false;
    if (browserRef.current && window.speechSynthesis.paused) { try { window.speechSynthesis.resume(); } catch {} setStatus("playing"); return; }
    // Parked during a buffering gap (audio ended, waiting for the next clip):
    // kick playback to the next available clip (or re-park if none yet).
    if (waitingRef.current) { waitingRef.current = false; playFrom(idxRef.current + 1); return; }
    if (audioRef.current && audioRef.current.src && audioRef.current.paused) {
      void audioRef.current.play().then(() => { setStatus("playing"); rafRef.current = requestAnimationFrame(tick); }).catch(() => {});
    }
  }, [tick, playFrom]);

  // Seek to an absolute second on the timeline → find the clip + offset within it.
  const seek = useCallback((sec: number) => {
    const clips = clipsRef.current;
    if (!clips.length) return;
    let acc = 0, target = Math.max(0, Math.min(sec, duration));
    for (let i = 0; i < clips.length; i++) {
      if (target < acc + clips[i].duration || i === clips.length - 1) {
        idxRef.current = i;
        waitingRef.current = false; pausedRef.current = false;   // explicit reposition cancels parked/paused state
        setActiveIndex(i); fracRef.current = 0; setActiveFraction(0);   // keep the caption in sync with the scrub
        const within = target - acc;
        const audio = audioRef.current ?? new Audio();
        audioRef.current = audio;
        const wasPlaying = status === "playing";
        audio.src = clips[i].url;
        audio.onended = () => playFrom(idxRef.current + 1);
        audio.onerror = () => playFrom(idxRef.current + 1);
        const apply = () => { audio.currentTime = within; setCurrentTime(target); };
        if (wasPlaying) void audio.play().then(() => { apply(); rafRef.current = requestAnimationFrame(tick); }).catch(() => {});
        else { audio.onloadedmetadata = apply; setCurrentTime(target); }
        return;
      }
      acc += clips[i].duration;
    }
  }, [duration, status, playFrom, tick]);

  // Clean up on unmount.
  useEffect(() => () => { teardown(); }, [teardown]);

  return { status, currentTime, duration, buffering, sentenceList, activeIndex, activeFraction, play, pause, resume, stop, seek };
}

// Load an audio URL just long enough to read its duration.
function measureDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = "metadata";
    a.onloadedmetadata = () => resolve(Number.isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => resolve(0);
    a.src = url;
  });
}
