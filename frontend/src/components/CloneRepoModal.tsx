import { useState } from "react";
import { createSession, cloneRepo, updateProjectName, updateProjectDescription } from "../api/client";

/** Derive repo name from clone URL (e.g. https://github.com/owner/repo.git -> repo). */
function repoNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/$/, "");
  const withoutGit = trimmed.replace(/\.git$/i, "");
  const segment = withoutGit.split("/").filter(Boolean).pop();
  return segment || "project";
}

interface CloneRepoModalProps {
  accessToken: string;
  onClose: () => void;
  onSuccess: (workspaceId: string, projectName: string) => void;
}

function CloseIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

export default function CloneRepoModal({
  accessToken,
  onClose,
  onSuccess,
}: CloneRepoModalProps) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) {
      setError("Enter a repository URL");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const { workspaceId } = await createSession(accessToken, { newProject: true });
      await cloneRepo(workspaceId, trimmed);
      const name = repoNameFromUrl(trimmed);
      await updateProjectName(workspaceId, name, accessToken).catch(() => {});
      await updateProjectDescription(workspaceId, "Cloned from Git", accessToken).catch(() => {});
      onSuccess(workspaceId, name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clone failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-[#252526] rounded-lg shadow-xl border border-[#3c3c3c] w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#3c3c3c]">
          <h2 className="font-medium text-gray-200">Clone repository</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded text-gray-400 hover:bg-[#3c3c3c] hover:text-gray-200"
          >
            <CloseIcon />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Repository URL</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repo.git"
              className="w-full px-3 py-2 rounded bg-[#1e1e1e] border border-[#3c3c3c] text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              autoFocus
            />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 rounded text-gray-300 hover:bg-[#3c3c3c]">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-3 py-1.5 rounded bg-[#0e639c] text-white hover:bg-[#1177bb] disabled:opacity-50"
            >
              {loading ? "Cloning…" : "Clone"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
