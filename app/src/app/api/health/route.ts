import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

export type ModuleStatus = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
};

async function checkCLI(): Promise<ModuleStatus> {
  const bin = process.platform === "win32" ? "claude.cmd" : "claude";
  try {
    await execFileAsync(bin, ["--version"], { timeout: 4000 });
    return { id: "cli", label: "Claude CLI", ok: true, detail: "claude binary found" };
  } catch {
    return { id: "cli", label: "Claude CLI", ok: false, detail: "claude binary not found — install Claude Code CLI" };
  }
}

async function checkVoice(): Promise<ModuleStatus> {
  const url = process.env.KOKORO_URL
    ? process.env.KOKORO_URL.replace(/\/speak$/, "")
    : "http://127.0.0.1:8001";
  try {
    // Probe the sidecar's real /health and require it to report healthy — a 404
    // on / would be a false positive (the server is up but TTS may not be).
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) {
      return { id: "voice", label: "Voice Server", ok: false, detail: `Sidecar /health returned ${r.status}` };
    }
    const body = (await r.json().catch(() => null)) as { status?: string; voice?: string } | null;
    const healthy = body?.status === "ok";
    return {
      id: "voice",
      label: "Voice Server",
      ok: healthy,
      detail: healthy
        ? `Kokoro TTS sidecar healthy${body?.voice ? ` (voice: ${body.voice})` : ""}`
        : "Sidecar responding but not reporting healthy",
    };
  } catch {
    return { id: "voice", label: "Voice Server", ok: false, detail: "Kokoro TTS sidecar not running — run npm run dev to auto-start it" };
  }
}

async function checkFlowEngine(): Promise<ModuleStatus> {
  // A no-flows-yet store is healthy; a corrupt/unparseable registry is not.
  const registry = join(process.cwd(), "data", "flows", "registry.json");
  if (!existsSync(registry)) {
    return { id: "flows", label: "Flow Engine", ok: true, detail: "Flow store ready — no flows yet" };
  }
  try {
    const parsed = JSON.parse(await readFile(registry, "utf8")) as { flows?: unknown[] };
    const count = Array.isArray(parsed.flows) ? parsed.flows.length : 0;
    return { id: "flows", label: "Flow Engine", ok: true, detail: count === 1 ? "1 flow stored" : `${count} flows stored` };
  } catch {
    return { id: "flows", label: "Flow Engine", ok: false, detail: "data/flows/registry.json is corrupt — can't parse" };
  }
}

async function checkMemory(): Promise<ModuleStatus> {
  const memDir = join(process.cwd(), "data", "memory");
  if (!existsSync(memDir)) {
    return { id: "memory", label: "Memory", ok: false, detail: "data/memory not initialised — start a conversation to create it" };
  }
  try {
    // Per-project buckets live under memory/projects/* (siblings of the global
    // core.json) — count those directories, not every top-level entry.
    const projectsDir = join(memDir, "projects");
    let buckets = 0;
    if (existsSync(projectsDir)) {
      const entries = await readdir(projectsDir, { withFileTypes: true });
      buckets = entries.filter((e) => e.isDirectory()).length;
    }
    return { id: "memory", label: "Memory", ok: true, detail: buckets === 1 ? "1 project bucket stored" : `${buckets} project bucket(s) stored` };
  } catch {
    return { id: "memory", label: "Memory", ok: false, detail: "data/memory unreadable" };
  }
}

async function checkWorkspace(): Promise<ModuleStatus> {
  const wsDir = process.env.WORKSPACE_DIR
    ? resolve(process.env.WORKSPACE_DIR)
    : resolve(process.cwd(), "..", "workspace");
  if (!existsSync(wsDir)) {
    return { id: "workspace", label: "Workspace", ok: false, detail: `workspace/ folder missing at ${wsDir}` };
  }
  try {
    // Real project folders only: directories, no dotfiles, no build/junk dirs.
    const IGNORE = new Set(["node_modules", "dist", "out"]);
    const entries = await readdir(wsDir, { withFileTypes: true });
    const projects = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !IGNORE.has(e.name));
    return {
      id: "workspace",
      label: "Workspace",
      ok: projects.length > 0,
      detail: projects.length > 0
        ? `${projects.length} project(s) indexed`
        : "workspace/ is empty — add project folders",
    };
  } catch {
    return { id: "workspace", label: "Workspace", ok: false, detail: "workspace/ unreadable" };
  }
}

export async function GET() {
  const modules = await Promise.all([
    checkCLI(),
    checkVoice(),
    checkFlowEngine(),
    checkMemory(),
    checkWorkspace(),
  ]);
  return NextResponse.json({ modules, ts: Date.now() });
}
