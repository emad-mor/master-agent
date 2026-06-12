---
title: 3-Tier Mocking Strategy
scope: master-agent/app (Next.js 15 — Aria agent)
status: DRAFT — pending review
---

# 3-Tier Mocking Strategy

## Toolchain Decision

| Tool | Role | Why |
|------|------|-----|
| **Vitest** | Test runner + module mocking (`vi.mock`, `vi.fn`, `vi.spyOn`) | Zero-config with the existing Vite/Turbopack pipeline; native ESM; fast HMR-aware watch mode |
| **@testing-library/react** | Component rendering + DOM queries | De facto standard for React 19; user-centric queries (`getByRole`, `findByText`) |
| **MSW 2.x** | Network-level HTTP/SSE interception | Intercepts `fetch` in both Node (tests) and browser (Storybook/dev); lets API route handlers stay untouched |
| **happy-dom** | Lightweight DOM for Vitest | Faster than jsdom; sufficient for this app's DOM needs |

### Prerequisite: Make Data Roots Injectable

Several lib modules hardcode `const ROOT = join(process.cwd(), "data", ...)`. For testability, each must read an optional env var first:

```ts
// Before (persona-memory.ts:28):
const ROOT = join(process.cwd(), "data", "memory");

// After:
const ROOT = join(process.env.ARIA_DATA_DIR || join(process.cwd(), "data"), "memory");
```

Apply the same pattern to `agents.ts` (line 17), `credentials.ts` (line 22), `flow-store.ts`, and `flow-templates.ts`. This is the **only production code change** required to enable the full mocking strategy.

### Bootstrap (one-time)

```bash
npm i -D vitest @testing-library/react @testing-library/jest-dom \
  happy-dom msw @testing-library/user-event
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
```

`src/test/setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);
```

---

## Dependency Diagram — How Mocks Flow Between Tiers

```
 ┌───────────────────────────────────────────────────────────────┐
 │                   TIER 1 — PRESENTATION                       │
 │                                                               │
 │  Components under test (page.tsx, tasks-dashboard, etc.)      │
 │       │  imports              │  fetch / SSE                  │
 │       ▼                       ▼                               │
 │  ┌──────────┐          ┌────────────┐                         │
 │  │ vi.mock  │          │ MSW server │ ← intercepts all HTTP   │
 │  │ stubs    │          │ handlers   │   before it leaves the  │
 │  │ (Tier 2) │          │ (Tier 3)   │   process               │
 │  └──────────┘          └────────────┘                         │
 └───────────────────────────────────────────────────────────────┘
              │                       │
              ▼                       ▼
 ┌───────────────────────────────────────────────────────────────┐
 │                   TIER 2 — BUSINESS LOGIC                     │
 │                                                               │
 │  Pure lib/ modules under test                                 │
 │       │  imports                                               │
 │       ▼                                                       │
 │  ┌──────────┐   ┌──────────────┐   ┌──────────────┐          │
 │  │ vi.mock  │   │ vi.spyOn     │   │ Fixture      │          │
 │  │ (fs,     │   │ (spawn,      │   │ factories    │          │
 │  │ crypto)  │   │ child_proc)  │   │ (agents,     │          │
 │  └──────────┘   └──────────────┘   │  tasks, etc) │          │
 │                                     └──────────────┘          │
 └───────────────────────────────────────────────────────────────┘
              │
              ▼
 ┌───────────────────────────────────────────────────────────────┐
 │                   TIER 3 — DATA / PERSISTENCE                 │
 │                                                               │
 │  ┌─────────────────┐    ┌───────────────────────┐             │
 │  │ memfs / tmp dir │    │ MSW handlers          │             │
 │  │ (JSON stores)   │    │ (external API stubs)  │             │
 │  └─────────────────┘    └───────────────────────┘             │
 │           ▲                       ▲                           │
 │     lib modules                presentation fetch             │
 │     read/write here             hits these                    │
 └───────────────────────────────────────────────────────────────┘

Flow direction:
  Tests compose mocks bottom-up: Tier 3 fixtures → Tier 2 module mocks → Tier 1 render.
  Each tier can be tested in isolation OR integrated with the tier below it.
```

---

## Tier 1 — Presentation Mocks (UI Components)

