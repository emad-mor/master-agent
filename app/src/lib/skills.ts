/* Skill library for Aria's agents.
 *
 * A "skill" is a curated capability brief — a compact block of expert practice
 * for a role — appended to an agent's system preamble when enabled. Agents
 * reference skills by id (Agent.skillIds); the orchestrator concatenates the
 * matching briefs.
 *
 * GROUNDED EDITION: each brief is distilled from a named, authoritative source
 * (cited in `source`) rather than improvised. Sources are the canonical specs /
 * guidelines for each practice — see the `source` field on every entry. The
 * citation is also surfaced in the agent editor so you can trace where a
 * practice comes from.
 *
 * Two tiers: the static code-defined catalog below (same for everyone), plus
 * user-defined CUSTOM skills persisted to data/skills.json (see the custom
 * section at the bottom). Both merge in listAllSkills(). */

export type Skill = {
  id: string;
  name: string;
  summary: string;     // one-liner shown next to the toggle
  brief: string;       // injected into the preamble when enabled
  source: string;      // the authoritative source the brief is grounded in
  category: "research" | "engineering" | "review" | "design" | "ops" | "writing";
};

export const SKILLS: Skill[] = [
  // ── Research ──
  {
    id: "deep-research",
    name: "Deep research",
    summary: "Corroborate across independent sources; separate evidence from inference; cite all.",
    category: "research",
    source: "IFCN Code of Principles & journalistic source-triangulation practice",
    brief: "Corroborate before concluding: a claim from a single source is a lead, not a fact — seek at least one independent confirmation. Prefer primary sources over secondary. Explicitly separate what is evidenced from what you inferred, attach a citation (URL, file:line, doc section) to every factual claim, and list what you could not verify. Note source recency and potential bias.",
  },
  {
    id: "codebase-mapping",
    name: "Codebase mapping",
    summary: "Trace entry points → data flow → module boundaries before answering.",
    category: "research",
    source: "Michael Feathers, 'Working Effectively with Legacy Code' (characterization/seams)",
    brief: "Before reasoning about a codebase, establish the map: locate the entry points, follow the control/data flow, and identify module boundaries and 'seams'. Read the code that actually executes rather than inferring from names. Cite exact paths and line numbers, and call out the one or two files that genuinely matter for the question.",
  },

  // ── Engineering ──
  {
    id: "tdd",
    name: "Test-driven development",
    summary: "Red → green → refactor: failing test first, smallest change to pass, then clean up.",
    category: "engineering",
    source: "Kent Beck, 'Test-Driven Development: By Example' (red-green-refactor)",
    brief: "Follow red-green-refactor: first write or locate a test that fails for the right reason (RED), then make the smallest change that turns it green (GREEN), then refactor with the test as your safety net (REFACTOR). Never claim code works without executing the test. If a suite exists, run it before and after and report the delta.",
  },
  {
    id: "tight-diffs",
    name: "Tight diffs",
    summary: "Smallest cohesive change; match local style; no drive-by edits.",
    category: "engineering",
    source: "Google Engineering Practices — 'Small CLs' (small-changes.md)",
    brief: "Keep changes small and self-contained: the smallest diff that correctly and completely makes one self-contained change. Match the surrounding code's style, naming, and idioms so the edit reads like the existing author wrote it. No unrelated refactors, reformatting, or drive-by edits — those belong in separate changes. State precisely what changed and why.",
  },
  {
    id: "conventional-commits",
    name: "Conventional commits",
    summary: "type(scope): description — feat/fix/etc., imperative, body explains why.",
    category: "engineering",
    source: "Conventional Commits 1.0.0 specification (conventionalcommits.org)",
    brief: "Format commits per Conventional Commits 1.0.0: `<type>[optional scope]: <description>` where type is feat|fix|docs|refactor|test|build|ci|chore|perf. Use `!` or a `BREAKING CHANGE:` footer for breaking changes. Description in imperative mood, lowercase, no trailing period. Body (after a blank line) explains the why, not the what. One logical change per commit.",
  },
  {
    id: "defensive-coding",
    name: "Defensive coding",
    summary: "Validate at boundaries; handle the error path; fail loud, never silent.",
    category: "engineering",
    source: "OWASP Secure Coding Practices — Input Validation & Error Handling",
    brief: "Per OWASP secure-coding practice: validate and canonicalize all input at trust boundaries (reject by default, allow-list where possible). Handle the error path explicitly; never swallow exceptions or fall back silently — fail loud and early with a clear, non-leaking message. Consider null/empty/oversized/malformed/concurrent inputs before declaring done. Don't expose internals in error messages.",
  },

  // ── Review ──
  {
    id: "adversarial-review",
    name: "Adversarial review",
    summary: "Assume a bug exists; check it works as intended; clear ship/no-ship verdict.",
    category: "review",
    source: "Google Engineering Practices — 'How to do a code review' (reviewer guide)",
    brief: "Review against the standard from Google's reviewer guide: would this change improve the codebase's overall health? Assume a defect exists and try to find it — check correctness, edge cases, error handling, tests, naming, and complexity. Separate blocking issues from optional nits (prefix nits with 'Nit:'). Be specific and kind. End with a clear verdict: approve, or the concrete changes required first.",
  },
  {
    id: "security-review",
    name: "Security review",
    summary: "OWASP-driven: injection, broken access control, secrets, SSRF, supply chain.",
    category: "review",
    source: "OWASP Top 10 (2021) & OWASP ASVS verification standard",
    brief: "Review against the OWASP Top 10 / ASVS: broken access control, injection (SQL/command/template), cryptographic failures, insecure design, security misconfiguration, vulnerable/outdated components, identification & auth failures, SSRF, and software/data integrity (supply chain). For each finding give the exact location, a plausible exploit path, severity, and the concrete fix. Don't raise theoretical issues with no realistic path.",
  },

  // ── Design ──
  {
    id: "design-systems",
    name: "Design systems",
    summary: "Tokens over hardcoded values; reuse components; respect the scales.",
    category: "design",
    source: "Design Tokens Community Group format & atomic-design component reuse",
    brief: "Work within the design system: consume design tokens (never hardcoded hex/px) per the Design Tokens spec, and reuse existing components before creating new ones. Respect the spacing, typography, and colour scales. When translating a Figma reference, map it onto existing tokens and components rather than duplicating values. Keep components composable and single-purpose.",
  },
  {
    id: "a11y",
    name: "Accessibility (WCAG)",
    summary: "WCAG 2.1 AA: contrast, keyboard, name/role/value, semantics.",
    category: "design",
    source: "W3C WCAG 2.1 Level AA (Perceivable·Operable·Understandable·Robust)",
    brief: "Hold work to WCAG 2.1 AA across its four principles: Perceivable (≥4.5:1 text / 3:1 large-text & UI contrast, text alternatives), Operable (full keyboard operability, visible focus, no keyboard traps), Understandable (clear labels, predictable behaviour), Robust (valid semantic HTML, correct name/role/value via ARIA only when native semantics fall short). Flag anything not reachable or operable without a mouse.",
  },

  // ── Ops ──
  {
    id: "git-hygiene",
    name: "Git hygiene",
    summary: "Topic branch per change, atomic commits, never rewrite shared history, no secrets.",
    category: "ops",
    source: "Git SCM Book — 'Distributed Git: Contributing' & branching workflows",
    brief: "Follow standard Git workflow hygiene: one topic branch per unit of work with a descriptive name; atomic, buildable commits; never force-push or rewrite history on a shared/published branch; never commit secrets or large binaries. Verify working-tree state before destructive operations, and summarize what will change before pushing or opening a PR.",
  },

  // ── Writing ──
  {
    id: "concise-writing",
    name: "Concise writing",
    summary: "Omit needless words; lead with the point; active voice; concrete nouns.",
    category: "writing",
    source: "Strunk & White, 'The Elements of Style' — 'Omit needless words'",
    brief: "Write per Strunk & White: omit needless words. Lead with the conclusion or recommendation, then the support (BLUF). Use the active voice and concrete, specific nouns; cut hedging and filler. Prefer a short list to a dense paragraph. Make every word earn its place, and end with the next concrete step.",
  },
];

