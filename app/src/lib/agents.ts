/* Named agents for Aria's orchestration layer (Phase 2).
 *
 * An Agent is a reusable persona/role you define once — name, instructions,
 * optional model + colour — and then reference from tasks and flow steps. The
 * orchestrator prepends the agent's instructions as a preamble to the prompt it
 * sends to `claude -p`, so "Researcher" / "Coder" / "Reviewer" behave distinctly.
 *
 * Persisted as plain JSON under app/data/agents/ — inspectable, editable,
 * gitignored — mirroring the persona-memory store. Node-only. */

import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const ROOT = join(process.cwd(), "data", "agents");

// An integration declared on an agent. The TOKEN never lives here — only the
// metadata (display name + the env var the token is injected as). Tokens live in
// the sibling <id>.creds.json, gitignored. See lib/credentials.ts.
export type Integration = {
  name: string;     // display name, e.g. "Figma", "Wiki", "Git"
  envVar: string;   // env var the token is exposed as, e.g. "FIGMA_TOKEN"
};

export type Agent = {
  id: string;
  name: string;
  instructions: string;        // the role/system preamble
  model?: string;              // optional model override (else inherits default)
  color: string;               // accent colour for the board (hex)
  canDelegate: boolean;        // may spawn its own claude-native sub-agents
  skillIds: string[];          // enabled capability briefs (see lib/skills.ts)
  integrations: Integration[]; // declared integrations (token lives in creds file)
  createdAt: number;
};

// A small, opinionated starter set so the board isn't empty on first open. Each
// seed comes with role-appropriate skills and a placeholder integration so the
// "bring your own token" flow is discoverable.
const SEED: Array<Pick<Agent, "name" | "instructions" | "color" | "canDelegate" | "skillIds" | "integrations">> = [
  {
    name: "Researcher",
    instructions: "Investigate and gather facts. Read the relevant code/docs, summarize findings precisely with file:line references, and surface unknowns. Do not modify files — your output is a briefing for downstream agents.",
    color: "#3b82f6",
    canDelegate: true,
    skillIds: ["deep-research", "codebase-mapping", "concise-writing"],
    integrations: [{ name: "Wiki", envVar: "WIKI_TOKEN" }],
  },
  {
    name: "Developer",
    instructions: "Implement the requested change cleanly, matching the surrounding code's style and conventions. Make the edits, then state exactly what you changed and why. Keep diffs tight.",
    color: "#22c55e",
    canDelegate: false,
    skillIds: ["tdd", "tight-diffs", "conventional-commits", "git-hygiene", "defensive-coding"],
    integrations: [{ name: "Git", envVar: "GIT_TOKEN" }],
  },
  {
    name: "Reviewer",
    instructions: "Critically review the work for correctness, edge cases, and simplification opportunities. Be specific and adversarial — try to find what's wrong before approving. End with a clear verdict: ship, or the concrete fixes needed first.",
    color: "#f59e0b",
    canDelegate: false,
    skillIds: ["adversarial-review", "security-review"],
    integrations: [],
  },
  {
    name: "Designer",
    instructions: "Translate intent into clean UI. Work from the design system, produce or refine layouts and components, and hand off precise specs. When given a Figma reference, map it to existing tokens and components.",
    color: "#ec4899",
    canDelegate: false,
    skillIds: ["design-systems", "a11y"],
    integrations: [{ name: "Figma", envVar: "FIGMA_TOKEN" }],
  },
];

// Suggested integrations offered as placeholders in the agent editor.
export const INTEGRATION_PLACEHOLDERS: Integration[] = [
  { name: "Figma", envVar: "FIGMA_TOKEN" },
  { name: "Wiki", envVar: "WIKI_TOKEN" },
  { name: "Git", envVar: "GIT_TOKEN" },
  { name: "GitHub", envVar: "GITHUB_TOKEN" },
  { name: "Jira", envVar: "JIRA_TOKEN" },
  { name: "Slack", envVar: "SLACK_TOKEN" },
  { name: "Notion", envVar: "NOTION_TOKEN" },
  { name: "Linear", envVar: "LINEAR_TOKEN" },
  { name: "OpenAI", envVar: "OPENAI_API_KEY" },
];

const COLOR_POOL = ["#8b5cf6", "#06b6d4", "#ec4899", "#14b8a6", "#f97316", "#a855f7", "#ef4444", "#84cc16"];

async function ensureSeeded() {
  if (existsSync(ROOT)) {
    const files = await readdir(ROOT).catch(() => []);
    if (files.some((f) => f.endsWith(".json"))) return;
  }
  await mkdir(ROOT, { recursive: true });
  for (const s of SEED) {
    const agent: Agent = { id: randomUUID(), createdAt: Date.now(), model: undefined, ...s };
    await writeFile(join(ROOT, `${agent.id}.json`), JSON.stringify(agent, null, 2), "utf8");
  }
}

// Backfill fields added after an agent was first written, so old records still
// satisfy the current Agent shape.
function normalize(raw: Partial<Agent> & { id: string }): Agent {
  return {
    id: raw.id,
    name: raw.name ?? "Agent",
    instructions: raw.instructions ?? "",
    model: raw.model,
    color: raw.color ?? "#8b5cf6",
    canDelegate: raw.canDelegate ?? false,
    skillIds: raw.skillIds ?? [],
    integrations: raw.integrations ?? [],
    createdAt: raw.createdAt ?? 0,
  };
}

// Files ending in .creds.json are the (gitignored) credential sidecars — never
// treat them as agent records.
function isAgentFile(f: string) { return f.endsWith(".json") && !f.endsWith(".creds.json"); }

