import { NextRequest, NextResponse } from "next/server";
import { listAgents, createAgent, updateAgent, deleteAgent, INTEGRATION_PLACEHOLDERS, type Integration } from "@/lib/agents";

/* Named-agent CRUD for the orchestration layer.
 *   GET    /api/agents              → { agents, integrationPlaceholders }
 *   POST   /api/agents              → create { name, instructions, model?, color?, canDelegate?, skillIds?, integrations? }
 *   PATCH  /api/agents              → update { id, ...patch }   (incl. skillIds, integrations)
 *   DELETE /api/agents?id=ID        → delete (also removes its creds sidecar) */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ agents: await listAgents(), integrationPlaceholders: INTEGRATION_PLACEHOLDERS });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { name?: string; instructions?: string; model?: string; color?: string; canDelegate?: boolean; skillIds?: string[]; integrations?: Integration[] } | null;
  const name = body?.name?.trim();
  const instructions = body?.instructions?.trim();
  if (!name || !instructions) {
    return NextResponse.json({ error: "Pass non-empty 'name' and 'instructions'." }, { status: 400 });
  }
  const agent = await createAgent({
    name, instructions, model: body?.model, color: body?.color, canDelegate: body?.canDelegate,
    skillIds: body?.skillIds, integrations: body?.integrations,
  });
  return NextResponse.json({ agent });
}

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => null) as { id?: string } & Record<string, unknown> | null;
  if (!body?.id) return NextResponse.json({ error: "Pass 'id'." }, { status: 400 });
  const { id, ...patch } = body;
  const agent = await updateAgent(id, patch);
  if (!agent) return NextResponse.json({ error: "No agent with that id." }, { status: 404 });
  return NextResponse.json({ agent });
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Pass ?id=<id>." }, { status: 400 });
  await deleteAgent(id);
  return NextResponse.json({ ok: true });
}
