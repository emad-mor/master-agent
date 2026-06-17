"use client";

// DaryanThinking — cinematic "thinking" state, ported from the agentic-ux-prototype
// CompanionThinking: a breathing center star, orbiting satellite stars, a
// multi-colour glow, and cycling status phrases. Pure visual; shown while Claude
// is preparing / has not yet streamed any text.

import { useEffect, useRef, useState } from "react";
import "./daryan-thinking.css";

const STATUS_PHRASES = [
  "Reading the project…",
  "Gathering context…",
  "Working through it…",
  "Checking the files…",
  "Tracing the code…",
  "Putting it together…",
];
const CYCLE_MS = 2200;

// 8 orbiting satellites — radius / speed / start angle / tilt, from the prototype.
const ORBITS = [
  { radius: 17, speed: 3.4, startDeg: 0, size: 4, tiltX: 15, tiltZ: 0, opacity: 0.55 },
  { radius: 17, speed: 4.6, startDeg: 180, size: 3, tiltX: -10, tiltZ: 30, opacity: 0.45 },
  { radius: 26, speed: 4.8, startDeg: 45, size: 5, tiltX: 20, tiltZ: -15, opacity: 0.7 },
  { radius: 26, speed: 3.8, startDeg: 225, size: 4, tiltX: -25, tiltZ: 10, opacity: 0.6 },
  { radius: 35, speed: 5.5, startDeg: 90, size: 6, tiltX: 10, tiltZ: -25, opacity: 0.75 },
  { radius: 35, speed: 5.0, startDeg: 270, size: 5, tiltX: -15, tiltZ: 20, opacity: 0.65 },
  { radius: 44, speed: 6.5, startDeg: 135, size: 7, tiltX: 5, tiltZ: -10, opacity: 0.5 },
  { radius: 44, speed: 6.0, startDeg: 315, size: 6, tiltX: -8, tiltZ: 15, opacity: 0.4 },
];

// Deterministic per-satellite flicker/resize params (index-derived so SSR/CSR match).
const STAR_PARAMS = ORBITS.map((_, i) => ({
  flickerDelay: `${((i * 0.37) % 2).toFixed(2)}s`,
  resizeFrom: (0.5 + ((i * 0.11) % 0.4)).toFixed(2),
  resizeTo: (1.3 + ((i * 0.07) % 0.5)).toFixed(2),
  resizeSpeed: `${(1.4 + ((i * 0.23) % 1.6)).toFixed(2)}s`,
}));

function starPath(size: number) {
  const h = size / 2;
  return `M${h} 0C${h * 1.08} ${h * 0.52},${h * 1.48} ${h * 0.92},${size} ${h}C${h * 1.48} ${h * 1.08},${h * 1.08} ${h * 1.48},${h} ${size}C${h * 0.92} ${h * 1.48},${h * 0.52} ${h * 1.08},0 ${h}C${h * 0.52} ${h * 0.92},${h * 0.92} ${h * 0.52},${h} 0Z`;
}

export function DaryanThinking() {
  const [idx, setIdx] = useState(0);
  const [fading, setFading] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    timer.current = setInterval(() => {
      setFading(true);
      setTimeout(() => {
        setIdx((p) => (p + 1) % STATUS_PHRASES.length);
        setFading(false);
      }, 330);
    }, CYCLE_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  return (
    <div className="thinking">
      <svg width="0" height="0" className="thinking-defs" aria-hidden>
        <defs>
          <linearGradient id="aria-star-grad" x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="#9a5bff" />
            <stop offset="1" stopColor="#c42b8a" />
          </linearGradient>
        </defs>
      </svg>

      <div className="thinking-stage">
        <div className="thinking-glow">
          <div className="thinking-glow__b thinking-glow__b--violet" />
          <div className="thinking-glow__b thinking-glow__b--indigo" />
          <div className="thinking-glow__b thinking-glow__b--magenta" />
          <div className="thinking-glow__b thinking-glow__b--rose" />
          <div className="thinking-glow__b thinking-glow__b--core" />
        </div>

        <div className="thinking-orbits">
          {ORBITS.map((orb, i) => {
            const delay = -(orb.startDeg / 360) * orb.speed;
            const p = STAR_PARAMS[i];
            return (
              <div
                key={i}
                className="thinking-ring"
                style={{
                  ["--orbit-speed" as string]: `${orb.speed}s`,
                  ["--orbit-delay" as string]: `${delay}s`,
                  ["--tilt-x" as string]: `${orb.tiltX}deg`,
                  ["--tilt-z" as string]: `${orb.tiltZ}deg`,
                }}
              >
                <div
                  className="thinking-sat"
                  style={{
                    ["--orbit-radius" as string]: `${orb.radius}px`,
                    ["--orbit-delay" as string]: `${delay}s`,
                    opacity: orb.opacity,
                  }}
                >
                  <svg
                    className="thinking-star thinking-star--flicker"
                    width={orb.size}
                    height={orb.size}
                    viewBox={`0 0 ${orb.size} ${orb.size}`}
                    fill="none"
                    style={{
                      ["--flicker-delay" as string]: p.flickerDelay,
                      ["--resize-from" as string]: p.resizeFrom,
                      ["--resize-to" as string]: p.resizeTo,
                      ["--resize-speed" as string]: p.resizeSpeed,
                    }}
                  >
                    <path d={starPath(orb.size)} fill="url(#aria-star-grad)" />
                  </svg>
                </div>
              </div>
            );
          })}
        </div>

        <div className="thinking-center">
          <svg className="thinking-center-star" width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden>
            <path d={starPath(28)} fill="url(#aria-star-grad)" />
          </svg>
        </div>
      </div>

      <p className={`thinking-status${fading ? " thinking-status--fading" : ""}`}>
        {STATUS_PHRASES[idx]}
      </p>
    </div>
  );
}
