import { useState, useCallback } from "react";
import { useAuth } from "./contexts/AuthContext";
import { createSession, openProject, ensureGitInWorkspace } from "./api/client";
import AuthPage from "./components/AuthPage";
import Layout from "./components/Layout";
import OpenProjectModal from "./components/OpenProjectModal";
import WelcomeScreen from "./components/WelcomeScreen";
import CloneRepoModal from "./components/CloneRepoModal";

export default function App() {
  const { user, session, loading: authLoading, configError, signOut } = useAuth();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string>("Project");
  const [projectSource, setProjectSource] = useState<"blank" | "open" | "clone">("open");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showOpenProject, setShowOpenProject] = useState(false);
  const [showCloneModal, setShowCloneModal] = useState(false);

  const handleBlankProject = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true);
    try {
      setError(null);
      const { workspaceId: id, projectName: name } = await createSession(session.access_token, {
        newProject: true,
      });
      setWorkspaceId(id);
      setProjectName(name ?? "New Project");
      setProjectSource("blank");
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
        setProjectSource("open");
        if (id) ensureGitInWorkspace(id).catch(() => {});
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to open project");
      } finally {
        setLoading(false);
      }
    },
    [session?.access_token]
  );

  const handleCloseProject = useCallback(() => {
    setWorkspaceId(null);
    setProjectName("Project");
    setError(null);
    setShowOpenProject(false);
    setShowCloneModal(false);
  }, []);

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

  if (user && session && !workspaceId) {
    return (
      <>
        <WelcomeScreen
          session={session}
          onOpenProject={() => {
            setError(null);
            setShowOpenProject(true);
          }}
          onSelectProject={handleOpenProject}
          onBlankProject={handleBlankProject}
          onCloneRepo={() => {
            setError(null);
            setShowCloneModal(true);
          }}
          onConnectSsh={() => {
            setError(null);
            window.alert("Connect via SSH is not available yet.");
          }}
          onSignOut={signOut ? () => signOut() : undefined}
        />
        {showOpenProject && session.access_token && (
          <OpenProjectModal
            accessToken={session.access_token}
            onClose={() => setShowOpenProject(false)}
            onSelect={handleOpenProject}
          />
        )}
        {showCloneModal && session.access_token && (
          <CloneRepoModal
            accessToken={session.access_token}
            onClose={() => setShowCloneModal(false)}
            onSuccess={(id, name) => {
              setWorkspaceId(id);
              setProjectName(name);
              setProjectSource("clone");
              setShowCloneModal(false);
              if (id) ensureGitInWorkspace(id).catch(() => {});
            }}
          />
        )}
        {loading && (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
            <div className="animate-pulse text-lg text-gray-200">Opening…</div>
          </div>
        )}
        {error && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded bg-red-900/90 text-red-100 text-sm">
            {error}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <Layout
        workspaceId={workspaceId!}
        projectName={projectName}
        session={session}
        onProjectNameChange={setProjectName}
        onNewProject={handleBlankProject}
        onOpenProject={() => setShowOpenProject(true)}
        onCloseProject={handleCloseProject}
        enableProjectNaming={projectSource === "blank"}
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