### Goal
Test that components render correct states, handle user interaction, and call the right APIs — without spawning real `claude` processes or touching the file system.

### Approach: Shallow Integration via MSW + Module Stubs

| What to mock | How | Why not deeper? |
|---|---|---|
| API responses (`/api/persona/run`, `/api/tasks`, etc.) | **MSW `http.get/post` handlers** returning canned JSON or SSE streams | Keeps `fetch` calls real; tests the actual request-building code |
| SSE streams (`useTaskStream`, chat streaming) | **MSW `http.get` handler** that writes SSE frames to a `ReadableStream` | Validates the client's EventSource/fetch-stream parsing |
| Heavy child components (e.g., `FlowGraph` inside `TasksDashboard`) | **`vi.mock`** with a stub returning a `<div data-testid="flow-graph" />` | Avoids SVG layout complexity in unit tests; test `FlowGraph` separately |
| `next/navigation` (`useRouter`, `usePathname`) | **`vi.mock("next/navigation")`** returning controlled values | Standard Next.js testing pattern |
| `window.speechSynthesis`, `MediaRecorder` | **`vi.stubGlobal`** with minimal fakes | Browser APIs absent in happy-dom |

### Example: Testing `TasksDashboard` Polling

```ts
// src/components/tasks/__tests__/tasks-dashboard.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw-server";
import { TasksDashboard } from "../tasks-dashboard";
import { taskFixture } from "@/test/fixtures/task";

// Stub FlowGraph — tested separately
vi.mock("../flow-graph", () => ({
  FlowGraph: () => <div data-testid="flow-graph" />,
}));

test("renders queued tasks and transitions to running on next poll", async () => {
  const task = taskFixture({ status: "queued", name: "Research API" });

  // First poll: queued
  server.use(
    http.get("/api/tasks", () => HttpResponse.json({ tasks: [task] })),
  );

  render(<TasksDashboard />);
  expect(await screen.findByText("Research API")).toBeInTheDocument();
  expect(screen.getByText("queued")).toBeInTheDocument();

  // Second poll: running
  server.use(
    http.get("/api/tasks", () =>
      HttpResponse.json({ tasks: [{ ...task, status: "running" }] }),
    ),
  );

  await waitFor(() => expect(screen.getByText("running")).toBeInTheDocument());
});
```

### Example: Testing SSE Chat Streaming

```ts
// src/test/msw-handlers/persona-run.ts
import { http, HttpResponse } from "msw";

export const personaRunHandler = http.post("/api/persona/run", () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(encoder.encode("data: {\"t\":\"text\",\"text\":\"Hello \"}\n\n"));
      ctrl.enqueue(encoder.encode("data: {\"t\":\"text\",\"text\":\"world\"}\n\n"));
      ctrl.enqueue(encoder.encode("data: {\"t\":\"result\",\"isError\":false}\n\n"));
      ctrl.close();
    },
  });
  return new HttpResponse(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
});
```

### Edge Cases to Cover

- **Empty task list** — dashboard shows empty state, not a crash.
- **SSE connection drop** — component retries or shows error banner.
- **Rapid session switching** — stale fetch responses for the old session are discarded (race condition guard).
- **File drop with 0-byte file** — `page.tsx` attachment logic doesn't send empty payload.

---

## Tier 2 — Business Logic Mocks (lib/ Services)

### Goal
Test orchestration logic, memory eviction, agent CRUD, and flow planning — without spawning `claude` child processes or touching real disk I/O.

### Approach: Module-Level `vi.mock` + Fixture Factories

The lib modules have two external boundaries that need mocking:

| Boundary | Mock technique |
|---|---|
| **`child_process.spawn`** (used by `orchestrator.ts`, `persona-memory.ts`, `agents.ts`) | `vi.mock("node:child_process")` returning a fake `ChildProcess` that emits canned NDJSON |
| **`node:fs/promises`** (all persistence modules) | `vi.mock("node:fs/promises")` backed by an in-memory Map, OR use a real temp directory (`os.tmpdir()`) for integration-level tests |

### Fixture Factories

Central factory file so every test builds from the same shapes:

