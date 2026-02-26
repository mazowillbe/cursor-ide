import { useState, useEffect } from "react";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";
import { listFiles, type FileNode } from "../api/client";
import FileIcon from "./FileIcon";

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

  useEffect(() => {
    if (refreshTrigger > 0) setRefreshKey((k) => k + 1);
  }, [refreshTrigger]);

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
            key={refreshKey}
            workspaceId={workspaceId}
            dir="."
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
            expanded={expanded}
            onToggle={toggle}
            level={0}
            refreshKey={refreshKey}
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

  if (!loaded) {
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
          />
        </div>
      ))}
      {files.map((n) => (
        <FileEntry
          key={n.path}
          node={n}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
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
}: {
  workspaceId: string;
  node: FileNode;
  selectedPath: string | null;
  onSelectFile: (path: string | null) => void;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  level: number;
  refreshKey?: number;
}) {
  const isExpanded = expanded.has(node.path);
  return (
    <>
      <button
        type="button"
        onClick={() => onToggle(node.path)}
        className="w-full flex items-center gap-1 py-0.5 px-1 rounded text-left text-sm text-gray-400 hover:bg-surface-600 hover:text-gray-200"
      >
        <span className="w-4 flex items-center justify-center shrink-0 text-gray-500">
          {isExpanded ? <LuChevronDown className="w-4 h-4" /> : <LuChevronRight className="w-4 h-4" />}
        </span>
        <span className="truncate">{node.name}</span>
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
        />
      )}
    </>
  );
}

function FileEntry({
  node,
  selectedPath,
  onSelectFile,
}: {
  node: FileNode;
  selectedPath: string | null;
  onSelectFile: (path: string | null) => void;
}) {
  const isSelected = selectedPath === node.path;
  return (
    <button
      type="button"
      onClick={() => onSelectFile(node.path)}
      className={`w-full flex items-center gap-1.5 py-0.5 px-1 rounded text-left text-sm truncate ${
        isSelected
          ? "bg-accent/20 text-accent"
          : "text-gray-400 hover:bg-surface-600 hover:text-gray-200"
      }`}
    >
      <FileIcon path={node.path} size={16} className="shrink-0" />
      <span className="truncate">{node.name}</span>
    </button>
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
