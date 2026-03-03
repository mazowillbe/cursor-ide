import { useState, useEffect } from "react";
import { listProjects, deleteProject, type ProjectSummary } from "../api/client";

interface OpenProjectModalProps {
  accessToken: string;
  onClose: () => void;
  onSelect: (projectId: string) => void;
}

export default function OpenProjectModal({
  accessToken,
  onClose,
  onSelect,
}: OpenProjectModalProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProjects(accessToken)
      .then(setProjects)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [accessToken]);

  const handleDelete = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    if (!confirm("Delete this project? All files, chat sessions, and messages will be removed.")) return;
    try {
      await deleteProject(projectId, accessToken);
      setProjects((prev) => prev.filter((p) => p.id !== projectId));
    } catch {
      setError("Failed to delete project.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface-700 rounded-lg shadow-xl border border-surface-500 w-full max-w-md max-h-[70vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-500">
          <h2 className="font-medium text-gray-200">Open Project</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded text-gray-400 hover:bg-surface-600 hover:text-gray-200"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="text-gray-400 text-sm py-4 text-center">Loading projects…</div>
          )}
          {error && (
            <div className="text-red-400 text-sm py-4">{error}</div>
          )}
          {!loading && !error && projects.length === 0 && (
            <div className="text-gray-500 text-sm py-4 text-center">
              No projects yet. Create one with File → New Workspace.
            </div>
          )}
          {!loading && !error && projects.length > 0 && (
            <ul className="space-y-1">
              {projects.map((p) => (
                <li key={p.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => onSelect(p.id)}
                    className="w-full flex flex-col items-start px-3 py-2 rounded text-left hover:bg-surface-600 transition-colors pr-10"
                  >
                    <span className="font-medium text-gray-200">{p.name}</span>
                    {p.description && (
                      <span className="text-xs text-gray-500 truncate max-w-full">
                        {p.description}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => handleDelete(e, p.id)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-gray-500 opacity-0 group-hover:opacity-100 hover:bg-red-500/20 hover:text-red-400 transition-opacity"
                    title="Delete project"
                    aria-label="Delete project"
                  >
                    <TrashIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  );
}