```ts
// src/test/fixtures/task.ts
import type { TaskStatus, TaskEvent } from "@/lib/orchestrator";

let seq = 0;
export function taskFixture(overrides: Partial<{
  id: string; name: string; status: TaskStatus; agentId: string;
}> = {}) {
  return {
    id: overrides.id ?? `task-${++seq}`,
    name: overrides.name ?? "Test task",
    status: overrides.status ?? "queued",
    agentId: overrides.agentId ?? "agent-1",
    events: [] as TaskEvent[],
    createdAt: Date.now(),
  };
}
```

```ts
// src/test/fixtures/agent.ts
import type { Agent } from "@/lib/agents";

export function agentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    id: overrides.id ?? "agent-test",
    name: overrides.name ?? "Test Agent",
    instructions: overrides.instructions ?? "You are a test agent.",
    color: overrides.color ?? "#888888",
    canDelegate: overrides.canDelegate ?? false,
    skillIds: overrides.skillIds ?? [],
    integrations: overrides.integrations ?? [],
    createdAt: overrides.createdAt ?? Date.now(),
  };
}
```

### Example: Testing Orchestrator DAG Execution

```ts
// src/lib/__tests__/orchestrator.test.ts
import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock child_process before importing orchestrator
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Mock file-system persistence
vi.mock("@/lib/flow-store", () => ({
  scheduleFlowSnapshot: vi.fn(),
  loadFlowSnapshotSync: vi.fn(() => ({ flows: {} })),
}));

import { spawn } from "node:child_process";
import { startFlow, getTask } from "@/lib/orchestrator";
import { EventEmitter, Readable } from "node:stream";

function fakeClaudeProcess(output: string) {
  const proc = new EventEmitter() as any;
  proc.stdout = Readable.from([output]);
  proc.stderr = Readable.from([]);
  proc.pid = 9999;
  proc.kill = vi.fn();
  // Simulate exit after stdout drains
  setTimeout(() => proc.emit("close", 0), 10);
  return proc;
}

describe("DAG execution", () => {
  beforeEach(() => {
    vi.mocked(spawn).mockImplementation(() => fakeClaudeProcess(
      JSON.stringify({ type: "result", subtype: "success", result: "done", total_cost_usd: 0.01 }) + "\n"
    ) as any);
  });

  it("runs independent steps in parallel, dependent steps sequentially", async () => {
    const { flowId, taskIds } = await startFlow({
      name: "test-flow",
      steps: [
        { key: "a", prompt: "step A", dependsOn: [] },
        { key: "b", prompt: "step B", dependsOn: [] },
        { key: "c", prompt: "step C using {{a}} and {{b}}", dependsOn: ["a", "b"] },
      ],
      project: "__workspace__",
    });

    // taskIds is [{ key, taskId }] — task IDs are UUIDs, not flowId:key
    const idMap = new Map(taskIds.map(({ key, taskId }) => [key, taskId]));

    // Wait for all three tasks to complete
    await vi.waitFor(() => {
      for (const [, taskId] of idMap) {
        expect(getTask(taskId)?.status).toBe("done");
      }
    }, { timeout: 5000 });

    // Steps a and b should have started before c
    const calls = vi.mocked(spawn).mock.calls;
    expect(calls.length).toBe(3);
  });
});
```

### Example: Testing Memory Eviction

> **Important:** `persona-memory.ts` builds absolute paths from `process.cwd()` (line 28:
> `const ROOT = join(process.cwd(), "data", "memory")`). Swapping `node:fs/promises`
> with `memfs` alone won't work because `memfs` resolves against its own virtual root,
> not `process.cwd()`. The cleanest fix is to make ROOT injectable via an env var
> (e.g., `ARIA_DATA_DIR`), then point it at a real temp directory in tests.

