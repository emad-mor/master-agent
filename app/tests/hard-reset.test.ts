/**
 * Hard memory reset — wipes ALL memory (every project + global core) so Daryan
 * starts fresh. Tested ONLY against an isolated temp sandbox (process.cwd() is
 * redirected, persona-memory is imported fresh against it) so this NEVER touches
 * real memory. persona-memory is reached exclusively via sandbox.importFresh.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createDataSandbox, type DataSandbox } from "./mock-factories";

type Mem = typeof import("@/lib/persona-memory");

describe("hardResetMemory", () => {
  let sandbox: DataSandbox;
  let mem: Mem;

  beforeEach(async () => {
    sandbox = await createDataSandbox();
    // Sanity: we MUST be operating inside a throwaway temp dir, never the repo.
    expect(sandbox.root).toContain("aria-test-");
    mem = await sandbox.importFresh<Mem>("@/lib/persona-memory");
  });
  afterEach(async () => { await sandbox.teardown(); });

  it("removes all memory and re-seeds core fresh", async () => {
    // Seed memory across tiers: a user core fact + a project turn.
    await mem.addCore("Remember the deploy runs on Fridays.", "user");
    await mem.appendTurn("proj-a", { prompt: "hi", reply: "hello", toolUses: [] });
    const memDir = join(sandbox.dataDir, "memory");
    expect(existsSync(memDir)).toBe(true);
    expect((await mem.listCore()).length).toBeGreaterThan(2);      // seeds + the user fact
    expect((await mem.listTurns("proj-a")).length).toBe(1);

    await mem.hardResetMemory();

    // The whole memory dir is gone…
    expect(existsSync(memDir)).toBe(false);
    // …and the project's turns are empty again.
    expect(await mem.listTurns("proj-a")).toEqual([]);
    // …and core comes back as JUST the seeds (the user fact is gone) — fresh.
    const core = await mem.listCore();
    expect(core.every((c) => c.source === "seed")).toBe(true);
    expect(core.some((c) => /You are Daryan/i.test(c.text))).toBe(true);
  });

  it("is safe to call when there is no memory yet", async () => {
    await expect(mem.hardResetMemory()).resolves.toBeUndefined();
  });
});
