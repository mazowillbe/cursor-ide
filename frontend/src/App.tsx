import { useState, useEffect, useCallback } from "react";
import { useAuth } from "./contexts/AuthContext";
import { createSession, openProject, ensureGitInWorkspace } from "./api/client";
import AuthPage from "./components/AuthPage";
import Layout from "./components/Layout";
import OpenProjectModal from "./components/OpenProjectModal";

export default function App() {
  const { user, session, loading: authLoading, configError } = useAuth();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string>("Project");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showOpenProject, setShowOpenProject] = useState(false);

  const initSession = useCallback(async () => {
    if (!session?.access_token) return;
    try {
      setError(null);
      const { workspaceId: id, projectName: name } = await createSession(session.access_token);
      setWorkspaceId(id);
      setProjectName(name ?? "Project");
      if (id) ensureGitInWorkspace(id).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create session");
    } finally {
      setLoading(false);
    }
  }, [session?.access_token]);

  const handleNewProject = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true);
    try {
      setError(null);
      const { workspaceId: id, projectName: name } = await createSession(session.access_token, {
        newProject: true,
      });
      setWorkspaceId(id);
      setProjectName(name ?? "New Project");
      if (id) ensureGitInWorkspace(id).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create project");
    } finally {
      setLoading(false);
    }
  }, [session?.access_token]);

  const handleOpenProject = useCallback(
    async (projectId: string) => {
      if (!session?.access_token) return;
      setShowOpenProject(false);
      setLoading(true);
      try {
        setError(null);
        const { workspaceId: id, projectName: name } = await openProject(
          projectId,
          session.access_token
        );
        setWorkspaceId(id);
        setProjectName(name ?? "Project");
        if (id) ensureGitInWorkspace(id).catch(() => {});
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to open project");
      } finally {
        setLoading(false);
      }
    },
    [session?.access_token]
  );

  useEffect(() => {
    if (!authLoading && user && session) {
      initSession();
    } else if (!authLoading && !user) {
      setLoading(false);
    }
  }, [authLoading, user, session, initSession]);

  if (authLoading) {
    return (
      <div className="h-full flex items-center justify-center bg-surface-800 text-gray-300">
        <div className="animate-pulse text-lg">Loading…</div>
      </div>
    );
  }

  if (configError) {
    return (
      <div className="h-full flex items-center justify-center bg-surface-800 text-gray-300">
        <div className="text-center max-w-md">
          <p className="text-red-400 mb-4">{configError}</p>
          <p className="text-sm text-gray-500">
            Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env
          </p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <AuthPage />;
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-surface-800 text-gray-300">
        <div className="text-center">
          <div className="animate-pulse text-lg">Creating workspace…</div>
        </div>
      </div>
    );
  }

  if (error || !workspaceId) {
    return (
      <div className="h-full flex items-center justify-center bg-surface-800 text-gray-300">
        <div className="text-center max-w-md">
          <p className="text-red-400 mb-4">{error ?? "No workspace"}</p>
          <p className="text-sm text-gray-500 mb-4">
            Ensure the backend is running on port 3001 (npm run dev in backend folder).
          </p>
          <button
            onClick={initSession}
            className="px-4 py-2 bg-accent text-white rounded hover:opacity-90"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <Layout
        workspaceId={workspaceId}
        projectName={projectName}
        session={session}
        onProjectNameChange={setProjectName}
        onNewProject={handleNewProject}
        onOpenProject={() => setShowOpenProject(true)}
      />
      {showOpenProject && session?.access_token && (
        <OpenProjectModal
          accessToken={session.access_token}
          onClose={() => setShowOpenProject(false)}
          onSelect={handleOpenProject}
        />
      )}
    </>
  );
}
