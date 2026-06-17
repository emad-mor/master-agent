/* The workspace resolver — the heart of Aria's multi-project access.
 *
 * Aria works across every folder you drop into ../workspace (relative to this
 * app). Each top-level folder there is a "project". The active project decides
 *   - which directory `claude -p` runs in (its cwd), and
 *   - which per-project memory bucket we read/write.
 * In every case Claude is also granted --add-dir <workspace root>, so even when
 * focused on one project it can reach across to siblings when you ask.
 *
 * Override the workspace location with the WORKSPACE_DIR env var (absolute
 * path). Default: the `workspace/` folder next to this app. */

import { readdir, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

export const WORKSPACE_DIR = process.env.WORKSPACE_DIR
  ? resolve(process.env.WORKSPACE_DIR)
  : resolve(process.cwd(), "..", "workspace");

// Pseudo-project key meaning "the whole workspace" — cwd at the workspace root,
// its own shared memory bucket. Selected when no specific project is active.
export const WORKSPACE_KEY = "__workspace__";

// Pseudo-project meaning "Daryan's OWN source code" — cwd at the repo root (the
// folder containing this app/), so the agent can read and edit the Daryan
// system itself. process.cwd() is the app/ dir (where `npm run dev` runs).
export const SELF_KEY = "__self__";
export const SELF_DIR = resolve(process.cwd(), "..");

// Folder names that are never treated as projects.
const IGNORE = new Set([".git", "node_modules", ".next", "dist", "out", ".vscode", ".idea", ".cache"]);

export type Project = { slug: string; name: string; path: string };

/** Stable, filesystem-safe slug for a folder name (used as the memory key). */
export function slugify(name: string): string {
  return (
    name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "project"
  );
}

/** Every top-level folder in the workspace, alphabetical. */
export async function listProjects(): Promise<Project[]> {
  if (!existsSync(WORKSPACE_DIR)) return [];
  const entries = await readdir(WORKSPACE_DIR, { withFileTypes: true });
  const projects: Project[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".") || IGNORE.has(e.name)) continue;
    projects.push({ slug: slugify(e.name), name: e.name, path: join(WORKSPACE_DIR, e.name) });
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a project slug to its cwd + memory key. Unknown / empty slugs fall
 *  back to the whole-workspace bucket (never traverses outside the workspace). */
export async function resolveProject(
  slug: string | undefined | null,
): Promise<{ cwd: string; key: string; name: string }> {
  if (!slug || slug === WORKSPACE_KEY) {
    return { cwd: WORKSPACE_DIR, key: WORKSPACE_KEY, name: "All projects" };
  }
  if (slug === SELF_KEY) {
    return { cwd: SELF_DIR, key: SELF_KEY, name: "Daryan source" };
  }
  const found = (await listProjects()).find((p) => p.slug === slug);
  if (found) return { cwd: found.path, key: found.slug, name: found.name };
  return { cwd: WORKSPACE_DIR, key: WORKSPACE_KEY, name: "All projects" };
}

// ── File tree (per project) ──

export type FileNode = { name: string; path: string; dir: boolean; children?: FileNode[] };

const TREE_IGNORE = new Set([".git", "node_modules", ".next", "dist", "out", ".cache", ".turbo", ".vercel", "coverage", ".DS_Store"]);

/** A bounded file tree for a project (or whole workspace). Skips heavy/ignored
 *  dirs, caps depth and breadth so a giant repo can't hang the UI. Paths are
 *  RELATIVE to the project root. */
export async function fileTree(slug: string | undefined | null, opts?: { maxDepth?: number; maxEntries?: number }): Promise<{ root: string; tree: FileNode[]; truncated: boolean }> {
  const { cwd } = await resolveProject(slug);
  const maxDepth = opts?.maxDepth ?? 4;
  const maxEntries = opts?.maxEntries ?? 800;
  let count = 0;
  let truncated = false;

  async function walk(absDir: string, relDir: string, depth: number): Promise<FileNode[]> {
    if (depth > maxDepth || count >= maxEntries) { if (count >= maxEntries) truncated = true; return []; }
    let entries;
    try { entries = await readdir(absDir, { withFileTypes: true }); } catch { return []; }
    // dirs first, then files, alphabetical
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    const nodes: FileNode[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== DROPS_DIR) continue;   // hide dotfiles (except our drops)
      if (TREE_IGNORE.has(e.name)) continue;
      if (count >= maxEntries) { truncated = true; break; }
      count++;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        nodes.push({ name: e.name, path: rel, dir: true, children: await walk(join(absDir, e.name), rel, depth + 1) });
      } else {
        nodes.push({ name: e.name, path: rel, dir: false });
      }
    }
    return nodes;
  }

  const tree = await walk(cwd, "", 0);
  return { root: cwd, tree, truncated };
}

