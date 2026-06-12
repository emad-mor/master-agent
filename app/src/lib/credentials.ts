/* Per-agent credentials (Phase 3).
 *
 * Each agent can carry integration tokens — Figma for Designer, Wiki for
 * Researcher, Git for Developer, etc. Tokens are SECRETS, so they live apart
 * from the agent record:
 *
 *   data/agents/<id>.creds.json   ← { envVar: token } map, chmod 600, gitignored
 *
 * Two hard rules enforced here:
 *   1. Raw tokens NEVER leave the server. The API only ever returns redacted
 *      metadata (which integrations exist + a masked preview), via `listRedacted`.
 *   2. Tokens reach the agent ONLY as process environment variables at spawn
 *      time (`envForAgent`) — never interpolated into the prompt, so they can't
 *      land in transcripts, memory, or the event log.
 *
 * Node-only. */

import { mkdir, readFile, writeFile, unlink, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "data", "agents");
const credsPath = (agentId: string) => join(ROOT, `${agentId}.creds.json`);

// On disk: { [envVar]: token }. We key by env var so the same integration name
// can't collide and so injection is a direct map.
type CredStore = Record<string, string>;

async function read(agentId: string): Promise<CredStore> {
  const p = credsPath(agentId);
  if (!existsSync(p)) return {};
  try { return JSON.parse(await readFile(p, "utf8")) as CredStore; } catch { return {}; }
}

async function write(agentId: string, store: CredStore) {
  await mkdir(ROOT, { recursive: true });
  const p = credsPath(agentId);
  await writeFile(p, JSON.stringify(store, null, 2), "utf8");
  try { await chmod(p, 0o600); } catch { /* best effort on platforms without it */ }
}

/** Mask a token for display: keep a hint of length, never reveal it. */
function mask(token: string): string {
  if (!token) return "";
  if (token.length <= 6) return "••••";
  return `${token.slice(0, 3)}••••${token.slice(-2)}`;
}

export type RedactedCred = { envVar: string; preview: string; set: boolean };

/** Safe for the API/UI: which env vars have a token, masked. No raw tokens. */
export async function listRedacted(agentId: string): Promise<RedactedCred[]> {
  const store = await read(agentId);
  return Object.entries(store).map(([envVar, token]) => ({ envVar, preview: mask(token), set: !!token }));
}

/** Set or clear one integration's token. Empty/undefined token removes it. */
export async function setCredential(agentId: string, envVar: string, token: string | undefined): Promise<void> {
  const key = envVar.trim();
  if (!key) return;
  const store = await read(agentId);
  if (token && token.trim()) store[key] = token.trim();
  else delete store[key];
  if (Object.keys(store).length === 0) {
    // No secrets left — remove the file entirely rather than leave an empty one.
    const p = credsPath(agentId);
    if (existsSync(p)) await unlink(p);
    return;
  }
  await write(agentId, store);
}

export async function deleteCredentials(agentId: string): Promise<void> {
  const p = credsPath(agentId);
  if (existsSync(p)) await unlink(p);
}

/** SERVER-ONLY: the real env vars to merge into a spawned agent's process.
 *  Never send this to the client. */
export async function envForAgent(agentId: string): Promise<Record<string, string>> {
  return await read(agentId);
}
