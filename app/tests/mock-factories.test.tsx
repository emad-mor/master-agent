/**
 * Mock Factories — Example Usage & Smoke Tests
 *
 * Verifies that each factory tier works correctly and demonstrates how to
 * compose them for real feature tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createDataSandbox,
  createServiceStub,
  callRouteHandler,
  createEventSourceShim,
  type DataSandbox,
  type ServiceStub,
  type EventSourceShim,
} from "./mock-factories";

// ═══════════════════════════════════════════════════════════════════════════
// Tier 1 — DATA SANDBOX
// ═══════════════════════════════════════════════════════════════════════════

describe("Tier 1 — createDataSandbox", () => {
  let sandbox: DataSandbox;

  beforeEach(async () => {
    sandbox = await createDataSandbox(["data/memory/projects/demo/turns"]);
  });

  afterEach(async () => {
    await sandbox.teardown();
  });

  it("redirects process.cwd() to the sandbox root", () => {
    expect(process.cwd()).toBe(sandbox.root);
  });

  it("seed writes a fixture and importFresh reads it back", async () => {
    await sandbox.seed("agents/test-agent.json", {
      id: "test-agent",
      name: "Tester",
      instructions: "Run tests.",
    });

    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const raw = await readFile(join(sandbox.dataDir, "agents/test-agent.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.name).toBe("Tester");
  });

  it("persona-memory operates within the sandbox", async () => {
    const mem = await sandbox.importFresh<typeof import("@/lib/persona-memory")>(
      "@/lib/persona-memory",
    );

    await mem.appendTurn("demo", { prompt: "hi", reply: "hello", toolUses: [] });
    const turns = await mem.listTurns("demo");
    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe("hi");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tier 2 — SERVICE STUB
// ═══════════════════════════════════════════════════════════════════════════

describe("Tier 2 — createServiceStub", () => {
  let svc: ServiceStub;

  beforeEach(async () => {
    svc = await createServiceStub({ projectKey: "svc-test" });
  });

  afterEach(async () => {
    await svc.teardown();
  });

  it("provides pre-loaded memory module that works in the sandbox", async () => {
    const turn = await svc.memory.appendTurn("svc-test", {
      prompt: "What is X?",
      reply: "X is Y.",
      toolUses: ["Read"],
    });
    expect(turn.id).toBe(1);

    const turns = await svc.memory.listTurns("svc-test");
    expect(turns).toHaveLength(1);
  });

  it("provides pre-loaded credentials module with security guarantees", async () => {
    await svc.credentials.setCredential("agent-a", "API_KEY", "sk-live-secret123");

    const redacted = await svc.credentials.listRedacted("agent-a");
    expect(redacted).toHaveLength(1);
    expect(redacted[0].preview).toContain("••••");
    expect(redacted[0].preview).not.toBe("sk-live-secret123");

    const env = await svc.credentials.envForAgent("agent-a");
    expect(env.API_KEY).toBe("sk-live-secret123");
  });

  it("provides pre-loaded flow-store module", async () => {
    // loadFlowSnapshotSync returns null when no snapshot exists.
    const snap = svc.flowStore.loadFlowSnapshotSync();
    expect(snap).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tier 3a — API HARNESS (callRouteHandler)
// ═══════════════════════════════════════════════════════════════════════════

describe("Tier 3a — callRouteHandler", () => {
  let sandbox: DataSandbox;

  beforeEach(async () => {
    sandbox = await createDataSandbox();
  });

  afterEach(async () => {
    await sandbox.teardown();
  });

  it("calls a GET handler and returns parsed JSON + status", async () => {
    const { GET } = await sandbox.importFresh<typeof import("@/app/api/projects/route")>(
      "@/app/api/projects/route",
    );

    const res = await callRouteHandler<{ projects: unknown[] }>(GET);
    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual([]);
  });

  it("calls a POST handler with a body and validates error responses", async () => {
    const { POST } = await sandbox.importFresh<typeof import("@/app/api/agents/route")>(
      "@/app/api/agents/route",
    );

    // Missing required fields → 400.
    const bad = await callRouteHandler<{ error: string }>(POST, {
      method: "POST",
      body: { name: "" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBeTruthy();

    // Valid payload → 200 + agent.
    const good = await callRouteHandler<{ agent: { id: string; name: string } }>(POST, {
      method: "POST",
      body: { name: "Tester", instructions: "Run the test suite." },
    });
    expect(good.status).toBe(200);
    expect(good.body.agent.name).toBe("Tester");
    expect(good.body.agent.id).toBeTruthy();
  });

  it("calls a DELETE handler with query-string params", async () => {
    const { POST, DELETE } = await sandbox.importFresh<typeof import("@/app/api/agents/route")>(
      "@/app/api/agents/route",
    );

    // Create, then delete.
    const created = await callRouteHandler<{ agent: { id: string } }>(POST, {
      method: "POST",
      body: { name: "Ephemeral", instructions: "Gone soon." },
    });
    const id = created.body.agent.id;

    const del = await callRouteHandler<{ ok: boolean }>(DELETE, {
      method: "DELETE",
      search: { id },
    });
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tier 3b — EventSource SHIM (UI hooks)
// ═══════════════════════════════════════════════════════════════════════════

describe("Tier 3b — createEventSourceShim", () => {
  let shim: EventSourceShim;

  beforeEach(() => {
    shim = createEventSourceShim();
  });

  afterEach(() => {
    shim.teardown();
  });

  it("installs a fake EventSource and tracks instances", async () => {
    const { renderHook, act } = await import("@testing-library/react");
    const { useTaskStream } = await import("@/components/tasks/use-task-stream");

    const { result } = renderHook(() => useTaskStream("t-1"));
    expect(shim.instances).toHaveLength(1);
    expect(shim.latest().url).toBe("/api/tasks/t-1/stream");

    act(() => {
      shim.latest().emit({ t: "status", status: "running", at: Date.now() });
      shim.latest().emit({ t: "text", text: "Factory works!" });
    });

    expect(result.current.status).toBe("running");
    expect(result.current.reply).toBe("Factory works!");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration — all three factory tiers composed
// ═══════════════════════════════════════════════════════════════════════════

describe("Integration — factory tiers composed", () => {
  let svc: ServiceStub;
  let shim: EventSourceShim;

  beforeEach(async () => {
    svc = await createServiceStub({ projectKey: "integ" });
    shim = createEventSourceShim();
  });

  afterEach(async () => {
    shim.teardown();
    await svc.teardown();
  });

  it("data + service + API + UI all operate on the same sandbox", async () => {
    // Tier 1: persist a turn.
    await svc.memory.appendTurn("integ", {
      prompt: "Add logging",
      reply: "Added structured logging.",
      toolUses: ["Edit"],
    });

    // Tier 2: store + mask a credential.
    await svc.credentials.setCredential("logger", "LOG_TOKEN", "tok_secret456");
    const redacted = await svc.credentials.listRedacted("logger");
    expect(redacted[0].preview).not.toBe("tok_secret456");
    expect(redacted[0].preview).toContain("••••");

    // Tier 3a: call the projects API route.
    const { GET } = await svc.sandbox.importFresh<typeof import("@/app/api/projects/route")>(
      "@/app/api/projects/route",
    );
    const res = await callRouteHandler<{ projects: unknown[] }>(GET);
    expect(res.status).toBe(200);

    // Tier 3b: stream events through the hook.
    const { renderHook, act } = await import("@testing-library/react");
    const { useTaskStream } = await import("@/components/tasks/use-task-stream");

    const { result } = renderHook(() => useTaskStream("t-integ"));
    act(() => {
      shim.latest().emit({ t: "status", status: "running", at: Date.now() });
      shim.latest().emit({ t: "text", text: "Logging configured." });
      shim.latest().emit({ t: "done", code: 0 });
    });

    expect(result.current.reply).toBe("Logging configured.");

    // Verify memory persisted correctly.
    const block = await svc.memory.buildMemoryBlock("integ", "Integration");
    expect(block).toContain("Add logging");
    expect(block).not.toContain("tok_secret456");
  });
});