// ── File content (preview) ──

export type FileContent = {
  path: string;        // the relative path requested
  content: string;     // UTF-8 text (empty if binary)
  size: number;        // bytes on disk
  truncated: boolean;  // true if we clipped a large file
  binary: boolean;     // true if it looks like a binary blob (content withheld)
  tooLarge: boolean;   // true if the file exceeds the hard read ceiling
};

const PREVIEW_MAX_BYTES = 512 * 1024;   // 512 KB hard ceiling — never read more than this
const PREVIEW_TEXT_BUDGET = 200 * 1024; // clip the returned text to ~200 KB so the modal stays snappy

/** Read a single project-relative file for preview. Resolves the path INSIDE the
 *  project root and refuses anything that escapes it (path traversal / absolute
 *  paths / symlinks pointing out). Caps size and detects binary so the UI never
 *  tries to render a giant blob. */
export async function readProjectFile(
  slug: string | undefined | null,
  relPath: string,
): Promise<FileContent | { error: string }> {
  const { cwd } = await resolveProject(slug);
  if (!relPath || isAbsolute(relPath)) return { error: "Invalid path" };

  const abs = resolve(cwd, relPath);
  const within = relative(cwd, abs);
  // Escapes the root if the relative path climbs out (starts with "..") or is absolute.
  if (within.startsWith("..") || isAbsolute(within)) return { error: "Path is outside the project" };

  let st;
  try { st = await stat(abs); } catch { return { error: "File not found" }; }
  if (st.isDirectory()) return { error: "Path is a directory" };

  const size = st.size;
  if (size > PREVIEW_MAX_BYTES) {
    return { path: relPath, content: "", size, truncated: true, binary: false, tooLarge: true };
  }

  const buf = await readFile(abs);
  // Binary sniff: a NUL byte in the first 8 KB is a reliable "not text" signal.
  const sniff = buf.subarray(0, Math.min(buf.length, 8192));
  const binary = sniff.includes(0);
  if (binary) {
    return { path: relPath, content: "", size, truncated: false, binary: true, tooLarge: false };
  }

  let content = buf.toString("utf8");
  let truncated = false;
  if (content.length > PREVIEW_TEXT_BUDGET) {
    content = content.slice(0, PREVIEW_TEXT_BUDGET);
    truncated = true;
  }
  return { path: relPath, content, size, truncated, binary: false, tooLarge: false };
}

/** Resolve a project-relative path to a SAFE absolute path (same traversal
 *  guards as readProjectFile) for serving the raw bytes — e.g. opening an
 *  image/audio/video/html file directly in a browser tab. Returns the absolute
 *  path + size, or an error. Does NOT read the file. */
export async function resolveProjectFilePath(
  slug: string | undefined | null,
  relPath: string,
): Promise<{ abs: string; size: number } | { error: string }> {
  const { cwd } = await resolveProject(slug);
  if (!relPath || isAbsolute(relPath)) return { error: "Invalid path" };
  const abs = resolve(cwd, relPath);
  const within = relative(cwd, abs);
  if (within.startsWith("..") || isAbsolute(within)) return { error: "Path is outside the project" };
  let st;
  try { st = await stat(abs); } catch { return { error: "File not found" }; }
  if (st.isDirectory()) return { error: "Path is a directory" };
  return { abs, size: st.size };
}

// ── Dropped-file storage ──

const DROPS_DIR = ".daryan-drops";   // gitignorable folder inside a project

/** Save dropped files into <project>/.daryan-drops/ and return their relative
 *  paths (for referencing in a prompt). Filenames are sanitized + uuid-prefixed
 *  to avoid collisions and path traversal. */
export async function saveDrops(slug: string | undefined | null, files: { name: string; data: Buffer }[]): Promise<{ relPath: string; name: string }[]> {
  const { cwd } = await resolveProject(slug);
  const dir = join(cwd, DROPS_DIR);
  await mkdir(dir, { recursive: true });
  const out: { relPath: string; name: string }[] = [];
  for (const f of files) {
    const safe = f.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80) || "file";
    const fname = `${randomUUID().slice(0, 8)}-${safe}`;
    await writeFile(join(dir, fname), f.data);
    out.push({ relPath: `${DROPS_DIR}/${fname}`, name: f.name });
  }
  return out;
}
