/* Layered conversational memory for Aria, the local agent.
 *
 *   Tier        Form          Default count   Scope          Lives in
 *   ─────────   ────────      ─────────────   ──────────     ─────────────────────
 *   core        fact line     unbounded       GLOBAL         memory/core.json
 *   long        theme line    100+            per project    memory/projects/<k>/themes.json
 *   mid         paragraph     20→100          per project    memory/projects/<k>/summaries.json
 *   recent      full turn     last 20         per project    memory/projects/<k>/turns/*.json
 *
 * Core is shared across every project (who you are, how you like to work). The
 * other three tiers are scoped per project so juggling many projects never
 * bleeds one conversation into another. Each project also keeps its own Claude
 * session id, so switching projects resumes the right in-process context.
 *
 * On every Send we build a memory block (core + that project's long/mid/recent)
 * and inject it into the prompt. After each Send, eviction rolls the project's
 * overflowing turns recent→mid and mid→long via a cheap Haiku spawn.
 *
 * Storage is plain JSON under app/data/memory/ — easy to inspect, edit, wipe.
 * Gitignored. */

import { mkdir, readFile, writeFile, rename, readdir, unlink, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const ROOT = join(process.cwd(), "data", "memory");
const CORE_FILE = join(ROOT, "core.json");           // global
const PROJECTS_ROOT = join(ROOT, "projects");        // per-project buckets

// Per-project paths.
function projDir(key: string) { return join(PROJECTS_ROOT, key); }
function turnsDir(key: string) { return join(projDir(key), "turns"); }
function summariesFile(key: string) { return join(projDir(key), "summaries.json"); }
function themesFile(key: string) { return join(projDir(key), "themes.json"); }
function sessionFile(key: string) { return join(projDir(key), "session.json"); }      // legacy single-session (migrated)
function sessionsFile(key: string) { return join(projDir(key), "sessions.json"); }     // multi-session registry

// Tier sizes — see file header for rationale.
const RECENT_LIMIT = 20;
const MID_LIMIT = 80;        // turns 21..100 → 80 summaries
const LONG_TIER_TARGET = 30; // collapse to ~30 theme lines max
// If a project has been idle this long, the prompt cache has likely expired
// (~5 min) so the next Send re-injects the full memory block instead of
// trusting --resume's in-process context.
const IDLE_REINJECT_MS = 4 * 60 * 1000;

export type Turn = {
  id: number;
  ts: string;              // ISO
  prompt: string;
  reply: string;
  toolUses: string[];
  sessionId?: string;      // claude session id that produced this turn
  sessionKey?: string;     // which Aria session/tab this turn belongs to
  sessionLabel?: string;   // display name of that session (denormalized for grouping)
  category?: string;       // topic title for grouping (e.g. "Auth", "UI") — optional
  kind?: "handoff";        // a system-seeded turn (e.g. a flow carried over from Mission Control), not user-typed
};

export type Summary = {
  id: number;              // turn id it summarizes
  ts: string;
  text: string;            // ~1 paragraph
  category?: string;       // inherited/derived topic title
  sessionKey?: string;     // which session the source turn belonged to
};

export type Theme = {
  text: string;            // ~1 line
  derivedFrom: number[];   // turn ids
  category?: string;       // topic title for grouping
};

// Core memory: the constant, GLOBAL tier. Never summarized, distilled, or
// evicted — injected verbatim at the top of every project's memory block. The
// curated "always true" stuff Aria should know on every project.
export type CoreFact = {
  id: string;
  text: string;
  ts: string;                              // when pinned
  source: "seed" | "user" | "aria" | "flow";  // who pinned it
  category?: string;                       // topic title for grouping
  created_at?: string;                     // ISO timestamp for flow ingestions
};

type SessionState = {
  sessionId: string | null;
  lastTurnAt: number;      // ms since epoch
};

// A named session ("tab") within a project. Each has its own claude --resume id;
// all of a project's sessions feed the same layered memory, grouped by session.
export type Session = {
  key: string;             // stable id for this session (uuid)
  label: string;           // user-facing name ("Auth work")
  claudeSessionId: string | null;  // the claude session id to --resume
  nameLocked?: boolean;    // true once the user renames it → don't auto-name
  createdAt: number;
  lastTurnAt: number;
};

async function ensureDir(path: string) {
  if (!existsSync(path)) await mkdir(path, { recursive: true });
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, data: unknown) {
  await mkdir(dirname(path), { recursive: true });
  // Atomic write: write to a unique tmp file, then rename over the target.
  // rename is atomic on POSIX, so a reader sees either the old whole file or
  // the new whole file — never a torn one. The pid+random suffix keeps
  // concurrent writers to the same path from colliding on one .tmp name.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Turn read/write (per project)
// ────────────────────────────────────────────────────────────────────────────

export async function listTurns(key: string): Promise<Turn[]> {
  const dir = turnsDir(key);
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  const turns: Turn[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const t = await readJson<Turn | null>(join(dir, f), null);
    if (t) turns.push(t);
  }
  return turns.sort((a, b) => a.id - b.id);
}

export async function appendTurn(
  key: string,
  turn: Omit<Turn, "id" | "ts"> & { id?: number; ts?: string },
): Promise<Turn> {
  await ensureDir(turnsDir(key));
  const existing = await listTurns(key);
  const id = turn.id ?? (existing.length === 0 ? 1 : existing[existing.length - 1].id + 1);
  const full: Turn = {
    id, ts: turn.ts ?? new Date().toISOString(),
    prompt: turn.prompt, reply: turn.reply, toolUses: turn.toolUses, sessionId: turn.sessionId,
    sessionKey: turn.sessionKey, sessionLabel: turn.sessionLabel,
    category: turn.category, kind: turn.kind,
  };
  await writeJson(join(turnsDir(key), `${String(id).padStart(6, "0")}.json`), full);
  return full;
}

export async function deleteTurn(key: string, id: number): Promise<void> {
  const path = join(turnsDir(key), `${String(id).padStart(6, "0")}.json`);
  if (existsSync(path)) await unlink(path);
}

/** Re-tag one recent turn's category (UI edit). Returns false if not found. */
export async function setTurnCategory(key: string, id: number, category: string): Promise<boolean> {
  const path = join(turnsDir(key), `${String(id).padStart(6, "0")}.json`);
  if (!existsSync(path)) return false;
  const t = await readJson<Turn | null>(path, null);
  if (!t) return false;
  await writeJson(path, { ...t, category: category.trim() || undefined });
  return true;
}

/* Categorize a turn into a short topic title (1-3 words) via Haiku. Cheap and
 * fire-and-forget — used to tag turns in the background after they complete, so
 * it never adds latency to the chat reply. Falls back to undefined on failure. */
export async function categorizeTurn(prompt: string, reply: string): Promise<string | undefined> {
  const p = `Give a SHORT topic title (1-3 words, Title Case) that categorizes this exchange for a memory index. Examples: "Auth", "UI Redesign", "Build Setup", "Bug Triage". Reply with ONLY the title, nothing else.\n\nUser: ${prompt.slice(0, 400)}\nAssistant: ${reply.slice(0, 400)}`;
  try {
    const out = (await spawnHaiku(p, 15_000)).trim().replace(/^["']|["']$/g, "").split("\n")[0];
    return out && out.length <= 32 ? out : undefined;
  } catch { return undefined; }
}

/** Background-tag a recently-appended turn (non-blocking; best-effort). */
export async function autoTagTurn(key: string, id: number): Promise<void> {
  try {
    const turns = await listTurns(key);
    const t = turns.find((x) => x.id === id);
    if (!t || t.category) return;
    const cat = await categorizeTurn(t.prompt, t.reply);
    if (cat) await setTurnCategory(key, id, cat);
  } catch { /* best effort */ }
}

/** Wipe a project's conversational memory (recent + mid + long + session).
 *  Global core survives. */
export async function clearAll(key: string): Promise<void> {
  const dir = turnsDir(key);
  if (existsSync(dir)) {
    for (const f of await readdir(dir)) await unlink(join(dir, f));
  }
  for (const p of [summariesFile(key), themesFile(key), sessionFile(key)]) {
    if (existsSync(p)) await unlink(p);
  }
}

/** HARD RESET — wipe ALL memory: every project's turns/summaries/themes/sessions
 *  AND the global core facts. Daryan starts completely fresh; core re-seeds on
 *  the next access. Destructive and irreversible — gate it behind a typed
 *  confirmation in the UI. Does NOT touch agents/flows (only memory/). */
export async function hardResetMemory(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────────────────
// Summaries + themes (per project)
// ────────────────────────────────────────────────────────────────────────────

export async function listSummaries(key: string): Promise<Summary[]> {
  return await readJson<Summary[]>(summariesFile(key), []);
}

export async function listThemes(key: string): Promise<Theme[]> {
  return await readJson<Theme[]>(themesFile(key), []);
}

async function setSummaries(key: string, s: Summary[]) { await writeJson(summariesFile(key), s); }
async function setThemes(key: string, t: Theme[]) { await writeJson(themesFile(key), t); }

// ────────────────────────────────────────────────────────────────────────────
// Core memory (constant, GLOBAL tier) — seed once, then enrich. Never evicted.
// ────────────────────────────────────────────────────────────────────────────

/* The starting set of always-remembered facts. Seeded into core.json on first
 * access. After that the file is the source of truth — edits/deletes stick and
 * seeds are never resurrected. Keep this short, high-signal, and GENERIC: it
 * applies to every project. Pin project-specific facts as core only if they're
 * truly always relevant; otherwise let them live in per-project memory. */
const DEFAULT_CORE: Pick<CoreFact, "text" | "source">[] = [
  { text: "You are Daryan, a local voice-driven Claude Code agent. You work across the project folders in the workspace; the user picks which project is active. You have full tool access to that project and can reach sibling projects in the same workspace when asked.", source: "seed" },
  { text: "Lead with the recommendation or decision, then the reasoning. Be terse and concrete. End with the next concrete step.", source: "seed" },
];

async function ensureCoreSeeded(): Promise<void> {
  if (existsSync(CORE_FILE)) return;
  const seeded: CoreFact[] = DEFAULT_CORE.map((c) => ({ id: randomUUID(), ts: new Date().toISOString(), ...c }));
  await writeJson(CORE_FILE, seeded);
}

export async function listCore(): Promise<CoreFact[]> {
  await ensureCoreSeeded();
  return await readJson<CoreFact[]>(CORE_FILE, []);
}

export async function addCore(text: string, source: CoreFact["source"] = "user", category?: string): Promise<CoreFact | null> {
  const clean = text.trim();
  if (!clean) return null;
  const list = await listCore();
  const fact: CoreFact = { id: randomUUID(), ts: new Date().toISOString(), text: clean, source, category: category?.trim() || undefined };
  list.push(fact);
  await writeJson(CORE_FILE, list);
  return fact;
}

export async function updateCore(id: string, text: string, category?: string): Promise<boolean> {
  const clean = text.trim();
  if (!clean) return false;
  const list = await listCore();
  const i = list.findIndex((c) => c.id === id);
  if (i === -1) return false;
  // category: undefined arg = leave as-is; empty string = clear; value = set
  const nextCat = category === undefined ? list[i].category : (category.trim() || undefined);
  list[i] = { ...list[i], text: clean, category: nextCat };
  await writeJson(CORE_FILE, list);
  return true;
}

export async function removeCore(id: string): Promise<void> {
  const list = await listCore();
  await writeJson(CORE_FILE, list.filter((c) => c.id !== id));
}

// ────────────────────────────────────────────────────────────────────────────
// Session continuity (per project)
// ────────────────────────────────────────────────────────────────────────────

// Legacy single-session accessors (kept for any old callers). The multi-session
// registry below is the source of truth going forward.
export async function getSession(key: string): Promise<SessionState> {
  return await readJson<SessionState>(sessionFile(key), { sessionId: null, lastTurnAt: 0 });
}

export async function setSession(key: string, state: SessionState) {
  await writeJson(sessionFile(key), state);
}

// ── Multi-session registry (tabs) ──
// Each project holds a list of named sessions; each has its own claude --resume
// id. All sessions feed the project's one layered memory, grouped by session.

export async function listSessions(projectKey: string): Promise<Session[]> {
  const list = await readJson<Session[]>(sessionsFile(projectKey), []);
  // One-time migration: fold a legacy single session into the registry.
  if (list.length === 0 && existsSync(sessionFile(projectKey))) {
    const legacy = await getSession(projectKey);
    if (legacy.sessionId || legacy.lastTurnAt) {
      const migrated: Session = { key: randomUUID(), label: "Session 1", claudeSessionId: legacy.sessionId, createdAt: legacy.lastTurnAt || Date.now(), lastTurnAt: legacy.lastTurnAt || Date.now() };
      await writeJson(sessionsFile(projectKey), [migrated]);
      return [migrated];
    }
  }
  return list.sort((a, b) => b.lastTurnAt - a.lastTurnAt);
}

export async function getSessionByKey(projectKey: string, sessionKey: string): Promise<Session | null> {
  return (await listSessions(projectKey)).find((s) => s.key === sessionKey) ?? null;
}

/** Create a new session ("tab") in a project. */
export async function createSession(projectKey: string, label?: string): Promise<Session> {
  const list = await readJson<Session[]>(sessionsFile(projectKey), []);
  const s: Session = {
    key: randomUUID(),
    label: label?.trim() || `Session ${list.length + 1}`,
    claudeSessionId: null,
    createdAt: Date.now(),
    lastTurnAt: Date.now(),
  };
  list.push(s);
  await writeJson(sessionsFile(projectKey), list);
  return s;
}

/** Update a session's claude id / lastTurnAt / label / nameLocked. */
export async function updateSession(projectKey: string, sessionKey: string, patch: Partial<Pick<Session, "label" | "claudeSessionId" | "lastTurnAt" | "nameLocked">>): Promise<Session | null> {
  const list = await readJson<Session[]>(sessionsFile(projectKey), []);
  const i = list.findIndex((s) => s.key === sessionKey);
  if (i === -1) return null;
  list[i] = { ...list[i], ...patch, label: patch.label?.trim() || list[i].label };
  await writeJson(sessionsFile(projectKey), list);
  return list[i];
}

/* Auto-name an UNRENAMED session from its first prompt — a 2-word Title-Case
 * label via a cheap Haiku call. No-op if the user already named it (nameLocked)
 * or it already moved past its default "Session N" name. Best-effort. */
export async function autoNameSession(projectKey: string, sessionKey: string, firstPrompt: string): Promise<void> {
  try {
    const s = await getSessionByKey(projectKey, sessionKey);
    if (!s || s.nameLocked) return;
    if (!/^Session \d+$/.test(s.label)) return;   // already has a real name
    const prompt = `Give a 2-word Title-Case label (exactly two words) that captures the topic of this request, for a tab name. Examples: "Auth Refactor", "Bug Triage", "Docs Cleanup". Reply with ONLY the two words.\n\nRequest: ${firstPrompt.slice(0, 300)}`;
    const out = await spawnHaiku(prompt, 15_000);
    const words = out.replace(/["'.]/g, "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (words.length >= 1) {
      const label = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
      if (label && label.length <= 32) await updateSession(projectKey, sessionKey, { label });
    }
  } catch { /* best effort */ }
}

export async function deleteSession(projectKey: string, sessionKey: string): Promise<void> {
  const list = await readJson<Session[]>(sessionsFile(projectKey), []);
  await writeJson(sessionsFile(projectKey), list.filter((s) => s.key !== sessionKey));
}

/** Recall a session: full turn history if still in the recent buffer, else the
 *  summaries derived from it (clearly flagged). */
export async function sessionHistory(projectKey: string, sessionKey: string): Promise<{ mode: "full" | "summary" | "empty"; turns: Turn[]; summaries: Summary[] }> {
  const [turns, summaries] = await Promise.all([listTurns(projectKey), listSummaries(projectKey)]);
  const myTurns = turns.filter((t) => t.sessionKey === sessionKey);
  if (myTurns.length > 0) return { mode: "full", turns: myTurns, summaries: [] };
  // Turns evicted → fall back to the summaries derived from this session's turns
  // (summaries carry the source turn's sessionKey).
  const mine = summaries.filter((s) => s.sessionKey === sessionKey);
  if (mine.length > 0) return { mode: "summary", turns: [], summaries: mine };
  return { mode: "empty", turns: [], summaries: [] };
}

// ────────────────────────────────────────────────────────────────────────────
// Memory block — what we inject into the prompt for a given project
// ────────────────────────────────────────────────────────────────────────────

/* Returns a single string ready to prepend to the user's prompt. Empty only if
 * there is genuinely nothing (no core and a brand-new project). */
// ── Memory compaction (keep the INJECTED block lean) ──
// The stored turn keeps the FULL reply (so on-screen history stays intact on
// reload); what we INJECT is compacted. The verbatim recent-turn block is ~80%
// of the per-turn token weight, and most of it is UI scaffolding the model never
// needs replayed: the [[SUMMARY]]/[[NEXT]] markers, and big artifacts (code
// blocks, decks, file dumps). Strip those + cap length → big cut, low risk.
const SUMMARY_BLOCK_RE = /\[\[\s*(?:SUMMARY|SPEAK)\s*\]\]([\s\S]*?)\[\[\s*\/\s*(?:SUMMARY|SPEAK)\s*\]\]/i;

// The agent's own ear-friendly recap, if present — a ready-made turn summary.
export function extractSummary(reply: string): string {
  const m = SUMMARY_BLOCK_RE.exec(reply);
  return m && m[1].trim() ? m[1].trim() : "";
}

// Compact a reply for INJECTION: drop the recap block + UI markers, truncate
// large fenced code blocks to a reference, and cap length. Falls back to the
// recap when the reply was essentially just that (voice-first concise turns).
const COMPACT_CAP = 1600;
export function compactReply(reply: string): string {
  const detail = reply
    .replace(/\[\[\s*(?:SUMMARY|SPEAK)\s*\]\][\s\S]*?\[\[\s*\/\s*(?:SUMMARY|SPEAK)\s*\]\]/gi, "")   // recap block (reused as the mid-tier summary; not needed verbatim)
    .replace(/\[\[\s*(?:NEXT|FLOW|ASK)\b[\s\S]*?\]\]/gi, "")                                          // UI action markers (non-greedy: tolerates a literal ] inside an attribute)
    .replace(/\[\[\s*\/?\s*(?:SUMMARY|SPEAK|NEXT|FLOW|ASK)\b[\s\S]*$/i, "")                            // any dangling/partial marker (mid-stream)
    .replace(/```[\s\S]*?```/g, (b) => b.length > 300 ? "```\n[code omitted from memory — re-read the file if needed]\n```" : b)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  let body = detail.length >= 40 ? detail : (extractSummary(reply) || detail);
  if (body.length > COMPACT_CAP) body = body.slice(0, COMPACT_CAP).trimEnd() + " […trimmed for memory…]";
  return body;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + "…" : s);

export async function buildMemoryBlock(key: string, projectName: string): Promise<string> {
  const [core, turns, summaries, themes] = await Promise.all([
    listCore(), listTurns(key), listSummaries(key), listThemes(key),
  ]);
  const recent = turns.slice(-RECENT_LIMIT);
  if (core.length === 0 && recent.length === 0 && summaries.length === 0 && themes.length === 0) return "";

  const parts: string[] = [
    "<persona-memory>",
    `You are Daryan, the user's local Claude Code agent. The active project is "${projectName}" — your working directory is this project, and the whole workspace is on --add-dir so you can reach sibling projects when asked. The user is mid-conversation with you. Below is your memory, layered: core (always true, all projects), then this project's long-term themes, mid-term summaries, and recent full turns. Use this context as if you remember it. Do not narrate that you're loading memory — just respond naturally.`,
    "",
  ];

  if (core.length > 0) {
    parts.push("## Core memory (always true — every project)");
    for (const c of core) parts.push(`- ${c.text}`);
    parts.push("");
  }

  if (themes.length > 0) {
    parts.push(`## Long-term themes — ${projectName}`);
    for (const t of themes) parts.push(`- ${t.text}`);
    parts.push("");
  }

  if (summaries.length > 0) {
    parts.push(`## Earlier summaries — ${projectName} (oldest first)`);
    for (const s of summaries) parts.push(`- [turn ${s.id}] ${s.text}`);
    parts.push("");
  }

  if (recent.length > 0) {
    parts.push(`## Recent turns — ${projectName} (oldest first)`);
    for (const t of recent) {
      parts.push(`### Turn ${t.id} — ${t.ts}`);
      parts.push(`User: ${clip(t.prompt, 600)}`);
      parts.push(`You: ${compactReply(t.reply)}`);
      if (t.toolUses.length > 0) parts.push(`(tools used: ${t.toolUses.join(", ")})`);
      parts.push("");
    }
  }

  parts.push("</persona-memory>");
  return parts.join("\n");
}

/* Decide whether to inject the memory block on this Send for a project.
 *   - First turn for this project → inject (nothing to resume).
 *   - Idle gap > IDLE_REINJECT_MS → inject (cache expired).
 *   - Otherwise → don't inject, rely on --resume to keep continuity. */
export async function shouldInject(key: string): Promise<{ inject: boolean; reason: "first" | "idle" | "fresh" }> {
  const session = await getSession(key);
  if (!session.sessionId) return { inject: true, reason: "first" };
  if (Date.now() - session.lastTurnAt > IDLE_REINJECT_MS) return { inject: true, reason: "idle" };
  return { inject: false, reason: "fresh" };
}

// ────────────────────────────────────────────────────────────────────────────
// Eviction: roll turns recent → mid, mid → long when limits hit (per project).
// ────────────────────────────────────────────────────────────────────────────

/* Run after each successful turn. Cheap: hits Haiku only when actually rolling
 * something out of a tier. Errors are swallowed — eviction failure shouldn't
 * break the user's chat. */
export async function evictIfNeeded(key: string): Promise<void> {
  try {
    await evictRecentToMid(key);
    await collapseMidToLong(key);
  } catch (err) {
    console.warn("[persona-memory] eviction failed:", (err as Error).message);
  }
}

async function evictRecentToMid(key: string) {
  const turns = await listTurns(key);
  if (turns.length <= RECENT_LIMIT) return;
  const summaries = await listSummaries(key);
  const knownIds = new Set(summaries.map((s) => s.id));
  const overflow = turns.slice(0, turns.length - RECENT_LIMIT).filter((t) => !knownIds.has(t.id));
  for (const t of overflow) {
    const text = await summarizeTurn(t);
    // Inherit the turn's category; if it was never tagged, derive one now (we're
    // already in the background eviction path, so the extra Haiku call is fine).
    const category = t.category ?? await categorizeTurn(t.prompt, t.reply);
    summaries.push({ id: t.id, ts: t.ts, text, category, sessionKey: t.sessionKey });
    await setSummaries(key, summaries);
    await deleteTurn(key, t.id);
  }
}

async function collapseMidToLong(key: string) {
  const summaries = await listSummaries(key);
  if (summaries.length <= MID_LIMIT) return;
  const overflow = summaries.splice(0, summaries.length - MID_LIMIT);
  let themes = await listThemes(key);
  themes = await distillIntoThemes(overflow, themes);
  if (themes.length > LONG_TIER_TARGET) themes = await recompressThemes(themes);
  await setSummaries(key, summaries);
  await setThemes(key, themes);
}

// ────────────────────────────────────────────────────────────────────────────
// Haiku-driven summarization. Cheap, async; shells out to `claude -p` on Haiku.
// Summarization is pure text work — it runs in the app dir, not a project, so
// it never pulls in project files or CLAUDE.md.
// ────────────────────────────────────────────────────────────────────────────

const HAIKU_MODEL = process.env.ARIA_MEMORY_MODEL || "claude-haiku-4-5-20251001";

async function spawnHaiku(prompt: string, timeoutMs = 30_000): Promise<string> {
  const bin = process.platform === "win32" ? "claude.cmd" : "claude";
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, [
      "-p",
      "--output-format", "text",
      "--input-format", "text",
      "--model", HAIKU_MODEL,
      "--dangerously-skip-permissions",
    ], {
      cwd: process.cwd(),
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error(`Haiku summarization timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Haiku exited ${code}: ${err.slice(-200)}`));
      resolve(out.trim());
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function summarizeTurn(t: Turn): Promise<string> {
  // Reuse the agent's own [[SUMMARY]] recap when present — it IS a turn summary
  // ("what I did + what's next"), so we skip the Haiku call entirely. Only fall
  // back to a Haiku summary for turns without one (flow/handoff/legacy turns).
  const recap = extractSummary(t.reply);
  if (recap) return clip(recap, 600);
  const prompt = `Summarize the following exchange in 1-2 sentences. Capture the user's intent, what you (Daryan) decided or produced, and any durable facts/preferences mentioned. Drop pleasantries.\n\nUser: ${t.prompt}\n\nYou: ${t.reply}\n\n(tools used: ${t.toolUses.join(", ") || "none"})\n\nReply with just the summary text, no prefix.`;
  try {
    return await spawnHaiku(prompt);
  } catch {
    return `User asked: ${t.prompt.slice(0, 120)}… You replied: ${t.reply.slice(0, 200)}…`;
  }
}

// Themes carry a category via a `[Category] text` line format that Haiku emits
// and we parse back out, so the long tier groups the same way the others do.
function parseThemeLine(line: string): Theme {
  const clean = line.replace(/^[-*]\s*/, "").trim();
  const m = clean.match(/^\[([^\]]{1,32})\]\s*(.+)$/);
  if (m) return { text: m[2].trim(), derivedFrom: [], category: m[1].trim() };
  return { text: clean, derivedFrom: [] };
}

async function distillIntoThemes(newSummaries: Summary[], existingThemes: Theme[]): Promise<Theme[]> {
  const themesText = existingThemes.length === 0 ? "(none)" : existingThemes.map((t) => `- [${t.category ?? "General"}] ${t.text}`).join("\n");
  const summariesText = newSummaries.map((s) => `- [${s.category ?? "General"}] [turn ${s.id}] ${s.text}`).join("\n");
  const prompt = `You maintain a long-term theme list for a conversational AI's memory. Themes are 1-line crystallizations of patterns across many exchanges (decisions, preferences, recurring work, durable facts). Each theme has a short topic category.\n\nExisting themes:\n${themesText}\n\nNew summaries to integrate:\n${summariesText}\n\nReturn the updated theme list, one per line, each formatted EXACTLY as: - [Category] theme text. Use a short Title-Case category (1-3 words). Merge related themes, drop stale ones. No preamble.`;
  try {
    const out = await spawnHaiku(prompt);
    const lines = out.split("\n").filter((l) => l.trim().startsWith("-") || l.includes("]"));
    const allIds = newSummaries.map((s) => s.id).concat(existingThemes.flatMap((t) => t.derivedFrom));
    return lines.map((l) => ({ ...parseThemeLine(l), derivedFrom: allIds }));
  } catch {
    return [...existingThemes, ...newSummaries.map((s) => ({ text: s.text, derivedFrom: [s.id], category: s.category }))];
  }
}

async function recompressThemes(themes: Theme[]): Promise<Theme[]> {
  const prompt = `The following theme list has grown too long. Compress it to at most ${LONG_TIER_TARGET} themes by merging related ones. Return one theme per line, each formatted EXACTLY as: - [Category] theme text (short Title-Case category). No preamble.\n\n${themes.map((t) => `- [${t.category ?? "General"}] ${t.text}`).join("\n")}`;
  try {
    const out = await spawnHaiku(prompt);
    const lines = out.split("\n").filter((l) => l.trim().startsWith("-") || l.includes("]"));
    const allIds = themes.flatMap((t) => t.derivedFrom);
    return lines.map((l) => ({ ...parseThemeLine(l), derivedFrom: allIds }));
  } catch {
    return themes.slice(-LONG_TIER_TARGET);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Sizing helpers for the Memory drawer UI (per project)
// ────────────────────────────────────────────────────────────────────────────

export async function memoryStats(key: string) {
  const [core, turns, summaries, themes, session] = await Promise.all([
    listCore(), listTurns(key), listSummaries(key), listThemes(key), getSession(key),
  ]);
  let onDiskBytes = 0;
  try {
    const dir = turnsDir(key);
    if (existsSync(dir)) {
      for (const f of await readdir(dir)) onDiskBytes += (await stat(join(dir, f))).size;
    }
    for (const p of [summariesFile(key), themesFile(key), sessionFile(key), CORE_FILE]) {
      if (existsSync(p)) onDiskBytes += (await stat(p)).size;
    }
  } catch {}
  return {
    core: core.length,
    recentTurns: turns.length,
    summaries: summaries.length,
    themes: themes.length,
    sessionId: session.sessionId,
    lastTurnAt: session.lastTurnAt,
    onDiskBytes,
    limits: { recent: RECENT_LIMIT, mid: MID_LIMIT, long: LONG_TIER_TARGET },
  };
}
