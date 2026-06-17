import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { listProjects, SELF_DIR, SELF_KEY } from "@/lib/workspace";

/* Git state for every "connected repo" — Daryan's own source (__self__) plus
 * each workspace project folder. Read-only: a handful of fast `git -C` calls
 * per repo, each guarded so a non-git folder or a missing upstream degrades
 * gracefully instead of failing the whole list. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const exec = promisify(execFile);

export type RepoState = {
  slug: string;
  name: string;
  path: string;
  isGit: boolean;
  branch?: string;
  commit?: { hash: string; subject: string; relative: string };
  dirty?: number;          // count of uncommitted changes
  ahead?: number;          // commits ahead of upstream
  behind?: number;         // commits behind upstream
  hasUpstream?: boolean;
  error?: string;
};

const US = "\u001f"; // unit separator — safe field delimiter for commit subjects

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { timeout: 4000, maxBuffer: 1 << 20 });
  return stdout.trim();
}

async function repoState(slug: string, name: string, path: string): Promise<RepoState> {
  if (!existsSync(path)) return { slug, name, path, isGit: false, error: "folder missing" };
  // Confirm it's a work tree (handles plain .git dirs, worktrees and submodules).
  try { await git(path, ["rev-parse", "--is-inside-work-tree"]); }
  catch { return { slug, name, path, isGit: false }; }
  // …and that it's its OWN repo, not a folder sitting inside a parent repo
  // (the workspace lives inside the master-agent checkout, so a project with no
  // .git of its own would otherwise report the master-agent repo's state).
  try {
    const [top, real] = await Promise.all([
      git(path, ["rev-parse", "--show-toplevel"]),
      realpath(path).catch(() => path),
    ]);
    const topReal = await realpath(top).catch(() => top);
    if (topReal !== real) return { slug, name, path, isGit: false };
  } catch { return { slug, name, path, isGit: false }; }

  try {
    const [branch, commitRaw, status] = await Promise.all([
      git(path, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
      git(path, ["log", "-1", `--format=%h${US}%s${US}%cr`]).catch(() => ""),
      git(path, ["status", "--porcelain"]).catch(() => ""),
    ]);

    let ahead: number | undefined, behind: number | undefined, hasUpstream = false;
    try {
      const lr = await git(path, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
      const [b, a] = lr.split(/\s+/).map((n) => parseInt(n, 10));
      if (!isNaN(b) && !isNaN(a)) { behind = b; ahead = a; hasUpstream = true; }
    } catch { /* no upstream configured — fine */ }

    const [hash, subject, relative] = commitRaw ? commitRaw.split(US) : ["", "", ""];
    const dirty = status ? status.split("\n").filter(Boolean).length : 0;
    return {
      slug, name, path, isGit: true,
      branch: branch || "(detached)",
      commit: hash ? { hash, subject, relative } : undefined,
      dirty, ahead, behind, hasUpstream,
    };
  } catch (e) {
    return { slug, name, path, isGit: true, error: e instanceof Error ? e.message : "git error" };
  }
}

export async function GET() {
  const projects = await listProjects();
  const targets = [
    { slug: SELF_KEY, name: "Daryan source", path: SELF_DIR },
    ...projects.map((p) => ({ slug: p.slug, name: p.name, path: p.path })),
  ];
  const repos = await Promise.all(targets.map((t) => repoState(t.slug, t.name, t.path)));
  return NextResponse.json({ repos, ts: Date.now() });
}
