import { useState } from "react";
import { searchWorkspace, type SearchResult } from "../api/client";

interface SearchPanelProps {
  workspaceId: string;
  onSelectFile: (path: string) => void;
}

export default function SearchPanel({ workspaceId, onSelectFile }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setSearched(true);
    try {
      const { results: r } = await searchWorkspace(workspaceId, query.trim());
      setResults(r);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-surface-700">
      <form onSubmit={handleSearch} className="flex-shrink-0 p-2 border-b border-surface-500">
        <div className="relative">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search in workspace"
            className="w-full pl-8 pr-3 py-2 rounded bg-surface-600 border border-surface-500 text-gray-200 placeholder-gray-500 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="mt-2 w-full py-1.5 rounded text-xs bg-accent text-white hover:opacity-90 disabled:opacity-50"
        >
          {loading ? "Searching…" : "Search"}
        </button>
      </form>
      <div className="flex-1 overflow-y-auto p-2">
        {!searched && (
          <p className="text-gray-500 text-sm py-4">Enter a search term and press Search.</p>
        )}
        {searched && results.length === 0 && !loading && (
          <p className="text-gray-500 text-sm py-4">No matches found.</p>
        )}
        {results.length > 0 && (
          <div className="space-y-1">
            {results.map((r, i) => (
              <button
                key={`${r.path}-${r.line}-${i}`}
                type="button"
                onClick={() => onSelectFile(r.path)}
                className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-surface-600 group"
              >
                <span className="text-accent font-medium truncate block">{r.path}</span>
                <span className="text-gray-500">L{r.line}:</span>{" "}
                <span className="text-gray-300 truncate">{r.text}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
