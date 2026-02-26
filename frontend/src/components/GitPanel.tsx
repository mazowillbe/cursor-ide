import { useState, useEffect } from "react";
import { getGitStatus, initGitRepo } from "../api/client";

interface GitPanelProps {
  workspaceId: string;
  onRefresh: () => void;
  /** When user clicks a changed file, open it in the editor */
  onSelectFile?: (path: string) => void;
}

export default function GitPanel({ workspaceId, onRefresh, onSelectFile }: GitPanelProps) {
  const [status, setStatus] = useState<{ isRepo: boolean; branch: string | null; status: string[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [initting, setInitting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const s = await getGitStatus(workspaceId);
      setStatus(s);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [workspaceId]);

  const handleInit = async () => {
    setInitting(true);
    try {
      await initGitRepo(workspaceId);
      await load();
      onRefresh();
    } catch {
      /* ignore */
    } finally {
      setInitting(false);
    }
  };

  if (loading || !status) {
    return (
      <div className="p-4 text-gray-500 text-sm">Loading…</div>
    );
  }

  if (!status.isRepo) {
    return (
      <div className="p-4">
        <p className="text-gray-500 text-sm mb-3">Not a Git repository.</p>
        <button
          type="button"
          onClick={handleInit}
          disabled={initting}
          className="px-3 py-1.5 rounded text-sm bg-accent text-white hover:opacity-90 disabled:opacity-50"
        >
          {initting ? "Initializing…" : "Initialize Repository"}
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-surface-700">
      <div className="flex-shrink-0 px-3 py-2 border-b border-surface-500">
        <span className="text-xs text-gray-500">Branch</span>
        <p className="text-sm font-medium text-gray-200">{status.branch || "main"}</p>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        <span className="text-xs text-gray-500 block mb-2">Changes</span>
        {status.status.length === 0 ? (
          <p className="text-gray-500 text-sm">No changes</p>
        ) : (
          <div className="space-y-1">
            {status.status.map((line, i) => {
              const code = line.slice(0, 2).trim() || "M";
              const filePath = line.slice(2).trim();
              const file = filePath.includes(" -> ") ? filePath.split(" -> ")[1]?.trim() ?? filePath : filePath;
              const color =
                code === "??" ? "text-green-400" :
                code.startsWith("D") ? "text-red-400" :
                "text-yellow-400";
              return (
                <button
                  key={`${file}-${i}`}
                  type="button"
                  onClick={() => onSelectFile?.(file)}
                  className="w-full flex items-center gap-2 text-xs text-left px-1 py-1 rounded hover:bg-surface-600"
                >
                  <span className={`w-6 shrink-0 ${color}`}>{code}</span>
                  <span className="text-gray-300 truncate min-w-0">{file}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
