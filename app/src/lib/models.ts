// Canonical list of Claude models the user can pick for an agent, a task, or a
// whole flow. Keep IDs in sync with what the `claude` CLI accepts for --model.
//
// The orchestrator passes the chosen id straight through as `claude -p --model
// <id>`. An empty/undefined choice means "let the CLI use its default model".

export type ModelOption = {
  id: string;
  label: string;
  blurb: string;   // one-line "when to use" hint for the dropdown
};

// Default the CLI uses when no --model is passed (shown as the "Default" choice).
// We surface the current lineup explicitly so the user can force one.
export const MODELS: ModelOption[] = [
  { id: "claude-fable-5",             label: "Fable 5",    blurb: "Newest frontier model" },
  { id: "claude-opus-4-8",            label: "Opus 4.8",   blurb: "Most capable 4.x — deep reasoning, hard tasks" },
  { id: "claude-sonnet-4-6",          label: "Sonnet 4.6", blurb: "Balanced — fast and strong for most work" },
  { id: "claude-haiku-4-5-20251001",  label: "Haiku 4.5",  blurb: "Fastest & cheapest — light/parallel work" },
];

// What a NEW agent starts on. The user wants real capability by default — not
// "whatever the CLI picks" — so new agents default to Opus.
export const DEFAULT_AGENT_MODEL = "claude-opus-4-8";

// Friendly label for a model id (falls back to the raw id, trimmed of date).
export function modelLabel(id?: string | null): string {
  if (!id) return "Default";
  const m = MODELS.find((x) => x.id === id);
  if (m) return m.label;
  // Unknown id: prettify "claude-opus-4-8" → "Opus 4.8" best-effort.
  return id.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/-/g, " ");
}
