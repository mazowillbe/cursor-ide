import { useRef, useEffect } from "react";

interface FileMenuProps {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onNewProject?: () => void;
  onOpenProject?: () => void;
}

export default function FileMenu({
  open,
  onToggle,
  onClose,
  onNewProject,
  onOpenProject,
}: FileMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, onClose]);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={onToggle}
        className={`px-2 py-1.5 rounded text-sm font-medium transition-colors ${
          open ? "bg-surface-600 text-gray-200" : "text-gray-400 hover:bg-surface-600 hover:text-gray-200"
        }`}
      >
        File
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 py-1 min-w-[180px] bg-surface-700 border border-surface-500 rounded shadow-lg z-50">
          <button
            type="button"
            onClick={() => {
              onNewProject?.();
              onClose();
            }}
            className="w-full px-3 py-2 text-left text-sm text-gray-300 hover:bg-surface-600 flex items-center gap-2"
          >
            <NewFileIcon />
            New Workspace
          </button>
          <button
            type="button"
            onClick={() => {
              onOpenProject?.();
              onClose();
            }}
            className="w-full px-3 py-2 text-left text-sm text-gray-300 hover:bg-surface-600 flex items-center gap-2"
          >
            <FolderIcon />
            Open Project
          </button>
        </div>
      )}
    </div>
  );
}

function NewFileIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
      />
    </svg>
  );
}
