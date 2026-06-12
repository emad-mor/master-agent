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
    .replace(/\[\[\s*ASK\b[^\]]*\]\]/gi, "");
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

export function useReader() {
  const [status, setStatus] = useState<ReaderStatus>("idle");
  // Timeline surfaced to the control bar.
  const [currentTime, setCurrentTime] = useState(0);   // seconds elapsed across all clips
  const [duration, setDuration] = useState(0);          // total known seconds (grows as clips arrive)
  const [buffering, setBuffering] = useState(false);    // still generating later sentences

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const clipsRef = useRef<Clip[]>([]);
  const idxRef = useRef(0);                  // which clip is playing
  const tokenRef = useRef(0);                // bumped to cancel an in-flight session
  const browserRef = useRef(typeof window !== "undefined" && "speechSynthesis" in window);
  const rafRef = useRef<number | null>(null);

  // Sum of durations of clips BEFORE index i (the timeline offset of clip i).
  const offsetOf = useCallback((i: number) => {
    let s = 0;
    for (let k = 0; k < i && k < clipsRef.current.length; k++) s += clipsRef.current[k].duration;
    return s;
  }, []);

  const tick = useCallback(() => {
    const a = audioRef.current;
    if (a && !a.paused) setCurrentTime(offsetOf(idxRef.current) + (a.currentTime || 0));
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
  }, [teardown]);

  // Play clip at idxRef from its start. Advances on end.
  const playFrom = useCallback((i: number) => {
    const clips = clipsRef.current;
    if (i >= clips.length) {
      // Caught up to what's generated. If still buffering, wait; else done.
      if (buffering) { setStatus("playing"); return; }
      setStatus("idle"); setCurrentTime(duration); stopRaf();
      return;
    }
    idxRef.current = i;
    const audio = audioRef.current ?? new Audio();
    audioRef.current = audio;
    audio.src = clips[i].url;
    audio.onended = () => playFrom(idxRef.current + 1);
    audio.onerror = () => playFrom(idxRef.current + 1);
    void audio.play().then(() => {
      setStatus("playing");
      stopRaf(); rafRef.current = requestAnimationFrame(tick);
    }).catch(() => { setStatus("idle"); });
  }, [buffering, duration, tick, stopRaf]);

  // Generate clips sentence-by-sentence; start playback as soon as the first lands.
  const streamKokoro = useCallback(async (text: string, token: number) => {
    const list = sentences(text);
    if (!list.length) { setStatus("idle"); return; }
    setBuffering(true);
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
        // Measure duration without attaching to the playing element.
        const dur = await measureDuration(url);
        if (token !== tokenRef.current) { URL.revokeObjectURL(url); return; }
        clipsRef.current.push({ url, duration: dur, sentence });
        setDuration((d) => d + dur);
        if (!started) { started = true; playFrom(0); }
      } catch {
        // Sidecar died mid-stream — stop generating, keep what we have.
        break;
      }
    }
    setBuffering(false);
    // If playback already caught up to the end while we were buffering, finalize.
    if (token === tokenRef.current && idxRef.current >= clipsRef.current.length) {
      setStatus("idle");
    }
  }, [playFrom]);

  const play = useCallback(async (text: string) => {
    teardown();                  // bumps tokenRef, cancelling any prior session
    const token = tokenRef.current;
    setStatus("loading"); setCurrentTime(0); setDuration(0);
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
    if (audioRef.current && !audioRef.current.paused) { audioRef.current.pause(); stopRaf(); setStatus("paused"); return; }
    if (browserRef.current && window.speechSynthesis.speaking) { try { window.speechSynthesis.pause(); } catch {} setStatus("paused"); }
  }, [stopRaf]);

  const resume = useCallback(() => {
    if (audioRef.current && audioRef.current.src && audioRef.current.paused) {
      void audioRef.current.play().then(() => { setStatus("playing"); rafRef.current = requestAnimationFrame(tick); }).catch(() => {});
      return;
    }
    if (browserRef.current && window.speechSynthesis.paused) { try { window.speechSynthesis.resume(); } catch {} setStatus("playing"); }
  }, [tick]);

  // Seek to an absolute second on the timeline → find the clip + offset within it.
  const seek = useCallback((sec: number) => {
    const clips = clipsRef.current;
    if (!clips.length) return;
    let acc = 0, target = Math.max(0, Math.min(sec, duration));
    for (let i = 0; i < clips.length; i++) {
      if (target < acc + clips[i].duration || i === clips.length - 1) {
        idxRef.current = i;
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

  return { status, currentTime, duration, buffering, play, pause, resume, stop, seek };
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
