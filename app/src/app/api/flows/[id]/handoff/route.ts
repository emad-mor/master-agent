import { NextRequest, NextResponse } from "next/server";
import { getFlowResults, runHaiku } from "@/lib/orchestrator";
import { resolveProject, saveDrops } from "@/lib/workspace";
import { createSession, appendTurn, evictIfNeeded } from "@/lib/persona-memory";

/* Carry a flow's results into an Aria chat session — without dumping the whole
 * research into the conversation (which would ride the Recent memory window
 * verbatim and bloat every later turn). Instead:
 *   1. Write a FULL export .md (the ask, per-step chain analysis, and the
 *      complete final conclusion) to the project's .aria-drops/ folder.
 *   2. Distill a compact summary (Haiku) of the ask + research + chain + the
 *      key conclusion.
 *   3. Seed a new session turn with the SUMMARY plus a file reference, so Aria
 *      has the gist in-context and reads the full file on demand — no context
 *      lost, no bloat.
 *
 *   POST /api/flows/[id]/handoff → { projectKey, project, sessionKey, label, file } */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stripMarkers = (s: string) => s.replace(/\[\[\s*ASK\b[^\]]*\]\]/gi, "").trim();

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = getFlowResults(id);
  if (!res) return NextResponse.json({ error: "No such flow (it may have been cleared)." }, { status: 404 });
  const { flow, steps } = res;

  const doneSteps = steps.filter((t) => t.status === "done" && t.reply.trim());
  if (!doneSteps.length) {
    return NextResponse.json({ error: "This flow has no finished output to carry over yet." }, { status: 409 });
  }
  const { key: projectKey } = await resolveProject(flow.project);

  // Order steps by their flow key so the chain reads start → conclusion. The
  // LAST done step is treated as the final conclusion (untruncated in the file).
  const ordered = [...doneSteps].sort((a, b) => String(a.stepKey ?? "").localeCompare(String(b.stepKey ?? ""), undefined, { numeric: true }));
  const conclusion = ordered[ordered.length - 1];

  // ── 1. Full export document (complete, untruncated) ──
  const doc: string[] = [
    `# Flow research: ${flow.name}`,
    ``,
    `> Exported from Mission Control. This is the complete record — the ask, each step's analysis, and the final conclusion.`,
  ];
  if (flow.rootInput?.trim()) doc.push(``, `## The ask`, ``, flow.rootInput.trim());
  doc.push(``, `## Chain analysis (${ordered.length} step${ordered.length === 1 ? "" : "s"})`);
  for (const t of ordered) {
    doc.push(``, `### Step ${t.stepKey} — ${t.title ?? t.label}${t.agentName ? ` · ${t.agentName}` : ""}`);
    if (t.summary) doc.push(``, `_${t.summary}_`);
    doc.push(``, stripMarkers(t.reply));
  }
  doc.push(``, `## Final conclusion`, ``, stripMarkers(conclusion.reply));
  const fullDoc = doc.join("\n");

  // ── 2. Compact summary for the chat seed (Haiku; graceful fallback) ──
  const distillPrompt = [
    "Summarize this completed multi-agent research flow for the start of a chat, so the assistant has the gist in working memory. Use this exact structure with these Markdown headings:",
    "**The ask:** (1 sentence)",
    "**What the research did:** (1-2 sentences on the chain of steps)",
    "**Key conclusion:** (2-4 sentences — the actionable bottom line)",
    "Be specific and faithful to the content. No preamble.",
    "",
    flow.rootInput ? `ASK: ${flow.rootInput.slice(0, 800)}` : "",
    "",
    "STEPS:",
    ...ordered.map((t) => `- Step ${t.stepKey} (${t.agentName ?? "Aria"}): ${stripMarkers(t.summary || t.reply).slice(0, 900)}`),
    "",
    `FINAL CONCLUSION:\n${stripMarkers(conclusion.reply).slice(0, 4000)}`,
  ].filter(Boolean).join("\n");

  let summary = (await runHaiku(distillPrompt, 30_000)).trim();
  if (!summary) {
    // Fallback if the distiller is unavailable — first ~1.2k of the conclusion.
    summary = `**Key conclusion:**\n\n${stripMarkers(conclusion.reply).slice(0, 1200)}`;
  }

  // ── 3. Write the full doc to .aria-drops/ ──
  const stamp = String(flow.createdAt || 0);   // stable, no Date.now() here
  const fname = `flow-${flow.name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "research"}-${stamp.slice(-6)}.md`;
  const [saved] = await saveDrops(flow.project, [{ name: fname, data: Buffer.from(fullDoc, "utf8") }]);

  // ── 4. Seed a new session with the summary + a file reference ──
  const session = await createSession(projectKey, `Flow: ${flow.name.slice(0, 26)}`);
  const reply = [
    `I ran the **${flow.name}** flow and exported the full research to a file so we keep the complete context without crowding our chat. Here's the summary:`,
    ``,
    summary,
    ``,
    `---`,
    `📄 **Full research saved to** \`./${saved.relPath}\` — I'll read it from there whenever we need the complete detail (the per-step analysis and the full conclusion). Ask me anything about it, or tell me how you want to act on it.`,
  ].join("\n");

  await appendTurn(projectKey, {
    prompt: `I ran the flow "${flow.name}" in Mission Control. Carry its results into this conversation — keep the full research in a file and reference it, summarize it here, and let's decide how to act on it.`,
    reply,
    toolUses: [],
    sessionKey: session.key,
    sessionLabel: session.label,
    category: "Flow",
  });
  await evictIfNeeded(projectKey);

  return NextResponse.json({ projectKey, project: flow.project, sessionKey: session.key, label: session.label, file: saved.relPath });
}