// ── Custom (user-defined) skills ──
// Stored in data/skills.json (gitignored, same persistence root as agents).
// Reads are SYNC because getSkills/buildSkillBrief run inside the synchronous
// launch() path; a module cache (on globalThis, HMR-safe) avoids re-reading the
// file per launch and is invalidated on every write.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export type CustomSkill = Skill & {
  custom: true;
  createdAt: number;
  fileName?: string;   // set when the brief was loaded from an uploaded file
};

// Briefs ride inside every agent preamble — cap so one giant file can't blow
// up the prompt (~6k tokens of practice text is already a LOT).
export const MAX_BRIEF_CHARS = 24_000;

const SKILLS_FILE = join(process.cwd(), "data", "skills.json");
const g = globalThis as unknown as { __ariaCustomSkills?: CustomSkill[] | null };

function readCustomSkills(): CustomSkill[] {
  if (g.__ariaCustomSkills != null) return g.__ariaCustomSkills;
  let list: CustomSkill[] = [];
  try {
    if (existsSync(SKILLS_FILE)) {
      const raw = JSON.parse(readFileSync(SKILLS_FILE, "utf8"));
      if (Array.isArray(raw)) list = raw.filter((s) => s && s.id && s.name && s.brief);
    }
  } catch { /* corrupt file → treat as empty, don't crash launches */ }
  g.__ariaCustomSkills = list;
  return list;
}

