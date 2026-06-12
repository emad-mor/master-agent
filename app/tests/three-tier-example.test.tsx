/**
 * Three-Tier Mocking Strategy — Working Example
 *
 * Demonstrates all three mock tiers in one file so future tests have a
 * copy-paste template for each layer:
 *
 *   Tier 1 — DATA (file-system / storage)
 *     Mock `node:fs/promises` via a real temp directory so persona-memory's
 *     read/write functions hit the disk but in an isolated sandbox. This
 *     validates real serialisation logic without touching production data.
 *
 *   Tier 2 — SERVICE (business logic)
 *     Test `credentials.ts` security invariants: `listRedacted` must NEVER
 *     leak raw tokens, and `envForAgent` must return them. Uses the same
 *     temp-directory strategy for isolation.
 *
 *   Tier 3 — UI (React hook / component)
 *     Test `useTaskStream` by injecting a fake `EventSource` that emits
 *     server-sent events. No real HTTP, no MSW — just a lightweight shim
 *     that proves the hook accumulates state correctly from the SSE stream.
 *
 * Each tier is in its own `describe` block with setup/teardown comments.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// ═══════════════════════════════════════════════════════════════════════════
// Tier 1 — DATA: persona-memory with a real temp directory
// ═══════════════════════════════════════════════════════════════════════════
//
// persona-memory.ts computes paths from `process.cwd() + "data/memory"`.
// We can't easily change that constant, so we stub `process.cwd()` to point
// at a temp dir for the duration of these tests. This gives us real FS I/O
// in an isolated sandbox — no mocking of fs internals, which keeps the test
// faithful to production behaviour.
// ═══════════════════════════════════════════════════════════════════════════

describe("Tier 1 — Data: persona-memory (temp-dir isolation)", () => {
  let tempDir: string;
  let originalCwd: () => string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `aria-test-${randomUUID()}`);
    await mkdir(join(tempDir, "data", "memory", "projects", "test-proj", "turns"), {
      recursive: true,
    });

    // Redirect process.cwd() so persona-memory's ROOT resolves to our temp dir.
    originalCwd = process.cwd;
    process.cwd = () => tempDir;
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    await rm(tempDir, { recursive: true, force: true });
    // Clear the module cache so the next test gets a fresh ROOT constant.
    vi.resetModules();
  });

  it("appendTurn writes a turn file and listTurns reads it back", async () => {
    // Dynamic import AFTER cwd is stubbed, so ROOT picks up the temp path.
    const mem = await import("@/lib/persona-memory");

    const turn = await mem.appendTurn("test-proj", {
      prompt: "What is the project structure?",
      reply: "The project has src/, lib/, and tests/ directories.",
      toolUses: ["Glob", "Read"],
    });

    expect(turn.id).toBe(1);
    expect(turn.prompt).toBe("What is the project structure?");
    expect(turn.ts).toBeTruthy();

    const turns = await mem.listTurns("test-proj");
    expect(turns).toHaveLength(1);
    expect(turns[0].reply).toContain("src/, lib/, and tests/");
    expect(turns[0].toolUses).toEqual(["Glob", "Read"]);
  });

  it("appendTurn auto-increments turn ids", async () => {
    const mem = await import("@/lib/persona-memory");

    await mem.appendTurn("test-proj", { prompt: "first", reply: "r1", toolUses: [] });
    const second = await mem.appendTurn("test-proj", { prompt: "second", reply: "r2", toolUses: [] });

    expect(second.id).toBe(2);

    const turns = await mem.listTurns("test-proj");
    expect(turns).toHaveLength(2);
    expect(turns[0].id).toBe(1);
    expect(turns[1].id).toBe(2);
  });

  it("listTurns returns empty array for a project with no turns", async () => {
    const mem = await import("@/lib/persona-memory");
    const turns = await mem.listTurns("nonexistent-proj");
    expect(turns).toEqual([]);
  });

  it("deleteTurn removes a turn file", async () => {
    const mem = await import("@/lib/persona-memory");

    await mem.appendTurn("test-proj", { prompt: "p", reply: "r", toolUses: [] });
    expect(await mem.listTurns("test-proj")).toHaveLength(1);

    await mem.deleteTurn("test-proj", 1);
    expect(await mem.listTurns("test-proj")).toHaveLength(0);
  });

  it("core memory seeds defaults on first access and supports add/remove", async () => {
    const mem = await import("@/lib/persona-memory");

    const core = await mem.listCore();
    // Default seeds exist (at least the two hardcoded ones).
    expect(core.length).toBeGreaterThanOrEqual(2);
    expect(core[0].source).toBe("seed");

    // Add a user fact.
    const fact = await mem.addCore("User prefers dark mode", "user");
    expect(fact).not.toBeNull();
    expect(fact!.text).toBe("User prefers dark mode");

    // Remove it.
    await mem.removeCore(fact!.id);
    const after = await mem.listCore();
    expect(after.find((c) => c.id === fact!.id)).toBeUndefined();
  });

  it("buildMemoryBlock assembles all tiers into a prompt string", async () => {
    const mem = await import("@/lib/persona-memory");

    // Seed some data.
    await mem.appendTurn("test-proj", { prompt: "hello", reply: "hi there", toolUses: [] });

    const block = await mem.buildMemoryBlock("test-proj", "Test Project");

    expect(block).toContain("<persona-memory>");
    expect(block).toContain("</persona-memory>");
    expect(block).toContain("Test Project");
    expect(block).toContain("Core memory");
    expect(block).toContain("Recent turns");
    expect(block).toContain("hello");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tier 2 — SERVICE: credentials.ts security invariants
// ═══════════════════════════════════════════════════════════════════════════
//
// credentials.ts is a security boundary: raw tokens must NEVER leak through
// `listRedacted`, and `envForAgent` must return them for process spawning.
// We use the same temp-dir trick (cwd stub) to isolate the creds files.
// ═══════════════════════════════════════════════════════════════════════════

describe("Tier 2 — Service: credentials (security boundary)", () => {
  let tempDir: string;
  let originalCwd: () => string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `aria-creds-test-${randomUUID()}`);
    await mkdir(join(tempDir, "data", "agents"), { recursive: true });

    originalCwd = process.cwd;
    process.cwd = () => tempDir;
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    await rm(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("listRedacted masks tokens — raw value never exposed", async () => {
    const creds = await import("@/lib/credentials");
    const agentId = "test-agent-1";

    // Store a real token.
    await creds.setCredential(agentId, "FIGMA_TOKEN", "fig_abc123xyz789secret");

    // The redacted list must show the token exists but mask its value.
    const redacted = await creds.listRedacted(agentId);
    expect(redacted).toHaveLength(1);
    expect(redacted[0].envVar).toBe("FIGMA_TOKEN");
    expect(redacted[0].set).toBe(true);

    // SECURITY: the preview must NOT contain the full token.
    expect(redacted[0].preview).not.toBe("fig_abc123xyz789secret");
    expect(redacted[0].preview).not.toContain("abc123xyz789secret");
    // It should contain masking characters.
    expect(redacted[0].preview).toContain("••••");
  });

  it("envForAgent returns raw tokens for process spawning", async () => {
    const creds = await import("@/lib/credentials");
    const agentId = "test-agent-2";
    const rawToken = "ghp_realTokenValue12345";

    await creds.setCredential(agentId, "GIT_TOKEN", rawToken);

    // envForAgent is the SERVER-ONLY path that injects real tokens.
    const env = await creds.envForAgent(agentId);
    expect(env.GIT_TOKEN).toBe(rawToken);
  });

  it("setCredential with empty token removes the credential", async () => {
    const creds = await import("@/lib/credentials");
    const agentId = "test-agent-3";

    await creds.setCredential(agentId, "WIKI_TOKEN", "tok_secretValue");
    expect(await creds.listRedacted(agentId)).toHaveLength(1);

    // Clear it.
    await creds.setCredential(agentId, "WIKI_TOKEN", undefined);
    expect(await creds.listRedacted(agentId)).toHaveLength(0);

    // envForAgent also sees nothing.
    const env = await creds.envForAgent(agentId);
    expect(env).toEqual({});
  });

  it("deleteCredentials wipes all creds for an agent", async () => {
    const creds = await import("@/lib/credentials");
    const agentId = "test-agent-4";

    await creds.setCredential(agentId, "A_TOKEN", "aaa");
    await creds.setCredential(agentId, "B_TOKEN", "bbb");
    expect(await creds.listRedacted(agentId)).toHaveLength(2);

    await creds.deleteCredentials(agentId);
    expect(await creds.listRedacted(agentId)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tier 3 — UI: useTaskStream hook with a fake EventSource
// ═══════════════════════════════════════════════════════════════════════════
//
// The hook opens an EventSource to `/api/tasks/{id}/stream` and accumulates
// state from SSE events. We replace the global EventSource with a fake that
// lets us push events synchronously, then assert the hook's output via
// @testing-library/react's `renderHook` + `act`.
// ═══════════════════════════════════════════════════════════════════════════

// --- Fake EventSource ---
// A minimal shim that captures the constructed URL and lets tests push
// events via `emit()`. No real HTTP involved.

type FakeESInstance = {
  url: string;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close: Mock;
  emit: (data: Record<string, unknown>) => void;
};

let fakeESInstances: FakeESInstance[] = [];

class FakeEventSource {
  url: string;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    fakeESInstances.push(this as unknown as FakeESInstance);
  }

  /** Test helper: push a JSON event into the onmessage handler. */
  emit(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

describe("Tier 3 — UI: useTaskStream hook (fake EventSource)", () => {
  let renderHook: typeof import("@testing-library/react").renderHook;
  let act: typeof import("@testing-library/react").act;
  let useTaskStream: typeof import("@/components/tasks/use-task-stream").useTaskStream;

  beforeEach(async () => {
    fakeESInstances = [];

    // Install the fake EventSource globally before importing the hook.
    (globalThis as unknown as Record<string, unknown>).EventSource = FakeEventSource;

    // Dynamic imports so the hook picks up our fake EventSource.
    const rtl = await import("@testing-library/react");
    renderHook = rtl.renderHook;
    act = rtl.act;
    const mod = await import("@/components/tasks/use-task-stream");
    useTaskStream = mod.useTaskStream;
  });

  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).EventSource;
    vi.resetModules();
  });

  it("starts with empty/queued state when no events received", () => {
    const { result } = renderHook(() => useTaskStream("task-1"));
    expect(result.current.status).toBe("queued");
    expect(result.current.reply).toBe("");
    expect(result.current.toolUses).toEqual([]);
    expect(result.current.questions).toEqual([]);
  });

  it("connects to the correct SSE URL", () => {
    renderHook(() => useTaskStream("task-abc"));
    expect(fakeESInstances).toHaveLength(1);
    expect(fakeESInstances[0].url).toBe("/api/tasks/task-abc/stream");
  });

  it("accumulates text events into the reply", () => {
    const { result } = renderHook(() => useTaskStream("task-1"));
    const es = fakeESInstances[0];

    act(() => {
      es.emit({ t: "status", status: "running", at: Date.now() });
      es.emit({ t: "text", text: "Hello " });
      es.emit({ t: "text", text: "world!" });
    });

    expect(result.current.status).toBe("running");
    expect(result.current.reply).toBe("Hello world!");
  });

  it("tracks tool uses and activity labels", () => {
    const { result } = renderHook(() => useTaskStream("task-1"));
    const es = fakeESInstances[0];

    act(() => {
      es.emit({ t: "tool_use", name: "Read" });
      es.emit({ t: "activity", label: "Reading file…" });
    });

    expect(result.current.toolUses).toEqual(["Read"]);
    expect(result.current.activity).toBe("Reading file…");
  });

  it("surfaces questions from the agent", () => {
    const { result } = renderHook(() => useTaskStream("task-1"));
    const es = fakeESInstances[0];

    act(() => {
      es.emit({
        t: "question",
        qid: "q1",
        question: "Which database should I use?",
        assumed: "PostgreSQL",
      });
    });

    expect(result.current.questions).toHaveLength(1);
    expect(result.current.questions[0]).toEqual({
      qid: "q1",
      question: "Which database should I use?",
      assumed: "PostgreSQL",
    });
  });

  it("deduplicates questions by qid", () => {
    const { result } = renderHook(() => useTaskStream("task-1"));
    const es = fakeESInstances[0];

    act(() => {
      es.emit({ t: "question", qid: "q1", question: "A?", assumed: "B" });
      es.emit({ t: "question", qid: "q1", question: "A?", assumed: "B" }); // duplicate
    });

    expect(result.current.questions).toHaveLength(1);
  });

  it("captures cost, tokens, and model from result event", () => {
    const { result } = renderHook(() => useTaskStream("task-1"));
    const es = fakeESInstances[0];

    act(() => {
      es.emit({
        t: "result",
        isError: false,
        costUsd: 0.042,
        tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 },
        model: "claude-sonnet-4-6",
      });
    });

    expect(result.current.costUsd).toBe(0.042);
    expect(result.current.tokens).toEqual({
      input: 1000,
      output: 500,
      cacheRead: 200,
      cacheWrite: 100,
    });
    expect(result.current.model).toBe("claude-sonnet-4-6");
  });

  it("transitions to error state on error event", () => {
    const { result } = renderHook(() => useTaskStream("task-1"));
    const es = fakeESInstances[0];

    act(() => {
      es.emit({ t: "error", message: "claude exited 1" });
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("claude exited 1");
  });

  it("clears activity on done event", () => {
    const { result } = renderHook(() => useTaskStream("task-1"));
    const es = fakeESInstances[0];

    act(() => {
      es.emit({ t: "activity", label: "Working…" });
    });
    expect(result.current.activity).toBe("Working…");

    act(() => {
      es.emit({ t: "done", code: 0 });
    });
    expect(result.current.activity).toBeUndefined();
  });

  it("closes EventSource on unmount", () => {
    const { unmount } = renderHook(() => useTaskStream("task-1"));
    const es = fakeESInstances[0];
    unmount();
    expect(es.close).toHaveBeenCalled();
  });

  it("does not open EventSource when enabled=false", () => {
    renderHook(() => useTaskStream("task-1", false));
    expect(fakeESInstances).toHaveLength(0);
  });

  it("captures summary from summary event", () => {
    const { result } = renderHook(() => useTaskStream("task-1"));
    const es = fakeESInstances[0];

    act(() => {
      es.emit({ t: "summary", summary: "Compared five approaches and chose option B." });
    });

    expect(result.current.summary).toBe("Compared five approaches and chose option B.");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration: all three tiers wired together
// ═══════════════════════════════════════════════════════════════════════════
//
// This final test proves the tiers compose: data is written (Tier 1), the
// service layer transforms it (Tier 2 security mask), and the UI consumes
// an event stream that references both (Tier 3). This is the pattern for
// end-to-end feature tests that span all layers without hitting real APIs.
// ═══════════════════════════════════════════════════════════════════════════

describe("Integration — all three tiers wired together", () => {
  let tempDir: string;
  let originalCwd: () => string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `aria-integ-test-${randomUUID()}`);
    await mkdir(join(tempDir, "data", "memory", "projects", "integ", "turns"), { recursive: true });
    await mkdir(join(tempDir, "data", "agents"), { recursive: true });

    originalCwd = process.cwd;
    process.cwd = () => tempDir;

    fakeESInstances = [];
    (globalThis as unknown as Record<string, unknown>).EventSource = FakeEventSource;
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    delete (globalThis as unknown as Record<string, unknown>).EventSource;
    await rm(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("data persists → service masks it → UI streams the result", async () => {
    // --- Tier 1: Write data ---
    const mem = await import("@/lib/persona-memory");
    const turn = await mem.appendTurn("integ", {
      prompt: "Set up the Figma integration",
      reply: "Done — Designer agent now has FIGMA_TOKEN configured.",
      toolUses: ["setCredential"],
    });
    expect(turn.id).toBe(1);

    // --- Tier 2: Store a credential, then verify masking ---
    const creds = await import("@/lib/credentials");
    await creds.setCredential("designer", "FIGMA_TOKEN", "fig_realSecret123");

    const redacted = await creds.listRedacted("designer");
    expect(redacted[0].preview).toContain("••••");
    expect(redacted[0].preview).not.toBe("fig_realSecret123");

    // The raw token is available server-side for process spawning.
    const env = await creds.envForAgent("designer");
    expect(env.FIGMA_TOKEN).toBe("fig_realSecret123");

    // --- Tier 3: Hook accumulates events that reference the work above ---
    const { renderHook, act } = await import("@testing-library/react");
    const { useTaskStream } = await import("@/components/tasks/use-task-stream");

    const { result } = renderHook(() => useTaskStream("task-integ"));
    const es = fakeESInstances[0];

    act(() => {
      es.emit({ t: "status", status: "running", at: Date.now() });
      es.emit({ t: "tool_use", name: "setCredential" });
      es.emit({ t: "text", text: "Configured FIGMA_TOKEN for the Designer agent." });
      es.emit({ t: "result", isError: false, costUsd: 0.01 });
      es.emit({ t: "done", code: 0 });
    });

    expect(result.current.reply).toBe("Configured FIGMA_TOKEN for the Designer agent.");
    expect(result.current.toolUses).toContain("setCredential");
    expect(result.current.costUsd).toBe(0.01);

    // --- Verify the data tier and service tier stayed in sync ---
    const memoryBlock = await mem.buildMemoryBlock("integ", "Integration Test");
    expect(memoryBlock).toContain("Set up the Figma integration");
    expect(memoryBlock).toContain("FIGMA_TOKEN");
    // SECURITY: the memory block must never contain the raw token.
    expect(memoryBlock).not.toContain("fig_realSecret123");
  });
});