```ts
// src/lib/__tests__/persona-memory.test.ts
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter, Readable } from "node:stream";

// Mock the Haiku spawn used for distillation
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as any;
    proc.stdout = Readable.from([JSON.stringify({
      type: "result", result: "Distilled summary"
    })]);
    proc.stderr = Readable.from([]);
    setTimeout(() => proc.emit("close", 0), 5);
    return proc;
  }),
}));

let testDir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "aria-mem-test-"));
  // Point the module's ROOT at our temp dir
  vi.stubEnv("ARIA_DATA_DIR", testDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(testDir, { recursive: true, force: true });
});

describe("evictIfNeeded", () => {
  it("rolls recent turns to mid-term when count exceeds 20", async () => {
    const projKey = "test-project";
    const turnsPath = join(testDir, "memory", "projects", projKey, "turns");
    await mkdir(turnsPath, { recursive: true });

    // Seed 25 turn files
    for (let i = 0; i < 25; i++) {
      await writeFile(
        join(turnsPath, `${i}.json`),
        JSON.stringify({ role: "user", text: `Turn ${i}`, ts: Date.now() - (25 - i) * 1000 }),
      );
    }

    // Dynamic import so the stubbed env var is picked up
    const { evictIfNeeded } = await import("@/lib/persona-memory");
    await evictIfNeeded(projKey);

    const remaining = await readdir(turnsPath);
    expect(remaining.length).toBeLessThanOrEqual(20);
  });
});
```

### Critical Edge Cases

- **Concurrent flow starts exceeding `MAX_CONCURRENT=4`** — tasks 5+ must queue and start only when a slot frees.
- **`[[ASK qid=...]]` parsing** — regex must handle multi-line text, nested brackets, and missing `assumed=` gracefully.
- **`spawn` failure (ENOENT)** — orchestrator should emit an `error` event, not crash the process.
- **`{{stepKey}}` interpolation with missing upstream** — should produce a clear error, not silently inject `undefined`.
- **Memory distillation with empty turns** — Haiku spawn shouldn't fire for zero-length input.

---

## Tier 3 — Data / Persistence Mocks (API Responses + File Stores)

### Goal
Provide deterministic, isolated data for both Tier 1 (network responses) and Tier 2 (file system state) tests.

### Approach A: MSW Handlers (for Presentation Tests)

Centralized handler set that mirrors every API route:

```ts
// src/test/msw-server.ts
import { setupServer } from "msw/node";
import { defaultHandlers } from "./msw-handlers";

export const server = setupServer(...defaultHandlers);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

```ts
// src/test/msw-handlers/index.ts
import { http, HttpResponse } from "msw";
import { agentFixture } from "../fixtures/agent";
import { taskFixture } from "../fixtures/task";

