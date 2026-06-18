"use client";

// Connected repositories as a DOCKED RIGHT RAIL — mirror of the left file rail.
// Collapsed to a thin strip; expands on hover; a pin keeps it open and pushes
// content left. Lists Daryan's own source + every workspace project with its
// live git state (branch, last commit, dirty count, ahead/behind), plus
// friendly "git for humans" buttons: each drops a ready-to-send prompt into the
// chat so Daryan does the actual git work (and you can review it first).

import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, Loader2, RefreshCw, Pin, PinOff, AlertCircle, GitCommitVertical, ArrowDownToLine, ArrowUpToLine, FileDiff } from "lucide-react";
import { cx } from "@/lib/format";

type RepoState = {
  slug: string; name: string; path: string; isGit: boolean;
  branch?: string; commit?: { hash: string; subject: string; relative: string };
  dirty?: number; ahead?: number; behind?: number; hasUpstream?: boolean; error?: string;
};

// Plain-English prompts the buttons drop into the composer. Each names the repo
// AND its path so Daryan acts on the right one regardless of the active project.
function prompts(name: string, path: string) {
  const it = `the "${name}" repo (${path})`;
  return {
    save:    `Commit my changes in ${it}: stage everything and write a clear, descriptive commit message.`,
    update:  `Update ${it}: pull the latest changes from its remote, then tell me in plain English what changed.`,
    upload:  `Push ${it} to its remote on GitHub. If it has no remote set up yet, tell me what's needed.`,
    changes: `In plain English, summarize what has changed in ${it} since its last commit.`,
    init:    `Set up version control for the "${name}" folder (${path}): initialize a git repository and make an initial commit of everything in it.`,
  };
}

export function ReposRail({ refreshKey, onPinnedChange, onPrompt }: {
  refreshKey?: number;                       // bump to force a re-read (e.g. project changed)
  onPinnedChange?: (pinned: boolean) => void;
  onPrompt?: (text: string) => void;         // drop a ready-to-send prompt into the chat composer
}) {
  const [repos, setRepos] = useState<RepoState[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const expanded = pinned || hovered;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/repos", { cache: "no-store" });
      if (r.ok) { setRepos((await r.json()).repos ?? []); setLoadedOnce(true); }
    } catch { /* leave previous state */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (expanded && !loadedOnce) void load(); }, [expanded, loadedOnce, load]);
  useEffect(() => { if (expanded && loadedOnce) void load(); /* eslint-disable-line */ }, [refreshKey]);
  useEffect(() => { onPinnedChange?.(pinned); }, [pinned, onPinnedChange]);

  const onEnter = () => { if (closeTimer.current) clearTimeout(closeTimer.current); setHovered(true); };
  const onLeave = () => { closeTimer.current = setTimeout(() => setHovered(false), 180); };

  return (
    <aside
      className={cx("rrail", expanded && "rrail--open", pinned && "rrail--pinned")}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      aria-label="Connected repositories"
    >
      {/* Collapsed strip — vertical "Repos" label */}
      <div className="rrail__strip" aria-hidden={expanded}>
        <GitBranch size={16} className="rrail__strip-icon" />
        <span className="rrail__strip-label">Repos</span>
      </div>

      {/* Expanded panel */}
      <div className="rrail__panel" aria-hidden={!expanded}>
        <div className="rrail__head">
          <GitBranch size={14} style={{ color: "#c79bff" }} />
          <span className="rrail__title">Repositories</span>
          <span className="rrail__count">{repos.length}</span>
          <span style={{ flex: 1 }} />
          <button className="rrail__btn" onClick={() => void load()} title="Refresh git state" aria-label="Refresh git state">
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
          <button className={cx("rrail__btn", pinned && "rrail__btn--on")} onClick={() => setPinned((p) => !p)} title={pinned ? "Unpin" : "Pin open"} aria-label={pinned ? "Unpin panel" : "Pin panel open"}>
            {pinned ? <PinOff size={13} /> : <Pin size={13} />}
          </button>
        </div>

        <div className="rrail__body">
          {loading && repos.length === 0
            ? <div className="rrail__empty"><Loader2 size={13} className="animate-spin" /> Reading git state…</div>
            : repos.length === 0
              ? <div className="rrail__empty">No repositories found.</div>
              : repos.map((r) => <RepoRow key={r.slug} repo={r} onPrompt={onPrompt} />)}
        </div>
      </div>
    </aside>
  );
}

function RepoRow({ repo, onPrompt }: { repo: RepoState; onPrompt?: (text: string) => void }) {
  const synced = repo.hasUpstream && !repo.ahead && !repo.behind;
  const p = prompts(repo.name, repo.path);

  return (
    <div className="rrail__repo" title={repo.path}>
      <div className="rrail__repo-top">
        <span className="rrail__repo-name">{repo.name}</span>
        {repo.isGit && repo.branch && (
          <span className="rrail__branch"><GitBranch size={9} /> {repo.branch}</span>
        )}
        {repo.dirty ? <span className="rrail__dirty" title={`${repo.dirty} uncommitted change(s)`}>● {repo.dirty}</span> : null}
      </div>

      {repo.error ? (
        <div className="rrail__repo-meta rrail__repo-meta--err"><AlertCircle size={10} /> {repo.error}</div>
      ) : !repo.isGit ? (
        <div className="rrail__repo-meta rrail__repo-meta--dim">not tracked by git</div>
      ) : repo.commit ? (
        <div className="rrail__repo-meta"><span className="rrail__hash">{repo.commit.hash}</span> {repo.commit.subject}</div>
      ) : (
        <div className="rrail__repo-meta rrail__repo-meta--dim">no commits yet</div>
      )}

      {repo.isGit && (repo.commit || repo.hasUpstream) && (
        <div className="rrail__repo-foot">
          {repo.commit && <span>{repo.commit.relative}</span>}
          {repo.hasUpstream && (
            synced
              ? <span className="rrail__sync rrail__sync--ok">up to date</span>
              : <span className="rrail__sync">{repo.ahead ? `↑${repo.ahead}` : ""}{repo.ahead && repo.behind ? " " : ""}{repo.behind ? `↓${repo.behind}` : ""}</span>
          )}
        </div>
      )}

      {/* Git for humans — buttons drop a prompt into the chat; Daryan does it. */}
      {onPrompt && (
        repo.isGit ? (
          <div className="rrail__ops">
            <button className="rrail__op" onClick={() => onPrompt(p.save)} title="git commit — stage all your changes and commit them (a clear message is written for you)">
              <GitCommitVertical size={11} /> Commit
            </button>
            <button className="rrail__op" onClick={() => onPrompt(p.update)} title="git pull — fetch &amp; merge the latest from the remote">
              <ArrowDownToLine size={11} /> Pull
            </button>
            <button className="rrail__op" onClick={() => onPrompt(p.upload)} title="git push — upload your commits to the remote (GitHub)">
              <ArrowUpToLine size={11} /> Push
            </button>
            <button className="rrail__op" onClick={() => onPrompt(p.changes)} title="git diff / status — what's changed since the last commit">
              <FileDiff size={11} /> Diff
            </button>
          </div>
        ) : (
          <div className="rrail__ops">
            <button className="rrail__op rrail__op--wide" onClick={() => onPrompt(p.init)} title="git init — start tracking this folder with git and make the first commit">
              <GitBranch size={11} /> Init
            </button>
          </div>
        )
      )}
    </div>
  );
}