function writeCustomSkills(list: CustomSkill[]) {
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  writeFileSync(SKILLS_FILE, JSON.stringify(list, null, 2), "utf8");
  g.__ariaCustomSkills = list;
}

/** Built-in catalog + the user's custom skills (custom flagged for the UI). */
export function listAllSkills(): (Skill & { custom?: boolean })[] {
  return [...SKILLS, ...readCustomSkills()];
}

export function createCustomSkill(input: { name: string; summary?: string; brief: string; source?: string; category?: Skill["category"]; fileName?: string }): CustomSkill | null {
  const name = input.name?.trim();
  const brief = input.brief?.trim();
  if (!name || !brief || brief.length > MAX_BRIEF_CHARS) return null;
  const id = "custom-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  const all = listAllSkills();
  if (all.some((s) => s.id === id)) return null;   // name collision
  const skill: CustomSkill = {
    id,
    name,
    summary: input.summary?.trim() || brief.slice(0, 90),
    brief,
    source: input.source?.trim() || (input.fileName ? `Uploaded file: ${input.fileName}` : "Your own practice (custom skill)"),
    category: input.category && ["research", "engineering", "review", "design", "ops", "writing"].includes(input.category) ? input.category : "ops",
    custom: true,
    createdAt: Date.now(),
    fileName: input.fileName?.trim() || undefined,
  };
  writeCustomSkills([...readCustomSkills(), skill]);
  return skill;
}

export function deleteCustomSkill(id: string): boolean {
  const list = readCustomSkills();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return false;   // not found / not custom
  writeCustomSkills(next);
  return true;
}

export function getSkills(ids: string[] | undefined): Skill[] {
  if (!ids?.length) return [];
  const byId = new Map(listAllSkills().map((s) => [s.id, s]));
  return ids.map((id) => byId.get(id)).filter((s): s is Skill => !!s);
}

/** The combined brief block for an agent's enabled skills (preamble fragment). */
export function buildSkillBrief(ids: string[] | undefined): string {
  const skills = getSkills(ids);
  if (!skills.length) return "";
  return [
    "Apply these working practices (each grounded in an established source):",
    ...skills.map((s) => `• ${s.name}: ${s.brief}`),
  ].join("\n");
}
