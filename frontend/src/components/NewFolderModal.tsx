import { useState } from "react";
import { createFolder } from "../api/client";

interface NewFolderModalProps {
  workspaceId: string;
  onClose: () => void;
  onCreated: () => void;
}

export default function NewFolderModal({
  workspaceId,
  onClose,
  onCreated,
}: NewFolderModalProps) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = path.trim();
    if (!trimmed) {
      setError("Enter a folder path");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await createFolder(workspaceId, trimmed);
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create folder");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface-700 rounded-lg border border-surface-500 p-4 w-full max-w-md">
        <h3 className="text-sm font-medium text-gray-200 mb-3">New Folder</h3>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="e.g. src/components"
            className="w-full px-3 py-2 rounded bg-surface-600 border border-surface-500 text-gray-200 placeholder-gray-500 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
            autoFocus
          />
          {error && <p className="text-red-400 text-xs mt-1">{error}</p>}
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded text-sm text-gray-400 hover:text-gray-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-3 py-1.5 rounded text-sm bg-accent text-white hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