export const defaultHandlers = [
  // Tasks
  http.get("/api/tasks", () => HttpResponse.json({ tasks: [] })),
  http.post("/api/tasks", async ({ request }) => {
    const body = await request.json() as any;
    return HttpResponse.json(taskFixture({ name: body.prompt }));
  }),

  // Agents
  http.get("/api/agents", () => HttpResponse.json({
    agents: [agentFixture({ id: "researcher", name: "Researcher" })],
  })),

  // Projects
  http.get("/api/projects", () => HttpResponse.json({
    projects: [{ slug: "test-proj", name: "Test Project", path: "/tmp/test" }],
  })),

  // Memory
  http.get("/api/persona/memory", () => HttpResponse.json({
    core: ["User prefers concise answers"],
    long: [],
    mid: [],
    recent: [],
  })),

  // Speak (TTS) — return empty audio
  http.post("/api/speak", () => new HttpResponse(new ArrayBuffer(0), {
    headers: { "Content-Type": "audio/wav" },
  })),
];
```

### Approach B: File System Fixtures (for Business Logic Tests)

Two strategies depending on test isolation needs:

| Strategy | When to use | Trade-off |
|---|---|---|
| **`memfs`** (`vi.mock("node:fs/promises")`) | Unit tests that must be fast + fully isolated | Cannot test real path resolution edge cases |
| **Temp directory** (`mkdtemp` + cleanup in `afterEach`) | Integration tests that need real FS behavior | Slightly slower; must clean up |

```ts
// src/test/fs-fixtures.ts
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function createTestDataDir() {
  const dir = await mkdtemp(join(tmpdir(), "aria-test-"));
  // Seed required directory structure
  await mkdir(join(dir, "agents"), { recursive: true });
  await mkdir(join(dir, "memory", "projects", "test-proj", "turns"), { recursive: true });
  await mkdir(join(dir, "flows"), { recursive: true });

  // Seed a default agent
  await writeFile(
    join(dir, "agents", "researcher.json"),
    JSON.stringify({
      id: "researcher", name: "Researcher",
      instructions: "You are a researcher.", color: "#3B82F6",
      canDelegate: false, skillIds: [], integrations: [], createdAt: Date.now(),
    }),
  );

  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
```

Override the data root in tests:
```ts
// In test setup, before importing lib modules:
vi.stubEnv("ARIA_DATA_DIR", testDataDir);
// Or mock the ROOT constant via vi.mock
```

### Critical Edge Cases

- **Corrupt JSON on disk** — `JSON.parse` fails; modules must return safe defaults (they currently do via `catch { return {} }`).
- **Missing directories** — `mkdir({ recursive: true })` handles this, but tests should verify the first-run path.
- **Race condition on concurrent writes** — `flow-store.ts` uses debounced writes (400ms); tests should verify that rapid `scheduleFlowSnapshot` calls coalesce, not corrupt.
- **Credentials file permissions** — `chmod(0o600)` is best-effort; test both success and failure paths.

---

## Integration Points — Cross-Tier Test Patterns

### Pattern 1: Component → API → Lib (Full Vertical Slice)

For critical paths (e.g., "user sends a message and sees the streamed response"), test the full stack without mocking Tier 2:

```
Component render  →  real fetch  →  MSW intercepts  →  returns realistic SSE
                                     ↑
                         MSW handler calls actual lib function
                         with a mocked spawn (no real claude)
```

This catches contract mismatches between what the UI expects and what the API actually returns.

### Pattern 2: Lib → FS (Persistence Round-Trip)

```
Test calls lib.createAgent(fixture)  →  lib writes to temp dir  →  test reads and asserts
Test calls lib.getAgent(id)          →  lib reads from temp dir  →  asserts shape matches
```

This catches serialization bugs (missing fields, wrong defaults on load).

### Pattern 3: Orchestrator → Spawn (Process Lifecycle)

```
Test calls startFlow(dag)  →  orchestrator spawns fake processes  →  test asserts:
  - correct concurrency (never >4 simultaneous)
  - correct DAG ordering (deps before dependents)
  - correct output interpolation ({{stepA}} replaced with step A's result)
  - error propagation (one step fails → downstream steps skip)
```

---

## File Organization

```
src/
  test/
    setup.ts                    # Global: cleanup, jest-dom matchers
    msw-server.ts               # MSW server instance
    msw-handlers/
      index.ts                  # Default handler set (all routes)
      persona-run.ts            # SSE streaming handler
      tasks.ts                  # Task CRUD + streaming handlers
    fixtures/
      agent.ts                  # agentFixture()
      task.ts                   # taskFixture()
      memory.ts                 # memoryFixture() — all 4 tiers
      flow.ts                   # flowFixture() — DAG with steps
    fs-fixtures.ts              # Temp directory seeding + cleanup
  lib/
    __tests__/
      orchestrator.test.ts
      persona-memory.test.ts
      agents.test.ts
      credentials.test.ts
      flow-templates.test.ts
  components/
    tasks/
      __tests__/
        tasks-dashboard.test.ts
        flow-graph.test.ts
        use-task-stream.test.ts
    home/
      __tests__/
        file-tree.test.ts
    persona/
      __tests__/
        persona-widget.test.ts
        persona-memory-drawer.test.ts
  app/
    __tests__/
      page.test.tsx             # Main chat page
```

---

## Priority Order (What to Test First)

| Priority | Module | Rationale |
|---|---|---|
| **P0** | `orchestrator.ts` — DAG execution, concurrency, `[[ASK]]` parsing | Core engine; bugs here break every flow |
| **P0** | `persona-memory.ts` — eviction, distillation, `buildMemoryBlock` | Data loss risk; the memory wipe incident (see project memory) |
| **P1** | `agents.ts` — CRUD, `planFlow` | Foundation for all task execution |
| **P1** | `tasks-dashboard.tsx` — polling, status transitions | Primary user-facing surface |
| **P2** | `page.tsx` — chat streaming, session switching | Complex but less fragile (mostly UI wiring) |
| **P2** | `credentials.ts` — redaction, env injection | Security-sensitive; verify tokens never appear in task events, logs, or API responses |
| **P3** | `flow-graph.tsx`, `persona-widget.tsx` | Visual components; lower defect risk |
