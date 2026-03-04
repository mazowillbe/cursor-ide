import { useState, useEffect } from "react";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";
import { listFiles, getGitStatus, getLints, deleteFile, type FileNode, type LintCounts } from "../api/client";
import FileIcon from "./FileIcon";

function normPath(p: string): string {
  return p.replace(/\\/g, "/").trim();
}

interface FileTreeProps {
  workspaceId: string;
  projectName?: string;
  selectedPath: string | null;
  onSelectFile: (path: string | null) => void;
  refreshTrigger?: number;
  onNewFile?: () => void;
  onNewFolder?: () => void;
  onRefresh?: () => void;
  onCollapse?: () => void;
}

export default function FileTree({
  workspaceId,
  projectName = "Project",
  selectedPath,
  onSelectFile,
  refreshTrigger = 0,
  onNewFile,
  onNewFolder,
  onRefresh,
  onCollapse,
}: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["."]));
  const [refreshKey, setRefreshKey] = useState(0);
  const [changedPaths, setChangedPaths] = useState<Set<string>>(new Set());
  const [lintsByPath, setLintsByPath] = useState<Record<string, LintCounts>>({});

  // Build set of folder paths that contain erroneous files (for red styling propagation)
  const foldersWithErrors = new Set<string>();
  for (const [p, c] of Object.entries(lintsByPath)) {
    if ((c.errors + c.warnings) <= 0) continue;
    const normalized = normPath(p);
    let dir = normalized.includes("/") ? normalized.replace(/\/[^/]+$/, "") : "";
    while (dir && dir.includes("/")) {
      foldersWithErrors.add(dir);
      dir = dir.replace(/\/[^/]+$/, "");
    }
    if (dir) foldersWithErrors.add(dir);
  }

  useEffect(() => {
    if (refreshTrigger > 0) setRefreshKey((k) => k + 1);
  }, [refreshTrigger]);

  useEffect(() => {
    getGitStatus(workspaceId)
      .then((s) => {
        if (!s.isRepo || !s.status) return;
        const paths = new Set<string>();
        for (const line of s.status) {
          const filePath = line.slice(2).trim();
          const path = filePath.includes(" -> ") ? filePath.split(" -> ")[1]?.trim() ?? filePath : filePath;
          if (path) paths.add(normPath(path));
        }
        setChangedPaths(paths);
      })
      .catch(() => setChangedPaths(new Set()));
  }, [workspaceId, refreshKey]);

  useEffect(() => {
    getLints(workspaceId)
      .then((r) => setLintsByPath(r.files ?? {}))
      .catch(() => setLintsByPath({}));
  }, [workspaceId, refreshKey]);

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="h-full flex flex-col bg-[#1A1A1A] border-r border-surface-500">
      <div className="flex-shrink-0 flex items-center gap-1 px-2 py-1.5 border-b border-surface-500">
        <button
          type="button"
          onClick={() => {
            setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(".")) next.delete(".");
              else next.add(".");
              return next;
            });
          }}
          className="flex-1 flex items-center gap-1.5 min-w-0 text-left text-sm font-medium text-gray-200 hover:bg-surface-600 rounded py-0.5 px-1"
        >
          <span className="w-4 flex-shrink-0 flex items-center justify-center text-gray-500">
            {expanded.has(".") ? <LuChevronDown className="w-4 h-4" /> : <LuChevronRight className="w-4 h-4" />}
          </span>
          <span className="truncate uppercase">{projectName}</span>
        </button>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            type="button"
            onClick={onNewFile}
            className="p-1 rounded text-gray-400 hover:bg-surface-600 hover:text-gray-200"
            title="New File"
          >
            <NewFileIcon />
          </button>
          <button
            type="button"
            onClick={onNewFolder}
            className="p-1 rounded text-gray-400 hover:bg-surface-600 hover:text-gray-200"
            title="New Folder"
          >
            <NewFolderIcon />
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className="p-1 rounded text-gray-400 hover:bg-surface-600 hover:text-gray-200"
            title="Refresh"
          >
            <RefreshIcon />
          </button>
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              className="p-1 rounded text-gray-400 hover:bg-surface-600 hover:text-gray-200"
              title="Collapse"
            >
              <CollapseIcon />
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {expanded.has(".") && (
          <TreeLevel
            workspaceId={workspaceId}
            dir="."
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
            expanded={expanded}
            onToggle={toggle}
            level={0}
            refreshKey={refreshKey}
            changedPaths={changedPaths}
            lintsByPath={lintsByPath}
            foldersWithErrors={foldersWithErrors}
            onRefresh={onRefresh}
          />
        )}
      </div>
    </div>
  );
}

