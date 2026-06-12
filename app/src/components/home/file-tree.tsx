"use client";

// Per-project file structure as a DOCKED LEFT RAIL. Collapsed to a thin strip
// by default; expands on hover. A pin button makes it sticky (stays open) and
// signals the page to push content right (via onPinnedChange). Clicking a file
// attaches its path to the prompt.

import { useCallback, useEffect, useRef, useState } from "react";
import { Folder, FolderOpen, File as FileIcon, Loader2, RefreshCw, FolderTree, Pin, PinOff } from "lucide-react";
import { cx } from "@/lib/format";

type FileNode = { name: string; path: string; dir: boolean; children?: FileNode[] };

export function FileTreeRail({ project, projectName, onPick, onPinnedChange }: {
  project: string;
  projectName: string;
  onPick?: (relPath: string) => void;
  onPinnedChange?: (pinned: boolean) => void;
}) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const expanded = pinned || hovered;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/files?project=${encodeURIComponent(project)}`, { cache: "no-store" });
      if (r.ok) { const d = await r.json(); setTree(d.tree ?? []); setTruncated(!!d.truncated); setLoadedFor(project); }
    } finally { setLoading(false); }
  }, [project]);

  // Load lazily the first time it expands for a project, and on project change while open.
  useEffect(() => {
    if (expanded && loadedFor !== project) void load();
  }, [expanded, project, loadedFor, load]);

  useEffect(() => { onPinnedChange?.(pinned); }, [pinned, onPinnedChange]);

  const onEnter = () => { if (closeTimer.current) clearTimeout(closeTimer.current); setHovered(true); };
  const onLeave = () => { closeTimer.current = setTimeout(() => setHovered(false), 180); };

  return (
    <aside
      className={cx("frail", expanded && "frail--open", pinned && "frail--pinned")}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      aria-label="Project files"
    >
      {/* Collapsed strip — vertical project name, always visible */}
      <div className="frail__strip" aria-hidden={expanded}>
        <FolderTree size={16} className="frail__strip-icon" />
        <span className="frail__strip-label">{projectName}</span>
      </div>

      {/* Expanded panel */}
      <div className="frail__panel" aria-hidden={!expanded}>
        <div className="frail__head">
          <FolderTree size={14} style={{ color: "#c79bff" }} />
          <span className="frail__title">{projectName}</span>
          <span className="frail__proj">files</span>
          <span style={{ flex: 1 }} />
          <button className="frail__btn" onClick={() => void load()} title="Rescan">{loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}</button>
          <button className={cx("frail__btn", pinned && "frail__btn--on")} onClick={() => setPinned((p) => !p)} title={pinned ? "Unpin" : "Pin open"}>
            {pinned ? <PinOff size={13} /> : <Pin size={13} />}
          </button>
        </div>
        <div className="frail__body">
          {loading && tree.length === 0
            ? <div className="frail__empty"><Loader2 size={13} className="animate-spin" /> Scanning…</div>
            : tree.length === 0
              ? <div className="frail__empty">No files.</div>
              : tree.map((n) => <TreeNode key={n.path} node={n} depth={0} onPick={onPick} />)}
          {truncated && <div className="frail__trunc">…truncated (large project)</div>}
        </div>
      </div>
    </aside>
  );
}

function TreeNode({ node, depth, onPick }: { node: FileNode; depth: number; onPick?: (p: string) => void }) {
  const [open, setOpen] = useState(depth < 1);
  if (node.dir) {
    return (
      <div>
        <button className="frail__row frail__row--dir" style={{ paddingLeft: 8 + depth * 13 }} onClick={() => setOpen((o) => !o)}>
          {open ? <FolderOpen size={13} className="frail__icon frail__icon--dir" /> : <Folder size={13} className="frail__icon frail__icon--dir" />}
          <span className="frail__name">{node.name}</span>
        </button>
        {open && node.children?.map((c) => <TreeNode key={c.path} node={c} depth={depth + 1} onPick={onPick} />)}
      </div>
    );
  }
  return (
    <button
      className={cx("frail__row", onPick && "frail__row--pickable")}
      style={{ paddingLeft: 8 + depth * 13 }}
      onClick={() => onPick?.(node.path)}
      title={onPick ? `Attach ${node.path}` : node.path}
    >
      <FileIcon size={12} className="frail__icon" />
      <span className="frail__name">{node.name}</span>
    </button>
  );
}
