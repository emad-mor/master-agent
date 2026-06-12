/**
 * Three-Tier Mock Factories
 *
 * Reusable helpers for isolating tests at each layer of the Aria stack.
 * Every factory follows the same temp-dir + dynamic-import strategy
 * established in three-tier-example.test.tsx — no vi.mock(), no MSW,
 * just structural isolation that keeps tests faithful to production.
 *
 *   createDataSandbox    — Tier 1 (data/FS): redirects process.cwd()
 *   createServiceStub    — Tier 2 (business logic): provides pre-seeded lib modules
 *   createApiHarness     — Tier 3 (API/HTTP): builds Request objects + invokes handlers
 *   createEventSourceShim — Tier 3 (UI): fake EventSource for SSE hooks
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { vi, type Mock } from "vitest";

// ═══════════════════════════════════════════════════════════════════════════
// Tier 1 — DATA SANDBOX
// ═══════════════════════════════════════════════════════════════════════════
//
// Creates an isolated temp directory with the full data/ tree that lib
// modules expect, redirects process.cwd(), and returns a teardown fn.
// Call `sandbox.importFresh(path)` after setup to get modules whose
// ROOT constants resolve to the sandbox.
// ═══════════════════════════════════════════════════════════════════════════

export type DataSandbox = {
  /** Absolute path to the temp root (stands in for the app dir). */
  root: string;
  /** Absolute path to root/data — where all persisted JSON lives. */
  dataDir: string;
  /** Dynamic-import a module so its top-level `process.cwd()` resolves here. */
  importFresh: <T = Record<string, unknown>>(specifier: string) => Promise<T>;
  /** Write a raw JSON fixture into the sandbox data/ tree. */
  seed: (relPath: string, data: unknown) => Promise<void>;
  /** Restore process.cwd and clean up the temp dir. Call in afterEach. */
  teardown: () => Promise<void>;
};

/**
 * Stand up an isolated data sandbox.
 *
 * @param dirs Extra directories (relative to root) to pre-create beyond
 *             the defaults. E.g. `["data/flows"]`.
 */
