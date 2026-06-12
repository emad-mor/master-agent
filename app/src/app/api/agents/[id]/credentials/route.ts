import { NextRequest, NextResponse } from "next/server";
import { listRedacted, setCredential } from "@/lib/credentials";
import { getAgent } from "@/lib/agents";

/* Per-agent integration credentials. Tokens are write-only from the client's
 * perspective: you can SET a token, but GET only ever returns a masked preview,
 * never the raw value.
 *
 *   GET    /api/agents/[id]/credentials            → [{ envVar, preview, set }]
 *   PUT    /api/agents/[id]/credentials  { envVar, token }   → set/clear one
 *   DELETE /api/agents/[id]/credentials?envVar=X   → clear one */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!(await getAgent(id))) return NextResponse.json({ error: "No such agent." }, { status: 404 });
  return NextResponse.json({ credentials: await listRedacted(id) });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!(await getAgent(id))) return NextResponse.json({ error: "No such agent." }, { status: 404 });
  const body = await req.json().catch(() => null) as { envVar?: string; token?: string } | null;
  const envVar = body?.envVar?.trim();
  if (!envVar) return NextResponse.json({ error: "Pass 'envVar'." }, { status: 400 });
  await setCredential(id, envVar, body?.token);
  return NextResponse.json({ ok: true, credentials: await listRedacted(id) });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const envVar = new URL(req.url).searchParams.get("envVar");
  if (!envVar) return NextResponse.json({ error: "Pass ?envVar=X." }, { status: 400 });
  await setCredential(id, envVar, undefined);
  return NextResponse.json({ ok: true, credentials: await listRedacted(id) });
}
