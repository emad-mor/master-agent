"use client";

import { useEffect, useRef, useState } from "react";

/* Subscribe to one task's SSE event log. Returns the live, accumulating view of
 * that task: streamed reply text, tool uses, current activity, status, cost.
 * Reconnect-safe: the server replays the buffer on connect, so a pane that
 * mounts late still shows the whole history. */

export type LiveQuestion = { qid: string; question: string; assumed: string };
export type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type TaskView = {
  reply: string;
  toolUses: string[];
  activity?: string;
  status: "queued" | "running" | "done" | "error" | "stopped";
  error?: string;
  costUsd?: number;
  tokens?: TokenUsage;
  model?: string;
  questions: LiveQuestion[];
  summary?: string;
};

const EMPTY: TaskView = { reply: "", toolUses: [], status: "queued", questions: [] };

export function useTaskStream(taskId: string | null, enabled = true): TaskView {
  const [view, setView] = useState<TaskView>(EMPTY);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!taskId || !enabled) return;
    setView(EMPTY);
    const es = new EventSource(`/api/tasks/${taskId}/stream`);
    esRef.current = es;

    es.onmessage = (ev) => {
      let e: Record<string, unknown>;
      try { e = JSON.parse(ev.data); } catch { return; }
      setView((v) => {
        switch (e.t) {
          case "status": return { ...v, status: e.status as TaskView["status"] };
          case "system": return e.model ? { ...v, model: e.model as string } : v;
          case "text": return { ...v, reply: v.reply + (e.text as string), activity: "Writing reply…" };
          case "tool_use": return { ...v, toolUses: [...v.toolUses, e.name as string], activity: `Running ${e.name}…` };
          case "tool_result": return { ...v, activity: "Thinking…" };
          case "activity": return { ...v, activity: e.label as string };
          case "question": {
            const qid = e.qid as string;
            if (v.questions.some((q) => q.qid === qid)) return v;
            return { ...v, questions: [...v.questions, { qid, question: e.question as string, assumed: e.assumed as string }] };
          }
          case "summary": return { ...v, summary: e.summary as string };
          case "result": return { ...v, costUsd: (e.costUsd as number) ?? v.costUsd, tokens: (e.tokens as TokenUsage) ?? v.tokens, model: (e.model as string) ?? v.model, reply: v.reply || (e.text as string) || "" };
          case "error": return { ...v, status: "error", error: e.message as string, activity: undefined };
          case "done": return { ...v, activity: undefined };
          default: return v;
        }
      });
    };
    es.onerror = () => { es.close(); };

    return () => { es.close(); esRef.current = null; };
  }, [taskId, enabled]);

  return view;
}