interface TreeLevelProps {
  workspaceId: string;
  dir: string;
  selectedPath: string | null;
  onSelectFile: (path: string | null) => void;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  level: number;
  refreshKey?: number;
  changedPaths: Set<string>;
  lintsByPath: Record<string, LintCounts>;
  foldersWithErrors: Set<string>;
  onRefresh?: () => void;
}

function TreeLevel({
  workspaceId,
  dir,
  selectedPath,
  onSelectFile,
  expanded,
  onToggle,
  level,
  refreshKey = 0,
  changedPaths,
  lintsByPath,
  foldersWithErrors,
  onRefresh,
}: TreeLevelProps) {
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    listFiles(workspaceId, dir).then((list) => {
      if (!cancelled) {
        setNodes(list);
        setLoaded(true);
      }
    });
    return () => { cancelled = true; };
  }, [workspaceId, dir, refreshKey]);

  const children = nodes
    .filter((n) => n.kind === "directory")
    .filter((n) => !n.name.startsWith("."));
  const files = nodes.filter((n) => n.kind === "file");

  // Only show "Loading…" on initial load (no nodes yet). When refreshing, keep showing existing nodes to avoid flicker.
  const isInitialLoad = !loaded && nodes.length === 0;
  if (isInitialLoad) {
    return (
      <div className="text-gray-500 text-sm py-1" style={{ paddingLeft: 12 + level * 12 }}>
        {dir === "." ? "Loading…" : ""}
      </div>
    );
  }

  if (children.length === 0 && files.length === 0) {
    return (
      <div className="text-gray-500 text-xs py-1 italic" style={{ paddingLeft: 12 + level * 12 }}>
        {dir === "." ? "No files yet" : ""}
      </div>
    );
  }

  return (
    <div className="select-none" style={{ paddingLeft: 12 + level * 12 }}>
      {children.map((n) => (
        <div key={n.path}>
          <DirEntry
            workspaceId={workspaceId}
            node={n}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
            expanded={expanded}
            onToggle={onToggle}
            level={level}
            refreshKey={refreshKey}
            changedPaths={changedPaths}
            lintsByPath={lintsByPath}
            foldersWithErrors={foldersWithErrors}
            onRefresh={onRefresh}
          />
        </div>
      ))}
      {files.map((n) => (
        <FileEntry
          key={n.path}
          node={n}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
          changedPaths={changedPaths}
          lintsByPath={lintsByPath}
          workspaceId={workspaceId}
          onRefresh={onRefresh}
        />
      ))}
    </div>
  );
}

