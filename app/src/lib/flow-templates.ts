/* Reusable flow templates.
 *
 * A template is a saved, parameterizable DAG of steps you can instantiate into a
 * live flow. Steps reference an agent by ROLE NAME (e.g. "Researcher") rather
 * than by id — ids are per-machine, names are portable — and the name is matched
 * to an actual agent at instantiation time. Each step's prompt may use {{input}}
 * (the run's goal) and {{<stepKey>}} (an upstream step's output).
 *
 * Built-in templates are seeded into data/flow-templates/ on first read; after
 * that the directory is the source of truth, and the user can save their own
 * (including "save the current flow as a template"). JSON, gitignored. */

import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = join(process.cwd(), "data", "flow-templates");

export type TemplateStep = {
  key: string;
  agentRole?: string;      // matched to an agent by name at instantiate time
  title: string;           // short human label for the node
  prompt: string;          // may use {{input}} and {{stepKey}}
  dependsOn: string[];
};

export type TemplateCategory = "Design" | "Research" | "Writing" | "Engineering";

export type FlowTemplate = {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  builtin: boolean;        // seeded vs user-created
  steps: TemplateStep[];
  createdAt: number;
};

// ── Built-in templates, grouped by role ──
const BUILTINS: Array<Omit<FlowTemplate, "id" | "createdAt" | "builtin">> = [
  {
    name: "Security posture review",
    description: "Map the security state, find risks, propose remediations, verify them.",
    category: "Engineering",
    steps: [
      { key: "1", agentRole: "Researcher", title: "Map posture", prompt: "Research and map the current security posture relevant to: {{input}}. Inventory the assets, controls, and configuration that matter. Cite file:line / sources. Output a factual briefing — do not change anything.", dependsOn: [] },
      { key: "2", agentRole: "Reviewer", title: "Find risks", prompt: "Given this posture briefing:\n\n{{1}}\n\nIdentify the concrete risks, gaps, and misconfigurations. Rank by severity with a plausible exploit path for each. No fixes yet — just the prioritized risk list.", dependsOn: ["1"] },
      { key: "3", agentRole: "Developer", title: "Propose fixes", prompt: "For these prioritized risks:\n\n{{2}}\n\nPropose concrete remediations (config/code/process), smallest-effective-change first. For each, state exactly what to change and the residual risk.", dependsOn: ["2"] },
      { key: "4", agentRole: "Reviewer", title: "Verify", prompt: "Verify these proposed remediations actually close the risks they target and introduce no new ones:\n\nRisks: {{2}}\nFixes: {{3}}\n\nGive a clear verdict per fix: sufficient, or what's still missing.", dependsOn: ["3"] },
    ],
  },
  {
    name: "Feature: spec → build → review",
    description: "Scope a feature in the codebase, implement it, review adversarially, fix findings.",
    category: "Engineering",
    steps: [
      { key: "1", agentRole: "Researcher", title: "Scope", prompt: "Scope this feature in the codebase: {{input}}. Identify the files to touch, existing patterns to follow, data flow, and edge cases. Output an implementation plan — do not write code yet.", dependsOn: [] },
      { key: "2", agentRole: "Developer", title: "Implement", prompt: "Implement the feature per this plan:\n\n{{1}}\n\nMake the smallest correct change matching the surrounding style. State exactly what you changed and why.", dependsOn: ["1"] },
      { key: "3", agentRole: "Reviewer", title: "Review", prompt: "Adversarially review this implementation for correctness, edge cases, security, and simplicity:\n\nPlan: {{1}}\nChange: {{2}}\n\nList blocking issues vs nits. End with ship / fix-first verdict.", dependsOn: ["2"] },
      { key: "4", agentRole: "Developer", title: "Address findings", prompt: "Address the review's blocking findings:\n\n{{3}}\n\nMake the fixes and report what changed. Skip nits unless trivial.", dependsOn: ["3"] },
    ],
  },
  {
    name: "Bug hunt & fix",
    description: "Reproduce + root-cause, write a failing test then fix, verify no regressions.",
    category: "Engineering",
    steps: [
      { key: "1", agentRole: "Researcher", title: "Reproduce + root-cause", prompt: "Reproduce and root-cause this bug: {{input}}. Trace the actual code path, identify the precise cause with file:line, and note the conditions that trigger it. Output a diagnosis — no fix yet.", dependsOn: [] },
      { key: "2", agentRole: "Developer", title: "Test + fix", prompt: "Given this diagnosis:\n\n{{1}}\n\nFirst write a test that fails because of the bug, then make the smallest change that turns it green. Report the failing test and the fix.", dependsOn: ["1"] },
      { key: "3", agentRole: "Reviewer", title: "Verify", prompt: "Confirm this fix resolves the bug and check for regressions:\n\nDiagnosis: {{1}}\nFix: {{2}}\n\nVerify the new test truly covers the cause and nothing nearby broke. Verdict: confirmed / concerns.", dependsOn: ["2"] },
    ],
  },
  {
    name: "Design → code handoff",
    description: "Turn intent into a design spec, implement to the design system, check a11y + fidelity.",
    category: "Design",
    steps: [
      { key: "1", agentRole: "Designer", title: "Design spec", prompt: "Turn this intent into a precise design spec: {{input}}. Define layout, components (reuse existing), tokens, states, and interactions. If a Figma reference exists, map it to existing tokens/components.", dependsOn: [] },
      { key: "2", agentRole: "Developer", title: "Implement", prompt: "Implement this design spec to the design system (tokens, existing components, no hardcoded values):\n\n{{1}}\n\nReport what you built and any deviations from the spec.", dependsOn: ["1"] },
      { key: "3", agentRole: "Reviewer", title: "a11y + fidelity", prompt: "Review this implementation for WCAG 2.1 AA accessibility and fidelity to the spec:\n\nSpec: {{1}}\nBuild: {{2}}\n\nFlag contrast/keyboard/semantics issues and any visual drift. Verdict: ship / fixes.", dependsOn: ["2"] },
    ],
  },
  {
    name: "Deep research report",
    description: "Sweep angles in parallel, synthesize + de-dupe, fact-check the claims.",
    category: "Research",
    steps: [
      { key: "1", agentRole: "Researcher", title: "Angle A", prompt: "Research this question from a FIRST angle (e.g. official/primary sources): {{input}}. Gather corroborated findings with citations. Note what you couldn't verify.", dependsOn: [] },
      { key: "2", agentRole: "Researcher", title: "Angle B", prompt: "Research this question from a SECOND, different angle (e.g. practitioner/community/comparative sources): {{input}}. Gather corroborated findings with citations. Note gaps.", dependsOn: [] },
      { key: "3", agentRole: "Researcher", title: "Synthesize", prompt: "Synthesize these two research passes into one coherent report, merging overlaps and de-duplicating:\n\nAngle A: {{1}}\n\nAngle B: {{2}}\n\nKeep every claim's citation.", dependsOn: ["1", "2"] },
      { key: "4", agentRole: "Reviewer", title: "Fact-check", prompt: "Fact-check this synthesized report:\n\n{{3}}\n\nFlag any claim that is unsupported, over-stated, or contradicted by its own citation. Verdict per section.", dependsOn: ["3"] },
    ],
  },
  {
    name: "Docs & onboarding",
    description: "Map the project, draft README/onboarding, verify accuracy against the code.",
    category: "Writing",
    steps: [
      { key: "1", agentRole: "Researcher", title: "Map project", prompt: "Map this project for documentation: {{input}}. Cover what it is, how it's structured, how to run it, and the key concepts a newcomer needs. Cite file:line.", dependsOn: [] },
      { key: "2", agentRole: "Reviewer", title: "Draft docs", prompt: "Using this project map, draft clear onboarding docs (README-style): what it is, setup/run steps, architecture overview, and gotchas.\n\n{{1}}\n\nConcise, active voice, accurate.", dependsOn: ["1"] },
      { key: "3", agentRole: "Reviewer", title: "Verify vs code", prompt: "Verify these docs against the actual codebase — every setup step, path, and claim:\n\n{{2}}\n\nFlag anything inaccurate or out of date. Verdict: accurate / corrections.", dependsOn: ["2"] },
    ],
  },

  // ── Designer set (Figma in / out) ──
  {
    name: "Brief → design → commit to Figma",
    description: "Researcher frames the brief, Designer designs it, then commits the design to Figma.",
    category: "Design",
    steps: [
      { key: "1", agentRole: "Researcher", title: "Frame brief", prompt: "Frame a clear design brief for: {{input}}. Capture the goal, target users, constraints, key screens/components, and success criteria. Output a tight brief for the designer.", dependsOn: [] },
      { key: "2", agentRole: "Designer", title: "Design", prompt: "From this brief, design the solution using the design system (tokens, existing components, spacing/type scales, WCAG AA):\n\n{{1}}\n\nProduce a concrete spec: layout, components, tokens, states, and interactions.", dependsOn: ["1"] },
      { key: "3", agentRole: "Designer", title: "Commit to Figma", prompt: "Commit this design to Figma using the Figma API/MCP with the FIGMA_TOKEN in your environment (create/update frames + components mapped to design-system tokens):\n\n{{2}}\n\nReport the Figma file/frame links and exactly what you pushed. If the Figma connection is unavailable, output the precise create/update operations you WOULD run, formatted for replay, and say so — do not stop.", dependsOn: ["2"] },
    ],
  },
  {
    name: "Input from Figma → build → fidelity check",
    description: "Pull a design from Figma, implement it to the design system, verify fidelity + a11y.",
    category: "Design",
    steps: [
      { key: "1", agentRole: "Designer", title: "Input from Figma", prompt: "Pull the referenced Figma design using the Figma API/MCP with the FIGMA_TOKEN in your environment: {{input}}. Extract the structure, components, tokens (colour/space/type), and states. Output a precise, implementation-ready spec mapped to our design system. If Figma is unreachable, say so and proceed from any description available — do not stop.", dependsOn: [] },
      { key: "2", agentRole: "Developer", title: "Implement", prompt: "Implement this Figma-derived spec to the design system — tokens not hardcoded values, reuse existing components:\n\n{{1}}\n\nReport what you built and any deviations.", dependsOn: ["1"] },
      { key: "3", agentRole: "Reviewer", title: "Fidelity + a11y", prompt: "Check the build against the Figma spec for visual fidelity and WCAG 2.1 AA:\n\nSpec: {{1}}\nBuild: {{2}}\n\nFlag drift, contrast/keyboard/semantics issues. Verdict: ship / fixes.", dependsOn: ["2"] },
    ],
  },

  // ── Researcher set ──
  {
    name: "Competitive / landscape scan",
    description: "Scan players in parallel, compare on common axes, surface the strategic takeaway.",
    category: "Research",
    steps: [
      { key: "1", agentRole: "Researcher", title: "Survey players", prompt: "Survey the main players/options in this space: {{input}}. For each, capture what it does, strengths, weaknesses, and pricing/positioning. Cite sources.", dependsOn: [] },
      { key: "2", agentRole: "Researcher", title: "Comparison matrix", prompt: "Build a comparison matrix from this survey, on the axes that matter most for a decision:\n\n{{1}}\n\nKeep citations; note where data is missing.", dependsOn: ["1"] },
      { key: "3", agentRole: "Reviewer", title: "Strategic takeaway", prompt: "From this matrix, give the strategic takeaway: where the gaps/opportunities are and the recommended direction:\n\n{{2}}\n\nLead with the recommendation, then the reasoning.", dependsOn: ["2"] },
    ],
  },
  {
    name: "Evidence / literature review",
    description: "Gather evidence, appraise quality, synthesize what's actually supported.",
    category: "Research",
    steps: [
      { key: "1", agentRole: "Researcher", title: "Gather evidence", prompt: "Gather the strongest available evidence on: {{input}}. Prefer primary/peer-reviewed sources. For each, note the claim, the study design, and the citation.", dependsOn: [] },
      { key: "2", agentRole: "Reviewer", title: "Appraise quality", prompt: "Critically appraise the quality of each piece of evidence — sample size, design, bias, recency:\n\n{{1}}\n\nRate confidence per claim.", dependsOn: ["1"] },
      { key: "3", agentRole: "Researcher", title: "Synthesize", prompt: "Synthesize what is actually well-supported vs uncertain, weighting by the appraisal:\n\nEvidence: {{1}}\nAppraisal: {{2}}\n\nClear, cited, honest about uncertainty.", dependsOn: ["2"] },
    ],
  },

  // ── Technical Writer set ──
  {
    name: "API reference draft",
    description: "Map the API surface, draft reference docs, verify signatures against code.",
    category: "Writing",
    steps: [
      { key: "1", agentRole: "Researcher", title: "Map API surface", prompt: "Map the public API surface for: {{input}}. List endpoints/functions, parameters, return shapes, and errors, with file:line references.", dependsOn: [] },
      { key: "2", agentRole: "Reviewer", title: "Draft reference", prompt: "Draft clear API reference documentation from this surface map — signature, description, params, returns, errors, and a usage example per item:\n\n{{1}}\n\nConcise, consistent, accurate.", dependsOn: ["1"] },
      { key: "3", agentRole: "Reviewer", title: "Verify signatures", prompt: "Verify every signature, parameter, and example in these docs against the actual code:\n\n{{2}}\n\nFlag mismatches. Verdict: accurate / corrections.", dependsOn: ["2"] },
    ],
  },
  {
    name: "Release notes / changelog",
    description: "Collect changes, draft user-facing release notes, verify nothing's misstated.",
    category: "Writing",
    steps: [
      { key: "1", agentRole: "Researcher", title: "Collect changes", prompt: "Collect the changes to write up for: {{input}} (recent commits/PRs/diffs). Group into features, fixes, and breaking changes, with references.", dependsOn: [] },
      { key: "2", agentRole: "Reviewer", title: "Draft notes", prompt: "Draft user-facing release notes from these changes — lead with user impact, group by type, call out breaking changes and migration steps:\n\n{{1}}\n\nClear, active voice, no internal jargon.", dependsOn: ["1"] },
      { key: "3", agentRole: "Reviewer", title: "Verify", prompt: "Verify these release notes against the actual changes — nothing overstated, omitted, or miscategorized:\n\nChanges: {{1}}\nNotes: {{2}}\n\nVerdict: accurate / corrections.", dependsOn: ["2"] },
    ],
  },
];

