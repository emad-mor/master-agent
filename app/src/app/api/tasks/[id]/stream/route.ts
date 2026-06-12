import { NextRequest } from "next/server";
import { subscribe, getTask } from "@/lib/orchestrator";

/* Subscribe to ONE task's event log as SSE. On connect we replay the task's
 * buffered events (so a late watcher sees the whole history), then stream the
 * live tail. Multiple clients can watch the same task independently — the task
 * keeps running regardless of who's connected. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!getTask(id)) {
    return new Response(JSON.stringify({ error: "No such task." }), { status: 404, headers: { "Content-Type": "application/json" } });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const write = (data: unknown) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
        catch { closed = true; }
      };

      const sub = subscribe(id, (e) => {
        write(e);
        if (e.t === "done") { setTimeout(() => { try { controller.close(); } catch {} }, 50); }
      });
      if (!sub) { try { controller.close(); } catch {} return; }

      // Replay buffered events first.
      for (const e of sub.replay) write(e);
      // If the task already finished before we connected, close right after replay.
      const t = getTask(id);
      if (t && ["done", "error", "stopped"].includes(t.status)) {
        setTimeout(() => { try { controller.close(); } catch {} }, 50);
      }

      req.signal.addEventListener("abort", () => {
        closed = true;
        sub.unsubscribe();
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
