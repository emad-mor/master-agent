import { NextRequest, NextResponse } from "next/server";
import { startTask, startFlow, startFlowFromTemplate, listTasks, listFlows, clearFinished } from "@/lib/orchestrator";
import { listAgents, planFlow } from "@/lib/agents";

/* Task + flow control for the orchestration dashboard.
 *
 *   GET  /api/tasks?project=SLUG            → { tasks, flows } snapshot for the board
 *   POST /api/tasks  (one of):
 *     { kind:"task",  prompt, project?, agentId? }              → start one task
 *     { kind:"flow",  name, project?, rootInput?, steps:[...] } → start an explicit flow (DAG)
 *     { kind:"plan",  goal, project? }                          → NL-decompose a goal into steps,
 *                                                                  then run it as a flow
 *   DELETE /api/tasks?project=SLUG&finished=1                   → clear finished tasks
 *
 * A flow step: { key, agentId?, prompt (may use {{key}}/{{input}}), dependsOn?: [keys] }. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const project = new URL(req.url).searchParams.get("project") ?? undefined;
  return NextResponse.json({ tasks: listTasks(project), flows: listFlows(project) });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const kind = body?.kind as string | undefined;

  if (kind === "task") {
    const prompt = (body?.prompt as string)?.trim();
    if (!prompt) return NextResponse.json({ error: "Pass non-empty 'prompt'." }, { status: 400 });
    const id = await startTask({ prompt, project: body?.project as string, agentId: body?.agentId as string, label: body?.label as string, model: (body?.model as string) || undefined });
    return NextResponse.json({ kind: "task", taskId: id });
  }

  if (kind === "flow") {
    const steps = body?.steps as Array<{ key: string; agentId?: string; prompt: string; dependsOn?: string[] }> | undefined;
    if (!Array.isArray(steps) || steps.length === 0) return NextResponse.json({ error: "Pass non-empty 'steps'." }, { status: 400 });
    const { flowId, taskIds } = await startFlow({
      name: (body?.name as string) || "Flow",
      project: body?.project as string,
      rootInput: body?.rootInput as string,
      steps,
      model: (body?.model as string) || undefined,
    });
    return NextResponse.json({ kind: "flow", flowId, taskIds });
  }

  if (kind === "plan") {
    const goal = (body?.goal as string)?.trim();
    if (!goal) return NextResponse.json({ error: "Pass non-empty 'goal'." }, { status: 400 });
    const agents = await listAgents();
    const steps = await planFlow(goal, agents);
    const { flowId, taskIds } = await startFlow({
      name: goal.length > 40 ? goal.slice(0, 40) + "…" : goal,
      project: body?.project as string,
      rootInput: goal,
      steps,
      model: (body?.model as string) || undefined,
    });
    return NextResponse.json({ kind: "plan", flowId, taskIds, plannedSteps: steps });
  }

  if (kind === "template") {
    const templateId = body?.templateId as string;
    if (!templateId) return NextResponse.json({ error: "Pass 'templateId'." }, { status: 400 });
    const res = await startFlowFromTemplate(templateId, body?.project as string, (body?.rootInput as string) || undefined, (body?.model as string) || undefined);
    if (!res) return NextResponse.json({ error: "No such template." }, { status: 404 });
    return NextResponse.json({ kind: "template", ...res });
  }

  return NextResponse.json({ error: "Pass 'kind': 'task' | 'flow' | 'plan' | 'template'." }, { status: 400 });
}

export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const project = url.searchParams.get("project") ?? undefined;
  if (url.searchParams.get("finished") === "1") {
    const n = clearFinished(project);
    return NextResponse.json({ ok: true, cleared: n });
  }
  return NextResponse.json({ error: "Pass ?finished=1 to clear finished tasks." }, { status: 400 });
}
