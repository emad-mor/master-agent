"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, AlertTriangle, XCircle, RefreshCw } from "lucide-react";

type ModuleStatus = { id: string; label: string; ok: boolean; detail: string };
type HealthData = { modules: ModuleStatus[]; ts: number };

const POLL_MS = 30_000; // refresh every 30 s

function dot(color: string, size = 7) {
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        boxShadow: `0 0 5px ${color}aa`,
        flexShrink: 0,
      }}
    />
  );
}

/* Compact system-health control: a square icon button that lives in the header
 * beside the theme toggle. Its icon + color reflect overall module health; a
 * small badge appears when something needs attention. Clicking opens a popover
 * with the per-module detail. */
export function StatusBar() {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      if (r.ok) { setData(await r.json()); setError(false); }
      else setError(true);
    } catch {
      setError(true);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(true), POLL_MS);
    return () => clearInterval(id);
  }, []);

  // Dismiss the popover on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);

  const modules = data?.modules ?? [];
  const total = modules.length;
  const okCount = modules.filter((m) => m.ok).length;
  const allOk = okCount === total && total > 0;
  const allDown = okCount === 0 && total > 0;
  const errored = !data && error;
  const initialLoading = loading && !data;

  const accent = errored || allDown ? "#f87171" : allOk ? "#4ade80" : initialLoading ? "#94a3b8" : "#fbbf24";
  const Icon = initialLoading ? RefreshCw : errored ? XCircle : allOk ? CheckCircle2 : allDown ? XCircle : AlertTriangle;
  const summary = initialLoading
    ? "Checking system modules…"
    : errored
    ? "Health check unavailable"
    : allOk
    ? `All ${total} modules running`
    : `${okCount}/${total} modules running`;
  const needsAttention = !initialLoading && !allOk;

  return (
    <span ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="grid place-items-center w-9 h-9 rounded-lg border border-line text-mid hover:text-ink hover:border-mid/50 transition-colors"
        style={{ position: "relative" }}
        title={`System status — ${summary}`}
        aria-label={`System status: ${summary}`}
        aria-expanded={open}
      >
        <Icon size={15} style={{ color: accent, ...(initialLoading ? { animation: "spin 1s linear infinite" } : null) }} />
        {needsAttention && (
          <span
            style={{
              position: "absolute", top: 4, right: 4,
              width: 7, height: 7, borderRadius: "50%",
              background: accent, boxShadow: `0 0 5px ${accent}`,
              border: "1.5px solid var(--color-surface)",
            }}
          />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="System status"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            zIndex: 90,
            width: 290,
            padding: "11px 12px 12px",
            borderRadius: 12,
            border: "1px solid var(--color-line)",
            background: "var(--color-surface)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            boxShadow: "0 18px 50px rgba(0,0,0,0.32)",
            color: "var(--color-ink)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
            {dot(accent)}
            <span style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: "0.01em" }}>{summary}</span>
            <span style={{ flex: 1 }} />
            <button
              onClick={() => void load()}
              aria-label="Refresh status"
              title="Refresh status"
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-mid)", display: "flex", alignItems: "center", padding: 2 }}
            >
              <RefreshCw size={12} style={loading ? { animation: "spin 1s linear infinite" } : undefined} />
            </button>
          </div>

          {errored ? (
            <div style={{ fontSize: 11.5, color: "var(--color-mid)" }}>
              Couldn&apos;t reach <code>/api/health</code>. Check the dev server, then refresh.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {modules.map((m) => (
                <div key={m.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 11.5 }}>
                  <span style={{ marginTop: 3 }}>{dot(m.ok ? "#4ade80" : "#f87171", 6)}</span>
                  <span style={{ fontWeight: 600, minWidth: 86, color: m.ok ? "var(--color-ink)" : "#f87171" }}>{m.label}</span>
                  <span style={{ color: "var(--color-mid)", lineHeight: 1.35 }}>{m.detail}</span>
                </div>
              ))}
              {initialLoading && <div style={{ fontSize: 11.5, color: "var(--color-mid)" }}>Checking modules…</div>}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