async function ensureSeeded() {
  if (existsSync(ROOT)) {
    const files = await readdir(ROOT).catch(() => []);
    if (files.some((f) => f.endsWith(".json"))) return;
  }
  await mkdir(ROOT, { recursive: true });
  let i = 0;
  for (const t of BUILTINS) {
    const tmpl: FlowTemplate = { id: randomUUID(), builtin: true, createdAt: Date.now() + i++, ...t };
    await writeFile(join(ROOT, `${tmpl.id}.json`), JSON.stringify(tmpl, null, 2), "utf8");
  }
}

export async function listTemplates(): Promise<FlowTemplate[]> {
  await ensureSeeded();
  const files = await readdir(ROOT).catch(() => []);
  const out: FlowTemplate[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try { out.push(JSON.parse(await readFile(join(ROOT, f), "utf8"))); } catch {}
  }
  // builtins first, then user templates by recency
  return out.sort((a, b) => (a.builtin === b.builtin ? a.createdAt - b.createdAt : a.builtin ? -1 : 1));
}

export async function getTemplate(id: string): Promise<FlowTemplate | null> {
  const p = join(ROOT, `${id}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; }
}

export async function saveTemplate(input: { name: string; description?: string; category?: TemplateCategory; steps: TemplateStep[] }): Promise<FlowTemplate> {
  await ensureSeeded();
  const tmpl: FlowTemplate = {
    id: randomUUID(),
    name: input.name.trim() || "Untitled flow",
    description: input.description?.trim() || "",
    category: input.category ?? "Engineering",
    builtin: false,
    steps: input.steps,
    createdAt: Date.now(),
  };
  await mkdir(ROOT, { recursive: true });
  await writeFile(join(ROOT, `${tmpl.id}.json`), JSON.stringify(tmpl, null, 2), "utf8");
  return tmpl;
}

export async function deleteTemplate(id: string): Promise<boolean> {
  const t = await getTemplate(id);
  if (!t || t.builtin) return false;   // built-ins are not deletable
  await unlink(join(ROOT, `${id}.json`));
  return true;
}
