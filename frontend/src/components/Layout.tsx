import { useRef, useState, useCallback, useEffect } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { useAuth } from "../contexts/AuthContext";
import { getPreviewStatus } from "../api/client";
import ChatPanel from "./ChatPanel";
import EditorPanel from "./EditorPanel";
import SidebarPanel from "./SidebarPanel";
import TerminalPanel, { type CursorSession } from "./TerminalPanel";
import FileMenu from "./FileMenu";

interface LayoutProps {
  workspaceId: string;
  projectName?: string;
  session?: Session | null;
  onProjectNameChange?: (name: string) => void;
  onNewProject?: () => void;
  onOpenProject?: () => void;
  onCloseProject?: () => void;
  /** When true, first user message triggers project naming AI (blank project only). */
  enableProjectNaming?: boolean;
}

export default function Layout({
  workspaceId,
  projectName = "Project",
  session,
  onProjectNameChange,
  onNewProject,
  onOpenProject,
  onCloseProject,
  enableProjectNaming = false,
}: LayoutProps) {
  const { user, signOut } = useAuth();
  const [openFilePaths, setOpenFilePaths] = useState<string[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [fileTreeRefresh, setFileTreeRefresh] = useState(0);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [cursorSessions, setCursorSessions] = useState<CursorSession[]>([]);
  const [selectedCursorId, setSelectedCursorId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewPort, setPreviewPort] = useState<number | null>(null);
  const [previewRefreshKey, setPreviewRefreshKey] = useState(0);
  const [centerView, setCenterView] = useState<"editor" | "preview">("editor");
  const terminalWriteRef = useRef<((chunk: string) => void) | null>(null);
  const chunkBufferRef = useRef<string[]>([]);
  const sidebarPanelRef = useRef<ImperativePanelHandle | null>(null);

  const handlePreviewReady = useCallback((url: string, port?: number) => {
    setPreviewUrl(url);
    setPreviewPort(port ?? null);
    setCenterView("preview");
  }, []);
  const handlePreviewRefresh = useCallback(() => {
    setPreviewRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    setPreviewUrl(null);
    setPreviewPort(null);
  }, [workspaceId]);

  useEffect(() => {
    if (centerView !== "preview" || previewUrl) return;
    getPreviewStatus(workspaceId).then((status) => {
      if (status) {
        setPreviewUrl(status.url);
        setPreviewPort(status.port);
      }
    });
  }, [centerView, workspaceId, previewUrl]);

  const addCursorSession = useCallback((fullCmd: string, output: string) => {
    const id = `cursor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setCursorSessions((prev) => [...prev, { id, fullCmd, output }]);
    setSelectedCursorId(id);
  }, []);
  const removeCursorSession = useCallback((id: string) => {
    setCursorSessions((prev) => prev.filter((s) => s.id !== id));
    setSelectedCursorId((current) => (current === id ? null : current));
  }, []);
  const handleSidebarCollapse = useCallback(() => {
    sidebarPanelRef.current?.collapse();
  }, []);

  const handleOpenFile = useCallback((path: string | null) => {
    if (!path) {
      setActiveFilePath(null);
      return;
    }
    setOpenFilePaths((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActiveFilePath(path);
  }, []);

  const handleCloseTab = useCallback((path: string) => {
    const idx = openFilePaths.indexOf(path);
    const nextOpen = openFilePaths.filter((p) => p !== path);
    const nextActive =
      activeFilePath === path
        ? (idx > 0 ? nextOpen[idx - 1]! : nextOpen[0] ?? null)
        : activeFilePath;
    setOpenFilePaths(nextOpen);
    setActiveFilePath(nextActive);
  }, [openFilePaths, activeFilePath]);

  const handleSelectTab = useCallback((path: string) => {
    setActiveFilePath(path);
  }, []);

  const flushTerminalBuffer = () => {
    const write = terminalWriteRef.current;
    if (!write) return;
    const buf = chunkBufferRef.current;
    chunkBufferRef.current = [];
    buf.forEach((chunk) => write(chunk));
  };

  const handleAgentChunk = (chunk: string) => {
    const write = terminalWriteRef.current;
    if (write) {
      write(chunk);
    } else {
      chunkBufferRef.current.push(chunk);
    }
  };

  return (
    <div className="h-full flex flex-col bg-surface-800 text-gray-200">
      <header className="flex-shrink-0 h-10 flex items-center justify-between px-4 border-b border-surface-500 bg-surface-700">
        <div className="flex items-center gap-2">
          <FileMenu
            open={fileMenuOpen}
            onToggle={() => setFileMenuOpen((o) => !o)}
            onClose={() => setFileMenuOpen(false)}
            onNewProject={onNewProject}
            onOpenProject={onOpenProject}
            onCloseProject={onCloseProject}
          />
          <span className="font-medium text-sm text-gray-400">Cursor Web</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500">{user?.email}</span>
          <button
            type="button"
            onClick={() => signOut()}
            className="text-xs text-gray-500 hover:text-gray-300"
          >
            Sign out
          </button>
        </div>
      </header>
      <div className="flex-1 min-h-0 flex">
        <PanelGroup direction="horizontal" className="flex-1">
          {/* Left: file tree full height */}
          <Panel
            ref={sidebarPanelRef}
            id="sidebar"
            defaultSize={20}
            minSize={14}
            maxSize={35}
            collapsible
            collapsedSize={0}
          >
            <SidebarPanel
              workspaceId={workspaceId}
              projectName={projectName}
              selectedPath={activeFilePath}
              onSelectFile={(path) => path && handleOpenFile(path)}
              refreshTrigger={fileTreeRefresh}
              onCollapse={handleSidebarCollapse}
            />
          </Panel>
          <PanelResizeHandle className="w-1" />
          {/* Center: editor + terminal, or preview iframe */}
          <Panel defaultSize={55} minSize={30}>
            <div className="h-full flex flex-col">
              <div className="flex-shrink-0 flex items-center gap-1 border-b border-surface-500 bg-surface-700 px-2 py-1">
                <button
                  type="button"
                  onClick={() => setCenterView("editor")}
                  className={`px-3 py-1.5 rounded text-sm ${centerView === "editor" ? "bg-surface-600 text-white" : "text-gray-400 hover:text-gray-200"}`}
                >
                  Editor
                </button>
                <button
                  type="button"
                  onClick={() => setCenterView("preview")}
                  className={`px-3 py-1.5 rounded text-sm flex items-center gap-1.5 ${centerView === "preview" ? "bg-surface-600 text-white" : "text-gray-400 hover:text-gray-200"}`}
                >
                  Preview
                  {previewUrl && (
                    <span className="w-2 h-2 rounded-full bg-green-500" title="Dev server running" />
                  )}
                </button>
              </div>
              <div className="flex-1 min-h-0">
                {centerView === "editor" ? (
                  <PanelGroup direction="vertical" className="h-full">
                    <Panel defaultSize={70} minSize={30}>
                      <EditorPanel
                        workspaceId={workspaceId}
                        openFilePaths={openFilePaths}
                        activeFilePath={activeFilePath}
                        onSelectTab={handleSelectTab}
                        onCloseTab={handleCloseTab}
                      />
                    </Panel>
                    <PanelResizeHandle className="h-1" />
                    <Panel defaultSize={30} minSize={15} maxSize={70}>
                      <TerminalPanel
                        workspaceId={workspaceId}
                        writeRef={terminalWriteRef}
                        onReady={flushTerminalBuffer}
                        cursorSessions={cursorSessions}
                        selectedCursorId={selectedCursorId}
                        onSelectCursorSession={setSelectedCursorId}
                        onRemoveCursorSession={removeCursorSession}
                      />
                    </Panel>
                  </PanelGroup>
                ) : (
                  <div className="h-full w-full bg-surface-900 flex flex-col min-h-0">
                    {previewUrl ? (
                      <>
                        <div className="flex-shrink-0 flex items-center gap-2 px-2 py-1.5 border-b border-surface-600 bg-surface-800">
                          <button
                            type="button"
                            onClick={() => setPreviewRefreshKey((k) => k + 1)}
                            className="px-2.5 py-1 rounded text-xs text-gray-300 hover:text-white hover:bg-surface-600 border border-white/10"
                            title="Refresh preview"
                          >
                            Refresh
                          </button>
                          <a
                            href={previewUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-2.5 py-1 rounded text-xs text-gray-300 hover:text-white hover:bg-surface-600 border border-white/10 no-underline"
                            title="Open in new tab"
                          >
                            Open in new tab
                          </a>
                        </div>
                        <div className="flex-1 min-h-0">
                          <iframe
                            key={`${previewUrl}-${previewPort ?? ""}-${previewRefreshKey}`}
                            src={previewUrl}
                            title="App preview"
                            className="w-full h-full border-0 bg-white"
                            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                          />
                        </div>
                      </>
                    ) : (
                      <div className="flex-1 flex items-center justify-center">
                        <p className="text-gray-500 text-sm">
                          Run the dev server (e.g. <code className="bg-surface-700 px-1 rounded">npm run dev</code>) in the agent to see the app preview here.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </Panel>
          <PanelResizeHandle className="w-1" />
          {/* Right: chat full height */}
          <Panel defaultSize={25} minSize={18} maxSize={40}>
            <ChatPanel
              workspaceId={workspaceId}
              selectedFilePath={activeFilePath}
              session={session}
              onAgentComplete={() => setFileTreeRefresh((k) => k + 1)}
              onAgentChunk={handleAgentChunk}
              onSessionTitleUpdate={onProjectNameChange}
              onAddCursorSession={addCursorSession}
              onOpenFile={(path) => path && handleOpenFile(path)}
              onPreviewReady={handlePreviewReady}
              onPreviewRefresh={handlePreviewRefresh}
              enableProjectNaming={enableProjectNaming}
            />
          </Panel>
        </PanelGroup>
      </div>
    </div>
  );
}