export async function listAgents(): Promise<Agent[]> {
  await ensureSeeded();
  const files = await readdir(ROOT).catch(() => []);
  const agents: Agent[] = [];
  for (const f of files) {
    if (!isAgentFile(f)) continue;
    try { agents.push(normalize(JSON.parse(await readFile(join(ROOT, f), "utf8")))); } catch {}
  }
  return agents.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getAgent(id: string): Promise<Agent | null> {
  const path = join(ROOT, `${id}.json`);
  if (!existsSync(path)) return null;
  try { return normalize(JSON.parse(await readFile(path, "utf8"))); } catch { return null; }
}

export async function createAgent(input: { name: string; instructions: string; model?: string; color?: string; canDelegate?: boolean; skillIds?: string[]; integrations?: Integration[] }): Promise<Agent> {
  await ensureSeeded();
  const existing = await listAgents();
  const agent: Agent = {
    id: randomUUID(),
    name: input.name.trim() || "Agent",
    instructions: input.instructions.trim(),
    model: input.model?.trim() || undefined,
    color: input.color || COLOR_POOL[existing.length % COLOR_POOL.length],
    canDelegate: input.canDelegate ?? false,
    skillIds: input.skillIds ?? [],
    integrations: input.integrations ?? [],
    createdAt: Date.now(),
  };
  await mkdir(ROOT, { recursive: true });
  await writeFile(join(ROOT, `${agent.id}.json`), JSON.stringify(agent, null, 2), "utf8");
  return agent;
}

export async function updateAgent(id: string, patch: Partial<Omit<Agent, "id" | "createdAt">>): Promise<Agent | null> {
  const agent = await getAgent(id);
  if (!agent) return null;
  const updated: Agent = {
    ...agent,
    ...patch,
    name: patch.name?.trim() || agent.name,
    instructions: patch.instructions?.trim() ?? agent.instructions,
    skillIds: patch.skillIds ?? agent.skillIds,
    integrations: patch.integrations ?? agent.integrations,
  };
  await writeFile(join(ROOT, `${id}.json`), JSON.stringify(updated, null, 2), "utf8");
  return updated;
}

export async function deleteAgent(id: string): Promise<void> {
  const path = join(ROOT, `${id}.json`);
  if (existsSync(path)) await unlink(path);
  const creds = join(ROOT, `${id}.creds.json`);  // remove the credential sidecar too
  if (existsSync(creds)) await unlink(creds);
}

// ── Natural-language flow decomposition ──
// Turn a free-text goal + the available agents into a structured step list the
// orchestrator can run. Uses a cheap Haiku spawn; falls back to a single step.

const PLANNER_MODEL = process.env.ARIA_MEMORY_MODEL || "claude-haiku-4-5-20251001";

export type PlannedStep = { key: string; agentId?: string; agentName?: string; prompt: string; dependsOn: string[] };

export async function planFlow(goal: string, agents: Agent[]): Promise<PlannedStep[]> {
  const roster = agents.map((a) => `- id=${a.id} name="${a.name}": ${a.instructions.slice(0, 120)}`).join("\n");
  const prompt = `You are a planner that decomposes a goal into a small multi-agent task flow (a DAG). Available agents:\n${roster}\n\nGoal: ${goal}\n\nReturn ONLY a JSON array of steps, no prose. Each step: {"key":"1","agentId":"<one of the ids above, or null>","prompt":"<instruction for that step>","dependsOn":["<keys this step needs first>"]}. Keep it to 2-5 steps. Make independent steps have no shared dependency so they can run in parallel. Wire dependent steps with dependsOn.

WRITING STEP PROMPTS — this is critical:
- Each step runs HEADLESS with no human present. The prompt must be a COMPLETE, self-contained instruction that produces a deliverable. Never write a prompt that would make the agent ask the user a question or seek clarification.
- Reference an earlier step's output with {{key}} (e.g. {{1}}) and the original goal with {{input}}. These are substituted with real text before the step runs.
- When a step consumes {{key}}, frame it as material to ACT ON, not as ambiguous input. Write "Using the research below, produce X:" not "Summarize this:". The agent must treat {{key}} as the upstream result it should transform — never as a user message to interrogate.
- State the concrete output you expect (a table, a ranked list, a Markdown card, etc.) so the step has an unambiguous done-condition.`;
  try {
    const out = await spawnHaiku(prompt);
    const json = out.slice(out.indexOf("["), out.lastIndexOf("]") + 1);
    const parsed = JSON.parse(json) as Array<{ key: string; agentId?: string | null; prompt: string; dependsOn?: string[] }>;
    const byId = new Map(agents.map((a) => [a.id, a]));
    return parsed.map((s, i) => ({
      key: String(s.key ?? i + 1),
      agentId: s.agentId && byId.has(s.agentId) ? s.agentId : undefined,
      agentName: s.agentId && byId.has(s.agentId) ? byId.get(s.agentId)!.name : undefined,
      prompt: s.prompt,
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
    }));
  } catch {
    // Fallback: a single step that just runs the goal verbatim.
    return [{ key: "1", prompt: goal, dependsOn: [] }];
  }
}

function spawnHaiku(prompt: string, timeoutMs = 30_000): Promise<string> {
  const bin = process.platform === "win32" ? "claude.cmd" : "claude";
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [
      "-p", "--output-format", "text", "--input-format", "text",
      "--model", PLANNER_MODEL, "--dangerously-skip-permissions",
    ], { cwd: process.cwd(), shell: process.platform === "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; let err = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error("planner timed out")); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(err.slice(-200))); });
    child.stdin.write(prompt); child.stdin.end();
  });
}
