import { useState } from "react";
import FileTree from "./FileTree";
import SearchPanel from "./SearchPanel";
import GitPanel from "./GitPanel";
import NewFileModal from "./NewFileModal";
import NewFolderModal from "./NewFolderModal";

type PanelTab = "files" | "search" | "git";

interface SidebarPanelProps {
  workspaceId: string;
  projectName?: string;
  selectedPath: string | null;
  onSelectFile: (path: string | null) => void;
  refreshTrigger?: number;
  onCollapse?: () => void;
}

export default function SidebarPanel({
  workspaceId,
  projectName = "Project",
  selectedPath,
  onSelectFile,
  refreshTrigger = 0,
  onCollapse,
}: SidebarPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>("files");
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [fileTreeRefresh, setFileTreeRefresh] = useState(0);

  const triggerRefresh = () => {
    setFileTreeRefresh((k) => k + 1);
  };

  return (
    <div className="h-full flex flex-col bg-[#1A1A1A] border-r border-surface-500">
      <div className="flex-shrink-0 flex items-center gap-0.5 px-1 py-1 border-b border-surface-500">
        <button
          type="button"
          onClick={() => setActiveTab("files")}
          className={`p-2 rounded ${activeTab === "files" ? "bg-surface-600 text-accent" : "text-gray-400 hover:bg-surface-600 hover:text-gray-200"}`}
          title="Explorer"
        >
          <FilesIcon />
        </button>
        <button
          type="button"
          onClick={() => setActiveTab(activeTab === "search" ? "files" : "search")}
          className={`p-2 rounded ${activeTab === "search" ? "bg-surface-600 text-accent" : "text-gray-400 hover:bg-surface-600 hover:text-gray-200"}`}
          title="Search"
        >
          <SearchIcon />
        </button>
        <button
          type="button"
          onClick={() => setActiveTab(activeTab === "git" ? "files" : "git")}
          className={`p-2 rounded ${activeTab === "git" ? "bg-surface-600 text-accent" : "text-gray-400 hover:bg-surface-600 hover:text-gray-200"}`}
          title="Source Control"
        >
          <GitIcon />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === "files" && (
          <FileTree
            workspaceId={workspaceId}
            projectName={projectName}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
            refreshTrigger={refreshTrigger || fileTreeRefresh}
            onNewFile={() => setNewFileOpen(true)}
            onNewFolder={() => setNewFolderOpen(true)}
            onRefresh={triggerRefresh}
            onCollapse={onCollapse}
          />
        )}
        {activeTab === "search" && (
          <SearchPanel
            workspaceId={workspaceId}
            onSelectFile={(path) => {
              onSelectFile(path);
              setActiveTab("files");
            }}
          />
        )}
        {activeTab === "git" && (
          <GitPanel
            workspaceId={workspaceId}
            onRefresh={triggerRefresh}
            onSelectFile={(path) => {
              onSelectFile(path);
            }}
          />
        )}
      </div>
      {newFileOpen && (
        <NewFileModal
          workspaceId={workspaceId}
          onClose={() => setNewFileOpen(false)}
          onCreated={(path) => {
            setNewFileOpen(false);
            onSelectFile(path);
            triggerRefresh();
          }}
        />
      )}
      {newFolderOpen && (
        <NewFolderModal
          workspaceId={workspaceId}
          onClose={() => setNewFolderOpen(false)}
          onCreated={() => {
            triggerRefresh();
          }}
        />
      )}
    </div>
  );
}

function FilesIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  );
}

function GitIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
    </svg>
  );
}
