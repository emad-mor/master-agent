"use client";

// Per-project file structure as a DOCKED LEFT RAIL. Collapsed to a thin strip
// by default; expands on hover. A pin button makes it sticky (stays open) and
// signals the page to push content right (via onPinnedChange). Clicking a file
// attaches its path to the prompt; an eye button previews its content in a modal.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Folder, FolderOpen, File as FileIcon, Loader2, RefreshCw, FolderTree, Pin, PinOff, Eye, ExternalLink, X, Copy, Check } from "lucide-react";
import { cx } from "@/lib/format";

type FileNode = { name: string; path: string; dir: boolean; children?: FileNode[] };

// Files the browser can render natively → the view button opens them in a new
// tab (image/audio/video/html/pdf). Everything else gets the text-preview modal.
const OPEN_IN_TAB = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp", ".ico",
  ".mp3", ".wav", ".ogg", ".oga", ".m4a", ".flac", ".aac", ".opus",
  ".mp4", ".m4v", ".webm", ".mov", ".mkv", ".ogv",
  ".html", ".htm", ".pdf",
]);
const opensInTab = (name: string) => OPEN_IN_TAB.has(name.slice(name.lastIndexOf(".")).toLowerCase());

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
  const [preview, setPreview] = useState<string | null>(null);   // relative path being previewed
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const expanded = pinned || hovered;

  // View a file: media (image/audio/video/html/pdf) opens in a new tab so the
  // browser renders it; everything else opens the in-rail text preview.
  const view = useCallback((path: string, name: string) => {
    if (opensInTab(name)) {
      window.open(`/api/files/raw?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`, "_blank", "noopener,noreferrer");
    } else {
      setPreview(path);
    }
  }, [project]);

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
              : tree.map((n) => <TreeNode key={n.path} node={n} depth={0} onPick={onPick} onView={view} />)}
          {truncated && <div className="frail__trunc">…truncated (large project)</div>}
        </div>
      </div>

      {preview && (
        <FilePreview project={project} projectName={projectName} path={preview} onClose={() => setPreview(null)} onPick={onPick} />
      )}
    </aside>
  );
}

function TreeNode({ node, depth, onPick, onView }: { node: FileNode; depth: number; onPick?: (p: string) => void; onView: (path: string, name: string) => void }) {
  const [open, setOpen] = useState(depth < 1);
  if (node.dir) {
    return (
      <div>
        <button className="frail__row frail__row--dir" style={{ paddingLeft: 8 + depth * 13 }} onClick={() => setOpen((o) => !o)}>
          {open ? <FolderOpen size={13} className="frail__icon frail__icon--dir" /> : <Folder size={13} className="frail__icon frail__icon--dir" />}
          <span className="frail__name">{node.name}</span>
        </button>
        {open && node.children?.map((c) => <TreeNode key={c.path} node={c} depth={depth + 1} onPick={onPick} onView={onView} />)}
      </div>
    );
  }
  // Row click attaches (when onPick is wired), else views. The view button opens
  // media (image/audio/video/html/pdf) in a new tab, other files in the preview.
  const inTab = opensInTab(node.name);
  const viewLabel = inTab ? `Open ${node.name} in a new tab` : `Preview ${node.name}`;
  return (
    <div className="frail__filerow" style={{ paddingLeft: 8 + depth * 13 }}>
      <button
        className={cx("frail__row frail__row--file", onPick && "frail__row--pickable")}
        onClick={() => (onPick ? onPick(node.path) : onView(node.path, node.name))}
        title={onPick ? `Attach ${node.path}` : viewLabel}
      >
        <FileIcon size={12} className="frail__icon" />
        <span className="frail__name">{node.name}</span>
      </button>
      <button className="frail__peek" onClick={() => onView(node.path, node.name)} title={viewLabel} aria-label={viewLabel}>
        {inTab ? <ExternalLink size={12} /> : <Eye size={12} />}
      </button>
    </div>
  );
}

type FileContent = { path: string; content: string; size: number; truncated: boolean; binary: boolean; tooLarge: boolean };

function FilePreview({ project, projectName, path, onClose, onPick }: {
  project: string;
  projectName: string;
  path: string;
  onClose: () => void;
  onPick?: (relPath: string) => void;
}) {
  const [data, setData] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null); setData(null);
    (async () => {
      try {
        const r = await fetch(`/api/files/content?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`, { cache: "no-store" });
        const d = await r.json();
        if (!alive) return;
        if (!r.ok || d.error) setError(d.error ?? "Could not read file");
        else setData(d as FileContent);
      } catch {
        if (alive) setError("Could not read file");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [project, path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = async () => {
    if (!data?.content) return;
    try { await navigator.clipboard.writeText(data.content); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch {}
  };

  const name = path.split("/").pop() ?? path;
  const lang = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";

  if (!mounted) return null;

  return createPortal(
    <div className="fprev" role="dialog" aria-label={`Preview ${name}`} onClick={onClose}>
      <div className="fprev__sheet" onClick={(e) => e.stopPropagation()}>
        <div className="fprev__head">
          <FileIcon size={14} style={{ color: "#c79bff", flexShrink: 0 }} />
          <div className="fprev__titles">
            <div className="fprev__name">{name}{lang && <span className="fprev__lang">{lang}</span>}</div>
            <div className="fprev__path" title={`${projectName} / ${path}`}>{path}</div>
          </div>
          <span style={{ flex: 1 }} />
          {data && !data.binary && !data.tooLarge && data.content && (
            <button className="fprev__btn" onClick={() => void copy()} title="Copy content">
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          )}
          {onPick && (
            <button className="fprev__btn" onClick={() => { onPick(path); onClose(); }} title="Attach to prompt">Attach</button>
          )}
          <button className="fprev__btn" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </div>

        <div className="fprev__meta">
          {data && <span>{formatBytes(data.size)}</span>}
          {data?.truncated && <span className="fprev__warn">clipped — large file</span>}
        </div>

        <div className="fprev__body">
          {loading ? (
            <div className="fprev__state"><Loader2 size={15} className="animate-spin" /> Reading…</div>
          ) : error ? (
            <div className="fprev__state fprev__state--err">{error}</div>
          ) : data?.tooLarge ? (
            <div className="fprev__state">File is too large to preview ({formatBytes(data.size)}). Attach it to a prompt to have an agent read it.</div>
          ) : data?.binary ? (
            <div className="fprev__state">Binary file — no text preview ({formatBytes(data.size)}).</div>
          ) : (
            <pre className="fprev__code">{data?.content || <span className="fprev__state">Empty file.</span>}</pre>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
