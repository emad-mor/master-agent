/**
 * Atomic writeJson — verifies persona-memory's crash-safe write path.
 *
 * writeJson uses tmp + rename with a unique per-writer tmp name
 * (`<path>.<pid>.<uuid>.tmp`). This proves two things:
 *   1. A pre-existing stray `.tmp` file (left behind by an earlier crashed
 *      write) does NOT break a subsequent write or get mistaken for data.
 *   2. The target file is always fully written and reads back intact via the
 *      public listCore/addCore round-trip (which goes through writeJson/readJson).
 *
 * persona-memory derives its storage ROOT from process.cwd() at import time,
 * so each test stubs cwd to a fresh temp dir and imports the module fresh.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;
let memDir: string; // <cwd>/data/memory
let coreFile: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "persona-mem-"));
  memDir = join(tmpRoot, "data", "memory");
  coreFile = join(memDir, "core.json");
  await mkdir(memDir, { recursive: true });
  vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
  vi.resetModules(); // force a fresh import so ROOT/CORE_FILE bind to tmpRoot
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("atomic writeJson (via addCore/listCore round-trip)", () => {
  it("ignores a stray leftover .tmp file and still writes a valid target", async () => {
    // Seed a known-good core.json so we control the starting state.
    await writeFile(coreFile, JSON.stringify([], null, 2), "utf8");
    // Simulate a prior crashed write: an orphaned tmp file next to the target.
    const stray = `${coreFile}.99999.dead-beef.tmp`;
    await writeFile(stray, "{ this is half-written garbage", "utf8");

    const mem = await import("@/lib/persona-memory");
    const fact = await mem.addCore("user prefers terse answers", "user");
    expect(fact).not.toBeNull();

    // Target file is valid, fully-written JSON.
    const raw = await readFile(coreFile, "utf8");
    const parsed = JSON.parse(raw); // throws if torn → test fails
    expect(Array.isArray(parsed)).toBe(true);

    // Round-trips through readJson intact.
    const list = await mem.listCore();
    expect(list.some((c) => c.text === "user prefers terse answers")).toBe(true);

    // The stray tmp was neither read as data nor blindly clobbered.
    const strayRaw = await readFile(stray, "utf8");
    expect(strayRaw).toBe("{ this is half-written garbage");
  });

  it("leaves no tmp files behind after a successful write", async () => {
    await writeFile(coreFile, JSON.stringify([], null, 2), "utf8");

    const mem = await import("@/lib/persona-memory");
    await mem.addCore("no orphan tmp after write", "user");

    const files = await readdir(memDir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    expect(files).toContain("core.json");
  });

  it("uses a unique tmp name so concurrent writes don't collide", async () => {
    await writeFile(coreFile, JSON.stringify([], null, 2), "utf8");

    const mem = await import("@/lib/persona-memory");
    // Fire several writes at once; with a single fixed .tmp name these would
    // race on the same path. Unique pid+uuid names let them all land cleanly.
    await Promise.all([
      mem.addCore("concurrent fact A", "user"),
      mem.addCore("concurrent fact B", "user"),
      mem.addCore("concurrent fact C", "user"),
    ]);

    const raw = await readFile(coreFile, "utf8");
    const parsed = JSON.parse(raw); // must still be valid, untorn JSON
    expect(Array.isArray(parsed)).toBe(true);

    const files = await readdir(memDir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });
});
