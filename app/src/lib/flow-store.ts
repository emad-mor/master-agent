/* Durable persistence for the orchestrator registry.
 *
 * Ran tasks/flows live in an in-memory `globalThis` singleton, so they vanish
 * when the Node process restarts (stop+rerun the dev server). That made flows a
 * dead-end across restarts even though everything around them — memory,
 * sessions, agents, templates — persists to data/. This module snapshots the
 * SERIALIZABLE part of the registry (the Task/Flow records, not the live
 * ChildProcess / subscribers / promises) to data/flows/registry.json and
 * rehydrates it on startup.
 *
 * On reload, any task that was mid-flight (queued/running) is marked "stopped":
 * its claude subprocess died with the old process, so it can't be resumed — but
 * its finished siblings, their outputs, costs, and the flow structure all come
 * back fully readable, and a finished flow can still be handed to Aria.
 *
 * Writes are debounced so a burst of status changes coalesces into one fsync. */

import { mkdir, writeFile, rename } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STORE_DIR = join(process.cwd(), "data", "flows");
const STORE_FILE = join(STORE_DIR, "registry.json");

// Minimal structural shapes — kept loose so this module doesn't import the
// orchestrator's types (which would create a cycle). The orchestrator owns the
// real Task/Flow types and passes plain objects through here.
export type PersistedSnapshot = { tasks: unknown[]; flows: unknown[]; savedAt: number };

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pending: (() => PersistedSnapshot) | null = null;

/** Schedule a debounced snapshot. `collect` is called at flush time so it
 *  always serializes the LATEST registry state, not a stale capture. */
export function scheduleFlowSnapshot(collect: () => PersistedSnapshot) {
  pending = collect;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const c = pending; pending = null;
    if (c) void flush(c());
  }, 400);
}

async function flush(snap: PersistedSnapshot) {
  try {
    await mkdir(STORE_DIR, { recursive: true });
    // Atomic write: tmp + rename, so a crash mid-write can't corrupt the file.
    const tmp = STORE_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(snap), "utf8");
    await rename(tmp, STORE_FILE);
  } catch (e) {
    console.warn("[flow-store] snapshot write failed (non-fatal):", (e as Error).message);
  }
}

/** Read the last snapshot. SYNC on purpose: the orchestrator rehydrates its
 *  registry at module-init time, before any request reads it — an async load
 *  would let the first board fetch see an empty registry. Returns null if none.*/
export function loadFlowSnapshotSync(): PersistedSnapshot | null {
  try {
    if (!existsSync(STORE_FILE)) return null;
    const data = JSON.parse(readFileSync(STORE_FILE, "utf8")) as PersistedSnapshot;
    if (!data || !Array.isArray(data.tasks) || !Array.isArray(data.flows)) return null;
    return data;
  } catch (e) {
    console.warn("[flow-store] snapshot read failed:", (e as Error).message);
    return null;
  }
}