export async function createDataSandbox(dirs: string[] = []): Promise<DataSandbox> {
  const root = join(tmpdir(), `aria-test-${randomUUID()}`);
  const dataDir = join(root, "data");

  // Default directory tree that lib modules assume exists.
  const defaults = [
    "data/memory/projects",
    "data/agents",
    "data/flows",
  ];

  for (const d of [...defaults, ...dirs]) {
    await mkdir(join(root, d), { recursive: true });
  }

  const originalCwd = process.cwd;
  process.cwd = () => root;

  return {
    root,
    dataDir,

    async importFresh<T = Record<string, unknown>>(specifier: string): Promise<T> {
      return (await import(specifier)) as T;
    },

    async seed(relPath: string, data: unknown) {
      const abs = join(dataDir, relPath);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, JSON.stringify(data, null, 2), "utf8");
    },

    async teardown() {
      process.cwd = originalCwd;
      await rm(root, { recursive: true, force: true });
      vi.resetModules();
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tier 2 — SERVICE STUBS
// ═══════════════════════════════════════════════════════════════════════════
//
// Wraps createDataSandbox and pre-imports the most commonly tested lib
// modules so tests can jump straight into asserting business logic.
// ═══════════════════════════════════════════════════════════════════════════

export type ServiceStub = {
  sandbox: DataSandbox;
  /** Pre-loaded lib/persona-memory module. */
  memory: typeof import("@/lib/persona-memory");
  /** Pre-loaded lib/credentials module. */
  credentials: typeof import("@/lib/credentials");
  /** Pre-loaded lib/agents module. */
  agents: typeof import("@/lib/agents");
  /** Pre-loaded lib/workspace module. */
  workspace: typeof import("@/lib/workspace");
  /** Pre-loaded lib/flow-store module. */
  flowStore: typeof import("@/lib/flow-store");
  /** Tear everything down. Call in afterEach. */
  teardown: () => Promise<void>;
};

/**
 * Stand up a data sandbox AND dynamically import the core service modules
 * so their ROOT constants point at the sandbox.
 *
 * @param opts.projectKey  If given, pre-creates the turns dir for this project.
 * @param opts.extraDirs   Extra directories to pre-create.
 */
export async function createServiceStub(opts?: {
  projectKey?: string;
  extraDirs?: string[];
}): Promise<ServiceStub> {
  const dirs = opts?.extraDirs ?? [];
  if (opts?.projectKey) {
    dirs.push(`data/memory/projects/${opts.projectKey}/turns`);
  }
  const sandbox = await createDataSandbox(dirs);

  const [memory, credentials, agents, workspace, flowStore] = await Promise.all([
    sandbox.importFresh<typeof import("@/lib/persona-memory")>("@/lib/persona-memory"),
    sandbox.importFresh<typeof import("@/lib/credentials")>("@/lib/credentials"),
    sandbox.importFresh<typeof import("@/lib/agents")>("@/lib/agents"),
    sandbox.importFresh<typeof import("@/lib/workspace")>("@/lib/workspace"),
    sandbox.importFresh<typeof import("@/lib/flow-store")>("@/lib/flow-store"),
  ]);

  return {
    sandbox,
    memory,
    credentials,
    agents,
    workspace,
    flowStore,
    teardown: () => sandbox.teardown(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tier 3a — API HARNESS
// ═══════════════════════════════════════════════════════════════════════════
//
// Builds NextRequest-shaped objects and calls route handlers directly,
// returning the parsed JSON + status. No HTTP server required — the handler
// is just an async function.
// ═══════════════════════════════════════════════════════════════════════════

export type ApiResult<T = unknown> = {
  status: number;
  body: T;
  headers: Headers;
};

/**
 * Call a Next.js route handler function directly.
 *
 * @param handler  The exported GET/POST/PATCH/DELETE from a route.ts
 * @param opts.method   HTTP method (defaults to GET).
 * @param opts.body     JSON body (for POST/PATCH/PUT).
 * @param opts.params   Dynamic route params, e.g. `{ id: "abc" }`.
 * @param opts.search   Query-string params, e.g. `{ id: "abc" }`.
 */
export async function callRouteHandler<T = unknown>(
  handler: (req: Request, ctx?: { params: Record<string, string> }) => Promise<Response>,
  opts?: {
    method?: string;
    body?: unknown;
    params?: Record<string, string>;
    search?: Record<string, string>;
  },
): Promise<ApiResult<T>> {
  const method = opts?.method ?? "GET";
  const url = new URL("http://localhost:3000/api/test");
  if (opts?.search) {
    for (const [k, v] of Object.entries(opts.search)) {
      url.searchParams.set(k, v);
    }
  }

  const init: RequestInit = { method };
  if (opts?.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }

  const req = new Request(url.toString(), init);
  const ctx = opts?.params ? { params: opts.params } : undefined;
  const res = await handler(req, ctx);
  const body = (await res.json().catch(() => null)) as T;

  return { status: res.status, body, headers: res.headers };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tier 3b — FAKE EventSource (UI / SSE hooks)
// ═══════════════════════════════════════════════════════════════════════════
//
// A minimal shim that replaces globalThis.EventSource so React hooks that
// open SSE connections can be tested without a network. Call `install()`
// in beforeEach and `teardown()` in afterEach.
// ═══════════════════════════════════════════════════════════════════════════

export type FakeESInstance = {
  url: string;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close: Mock;
  /** Push a JSON event into the onmessage handler. */
  emit: (data: Record<string, unknown>) => void;
};

export type EventSourceShim = {
  /** All FakeEventSource instances created since install(). */
  instances: FakeESInstance[];
  /** The most recently created instance (convenience). */
  latest: () => FakeESInstance;
  /** Restore the real EventSource. Call in afterEach. */
  teardown: () => void;
};

export function createEventSourceShim(): EventSourceShim {
  const instances: FakeESInstance[] = [];

  class FakeEventSource {
    url: string;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    close = vi.fn();

    constructor(url: string) {
      this.url = url;
      instances.push(this as unknown as FakeESInstance);
    }

    emit(data: Record<string, unknown>) {
      this.onmessage?.({ data: JSON.stringify(data) });
    }
  }

  (globalThis as unknown as Record<string, unknown>).EventSource = FakeEventSource;

  return {
    instances,
    latest: () => {
      if (instances.length === 0) throw new Error("No FakeEventSource instances created yet");
      return instances[instances.length - 1];
    },
    teardown() {
      delete (globalThis as unknown as Record<string, unknown>).EventSource;
      instances.length = 0;
      vi.resetModules();
    },
  };
}
