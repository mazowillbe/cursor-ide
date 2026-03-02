import { useState, useEffect, useCallback } from "react";
import { getGitStatus } from "../api/client";

export interface StatusBarEditorInfo {
  line: number;
  column: number;
  errors: number;
  warnings: number;
  language: string;
  indentSize: number;
  insertSpaces: boolean;
}

interface StatusBarProps {
  workspaceId: string;
  projectName: string;
  activeFilePath: string | null;
  editorInfo: StatusBarEditorInfo | null;
  refreshTrigger?: number;
  onSyncClick?: () => void;
}

function GitStatusItem({
  workspaceId,
  refreshTrigger,
  onSyncClick,
}: {
  workspaceId: string;
  refreshTrigger?: number;
  onSyncClick?: () => void;
}) {
  const [git, setGit] = useState<{ branch: string | null; hasChanges: boolean } | null>(null);

  const load = useCallback(() => {
    getGitStatus(workspaceId)
      .then((s) => setGit({ branch: s.branch || "main", hasChanges: s.status.length > 0 }))
      .catch(() => setGit(null));
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load, refreshTrigger]);

  if (!git) return null;

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-gray-500" aria-hidden>
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4M21 12v4a2 2 0 01-2 2h-4M17 16l4-4m0 0l-4-4m4 4H3" />
        </svg>
      </span>
      <span className="text-xs text-gray-400">{git.branch}{git.hasChanges ? "*" : ""}</span>
      <button
        type="button"
        onClick={() => {
          load();
          onSyncClick?.();
        }}
        className="p-0.5 rounded hover:bg-white/10 text-gray-500 hover:text-gray-300"
        title="Sync / Refresh"
        aria-label="Sync"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
    </div>
  );
}

export default function StatusBar({
  workspaceId,
  projectName,
  activeFilePath,
  editorInfo,
  refreshTrigger,
  onSyncClick,
}: StatusBarProps) {
  const indentLabel = editorInfo
    ? editorInfo.insertSpaces
      ? `Spaces: ${editorInfo.indentSize}`
      : `Tab Size: ${editorInfo.indentSize}`
    : null;

  return (
    <div className="flex-shrink-0 h-6 flex items-center justify-between px-2 text-xs border-t border-surface-500 bg-surface-700 text-gray-400">
      <div className="flex items-center gap-4 min-w-0">
        <GitStatusItem workspaceId={workspaceId} refreshTrigger={refreshTrigger} onSyncClick={onSyncClick} />
        <span className="truncate max-w-[140px]" title={projectName}>
          {projectName}
        </span>
        {editorInfo && editorInfo.errors > 0 && (
          <button
            type="button"
            className="flex items-center gap-1 hover:text-red-400"
            title={`${editorInfo.errors} error(s)`}
          >
            <span className="text-red-400">{editorInfo.errors}</span>
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
          </button>
        )}
        {editorInfo && editorInfo.warnings > 0 && (
          <button
            type="button"
            className="flex items-center gap-1 hover:text-yellow-400"
            title={`${editorInfo.warnings} warning(s)`}
          >
            <span className="text-yellow-400">{editorInfo.warnings}</span>
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
          </button>
        )}
      </div>

      <div className="flex items-center gap-4 shrink-0">
        {editorInfo && (
          <>
            <span className="text-gray-500">
              Ln {editorInfo.line}, Col {editorInfo.column}
            </span>
            {indentLabel && <span className="text-gray-500">{indentLabel}</span>}
            <span className="text-gray-500">UTF-8</span>
            <span className="text-gray-500">LF</span>
            <span className="text-gray-500">{editorInfo.language || "plaintext"}</span>
          </>
        )}
        {activeFilePath && !editorInfo && (
          <span className="text-gray-500 truncate max-w-[200px]" title={activeFilePath}>
            {activeFilePath.split(/[/\\]/).pop()}
          </span>
        )}
      </div>
    </div>
  );
}
