export const PERSONA = {
  name: "Daryan",
  role: "Your local Claude Code agent",
  // Greeting picks one based on time of day.
  greetings: {
    morning: "Morning. What are we building today?",
    afternoon: "Back at it. What's the priority?",
    evening: "Evening. Quick win or deep work?",
    night: "Late shift. I'll keep it tight.",
  },
} as const;

export function timeOfDay(d = new Date()): keyof typeof PERSONA.greetings {
  const h = d.getHours();
  if (h < 5) return "night";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 22) return "evening";
  return "night";
}

// Project-agnostic starter prompts shown above the input. Edit freely.
export const QUICK_PROMPTS: { label: string; prompt: string }[] = [
  { label: "Orient me", prompt: "Read this project's README and CLAUDE.md (if present) and give me a 5-line orientation: what it is, how it's structured, and how to run it." },
  { label: "What changed", prompt: "Show me what changed in this project in the last 24 hours (git log + diff stat), grouped by area." },
  { label: "What's next", prompt: "Look at the open TODOs, failing tests, and recent commits. Tell me the single most valuable thing to work on next and why." },
  { label: "Run tests", prompt: "Find and run this project's test suite. Stream the output, then summarize pass/fail and anything that needs attention." },
  { label: "Cross-project", prompt: "Across all projects in the workspace, find every place that does <X>. List the files and a one-line note on each." },
];