function DirEntry({
  workspaceId,
  node,
  selectedPath,
  onSelectFile,
  expanded,
  onToggle,
  level,
  refreshKey,
  changedPaths,
  lintsByPath,
  foldersWithErrors,
  onRefresh,
}: {
  workspaceId: string;
  node: FileNode;
  selectedPath: string | null;
  onSelectFile: (path: string | null) => void;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  level: number;
  refreshKey?: number;
  changedPaths: Set<string>;
  lintsByPath: Record<string, LintCounts>;
  foldersWithErrors: Set<string>;
  onRefresh?: () => void;
}) {
  const isExpanded = expanded.has(node.path);
  const nodePathNorm = normPath(node.path);
  const changedInFolder = [...changedPaths].filter(
    (p) => normPath(p) === nodePathNorm || normPath(p).startsWith(nodePathNorm + "/")
  );
  const hasChanges = changedInFolder.length > 0;
  const changeCount = changedInFolder.length;
  // Check both precomputed set and direct match (handles path format mismatches between lints API and file tree)
  const hasErrors =
    foldersWithErrors.has(nodePathNorm) ||
    Object.entries(lintsByPath).some(([p, c]) => {
      if ((c.errors + c.warnings) <= 0) return false;
      const lp = normPath(p);
      return lp === nodePathNorm || lp.startsWith(nodePathNorm + "/");
    });
  const showIndicator = hasChanges || hasErrors;
  const folderColor = hasErrors ? "text-red-400" : hasChanges ? "text-orange-400" : "text-gray-400";
  const dotColor = hasErrors ? "bg-red-500" : "bg-orange-500";
  const dotTitle = hasErrors ? "Contains errors" : changeCount > 0 ? `${changeCount} modified` : "Modified";
  return (
    <>
      <button
        type="button"
        onClick={() => onToggle(node.path)}
        className={`w-full flex items-center gap-1 py-0.5 px-1 rounded text-left text-sm hover:bg-surface-600 hover:text-gray-200 min-w-0 ${folderColor}`}
      >
        <span className="w-4 flex items-center justify-center shrink-0 text-gray-500">
          {isExpanded ? <LuChevronDown className="w-4 h-4" /> : <LuChevronRight className="w-4 h-4" />}
        </span>
        <span className="truncate flex-1 min-w-0">{node.name}</span>
        {showIndicator && (
          <span className="flex items-center gap-1 shrink-0 ml-auto">
            {hasChanges && changeCount > 0 && (
              <span className="text-xs text-orange-400" title={`${changeCount} modified file(s)`}>
                {changeCount}
              </span>
            )}
            <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} title={dotTitle} />
          </span>
        )}
      </button>
      {isExpanded && (
        <TreeLevel
          workspaceId={workspaceId}
          dir={node.path}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
          expanded={expanded}
          onToggle={onToggle}
          level={level}
          refreshKey={refreshKey}
          changedPaths={changedPaths}
          lintsByPath={lintsByPath}
          foldersWithErrors={foldersWithErrors}
          onRefresh={onRefresh}
        />
      )}
    </>
  );
}

function FileEntry({
  node,
  selectedPath,
  onSelectFile,
  changedPaths,
  lintsByPath,
  workspaceId,
  onRefresh,
}: {
  node: FileNode;
  selectedPath: string | null;
  onSelectFile: (path: string | null) => void;
  changedPaths: Set<string>;
  lintsByPath: Record<string, LintCounts>;
  workspaceId: string;
  onRefresh?: () => void;
}) {
  const isSelected = selectedPath === node.path;
  const isChanged = changedPaths.has(normPath(node.path));
  const key = normPath(node.path);
  const counts = lintsByPath[key] ?? (() => {
    const shortKey = key.split("/").slice(-2).join("/");
    return Object.entries(lintsByPath).find(([k]) => {
      const nk = normPath(k);
      return nk === key || nk === shortKey || key.endsWith("/" + nk);
    })?.[1];
  })();
  const errorCount = counts?.errors ?? 0;
  const warnCount = counts?.warnings ?? 0;
  const totalCount = errorCount + warnCount;

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Delete ${node.name}?`)) return;
    try {
      await deleteFile(workspaceId, node.path);
      onRefresh?.();
    } catch (err) {
      console.error("[FileTree] Delete failed:", err);
    }
  };

  return (
    <div
      className={`group flex items-center gap-1.5 py-0.5 px-1 rounded text-left text-sm min-w-0 hover:bg-surface-600 ${
        isSelected ? "bg-accent/20" : ""
      }`}
    >
      <button
        type="button"
        onClick={() => onSelectFile(node.path)}
        className={`flex-1 flex items-center gap-1.5 min-w-0 text-left ${
          isSelected ? "text-accent" : isChanged ? "text-orange-400" : totalCount > 0 ? "text-red-400" : "text-gray-400 hover:text-gray-200"
        }`}
      >
        <FileIcon path={node.path} size={16} className="shrink-0" />
        <span className="truncate flex-1 min-w-0">{node.name}</span>
        {totalCount > 0 && (
          <span className="shrink-0 text-xs text-red-400 ml-auto" title={`${errorCount} error(s), ${warnCount} warning(s)`}>
            {totalCount}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={handleDelete}
        className="p-0.5 rounded opacity-0 group-hover:opacity-70 hover:opacity-100 hover:bg-surface-500 text-gray-400 hover:text-red-400 shrink-0"
        title="Delete file"
        aria-label="Delete file"
      >
        <BinIcon />
      </button>
    </div>
  );
}

function BinIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  );
}

function NewFileIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );
}

function NewFolderIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 11v6m-3-3h6" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}
