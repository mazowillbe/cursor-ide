import { useState, useEffect } from "react";
import type { Session } from "@supabase/supabase-js";
import { listProjects, deleteProject, type ProjectSummary } from "../api/client";

interface WelcomeScreenProps {
  session: Session;
  onOpenProject: () => void;
  onSelectProject: (projectId: string) => void;
  onBlankProject: () => void;
  onCloneRepo: () => void;
  onConnectSsh: () => void;
  onSignOut?: () => void;
}

function FolderIcon() {
  return (
    <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
    </svg>
  );
}

function CloneIcon() {
  return (
    <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>
  );
}

function SshIcon() {
  return (
    <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  );
}

function BlankProjectIcon() {
  return (
    <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
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

export default function WelcomeScreen({
  session,
  onOpenProject,
  onSelectProject,
  onBlankProject,
  onCloneRepo,
  onConnectSsh,
  onSignOut,
}: WelcomeScreenProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!session?.access_token) return;
    listProjects(session.access_token)
      .then(setProjects)
      .catch(() => setProjects([]))
      .finally(() => setLoading(false));
  }, [session?.access_token]);

  const recent = projects.slice(0, 5);
  const displayName = session.user?.email ?? "User";

  const handleDeleteProject = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    if (!confirm("Delete this project? All files, chat sessions, and messages will be removed.")) return;
    try {
      await deleteProject(projectId, session.access_token ?? "");
      setProjects((prev) => prev.filter((p) => p.id !== projectId));
    } catch {
      alert("Failed to delete project.");
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#1e1e1e] text-gray-200">
      <header className="flex-shrink-0 pt-8 pb-6 text-center">
        <h1 className="text-2xl font-semibold text-white tracking-tight">CURSOR</h1>
        <p className="mt-1 text-sm text-gray-500">
          <span className="text-gray-400">{displayName}</span>
          {onSignOut && (
            <>
              <span className="mx-2 text-gray-600">•</span>
              <button type="button" onClick={onSignOut} className="text-gray-500 hover:text-gray-300">
                Settings
              </button>
            </>
          )}
        </p>
      </header>

      <main className="flex-1 px-6 max-w-3xl mx-auto w-full">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
          <button
            type="button"
            onClick={onOpenProject}
            className="flex flex-col items-center gap-3 p-6 rounded-lg border border-[#3c3c3c] bg-[#252526] hover:bg-[#2d2d2d] hover:border-[#505050] transition-colors text-left w-full"
          >
            <FolderIcon />
            <span className="font-medium text-gray-200">Open project</span>
            <span className="text-xs text-gray-500 text-center">Open a project from your workspace</span>
          </button>
          <button
            type="button"
            onClick={onCloneRepo}
            className="flex flex-col items-center gap-3 p-6 rounded-lg border border-[#3c3c3c] bg-[#252526] hover:bg-[#2d2d2d] hover:border-[#505050] transition-colors text-left w-full"
          >
            <CloneIcon />
            <span className="font-medium text-gray-200">Clone repo</span>
            <span className="text-xs text-gray-500 text-center">Clone a repository from Git</span>
          </button>
          <button
            type="button"
            onClick={onConnectSsh}
            className="flex flex-col items-center gap-3 p-6 rounded-lg border border-[#3c3c3c] bg-[#252526] hover:bg-[#2d2d2d] hover:border-[#505050] transition-colors text-left w-full"
          >
            <SshIcon />
            <span className="font-medium text-gray-200">Connect via SSH</span>
            <span className="text-xs text-gray-500 text-center">Connect to a remote host</span>
          </button>
          <button
            type="button"
            onClick={onBlankProject}
            className="flex flex-col items-center gap-3 p-6 rounded-lg border border-[#3c3c3c] bg-[#252526] hover:bg-[#2d2d2d] hover:border-[#505050] transition-colors text-left w-full"
          >
            <BlankProjectIcon />
            <span className="font-medium text-gray-200">Blank project</span>
            <span className="text-xs text-gray-500 text-center">Start with an empty project (AI will suggest a name)</span>
          </button>
        </div>

        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-gray-400">Recent projects</h2>
          {projects.length > 5 && (
            <button type="button" onClick={onOpenProject} className="text-xs text-gray-500 hover:text-gray-300">
              View all ({projects.length})
            </button>
          )}
        </div>
        <ul className="space-y-1">
          {loading && (
            <li className="text-sm text-gray-500 py-2">Loading…</li>
          )}
          {!loading && recent.length === 0 && (
            <li className="text-sm text-gray-500 py-2">No projects yet. Open or clone a project to get started.</li>
          )}
          {!loading && recent.map((p) => (
            <li key={p.id} className="group relative">
              <button
                type="button"
                onClick={() => onSelectProject(p.id)}
                className="w-full flex items-center justify-between px-3 py-2 rounded text-left hover:bg-[#2d2d2d] text-gray-300 hover:text-gray-100 pr-10"
              >
                <span className="text-sm font-medium truncate">{p.name}</span>
                <span className="text-xs text-gray-500 truncate ml-2 max-w-[12rem]">{p.description || "—"}</span>
              </button>
              <button
                type="button"
                onClick={(e) => handleDeleteProject(e, p.id)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-gray-500 opacity-0 group-hover:opacity-100 hover:bg-red-500/20 hover:text-red-400 transition-opacity"
                title="Delete project"
                aria-label="Delete project"
              >
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-6 pt-4 border-t border-[#3c3c3c]">
          <button
            type="button"
            onClick={onBlankProject}
            className="text-sm text-gray-500 hover:text-gray-300"
          >
            + Blank project
          </button>
        </div>
      </main>
    </div>
  );
}
