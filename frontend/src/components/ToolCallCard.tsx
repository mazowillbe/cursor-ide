import { useState } from "react";
import { LuChevronsDownUp } from "react-icons/lu";

const CARD_HEADER_BG = "#252526";
const CARD_BG = "#1e1e1e";
const CARD_FG = "#d4d4d4";
const CARD_BORDER = "#3c3c3c";
const SIX_LINES_HEIGHT = 108;

const SPINNER = (
  <svg className="w-4 h-4 text-gray-500 animate-spin shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden>
    <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeDasharray="24 16" />
  </svg>
);
const TICK = (
  <svg className="w-4 h-4 text-gray-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

export interface ToolCallCardProps {
  /** Tool label: Read, Edit, Grepped, Listed, Globbed, etc. */
  label: string;
  /** Path, pattern, or command shown in header (e.g. file path, glob pattern). */
  pathOrCommand: string;
  /** Body content (file content, grep results, list output). */
  content: string;
  /** True when tool is still running. */
  pending: boolean;
  /** If set, path is clickable to open this file in the editor (for Read / Edit). */
  onOpenFile?: (path: string) => void;
  /** Called when user clicks close (collapse/remove card). */
  onClose?: () => void;
}

function IconExpandCollapse({ collapsed, onClick }: { collapsed: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="p-0.5 rounded text-gray-400 hover:text-white hover:bg-white/10 cursor-pointer"
      title={collapsed ? "Expand" : "Collapse"}
    >
      <LuChevronsDownUp className="w-4 h-4" style={collapsed ? { transform: "rotate(180deg)" } : undefined} />
    </button>
  );
}

function IconMore({ onClose }: { onClose?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      className="p-0.5 rounded text-gray-400 hover:text-white hover:bg-white/10 cursor-pointer"
      title="Close card"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
      </svg>
    </button>
  );
}

/**
 * Cursor-IDE-style tool call card: header (spinner/check + label + path) + collapsible body.
 * Use for Read, Grepped, Listed, Globbed. Edit/Write use MiniFileEditor; Bash uses MiniTerminal.
 */
export default function ToolCallCard({
  label,
  pathOrCommand,
  content,
  pending,
  onOpenFile,
  onClose,
}: ToolCallCardProps) {
  const [collapsed, setCollapsed] = useState(false);
  const trimmedPath = pathOrCommand.trim();
  const hasContent = content.length > 0;

  const headerPath = onOpenFile && trimmedPath ? (
    <button
      type="button"
      onClick={() => onOpenFile(trimmedPath)}
      className="truncate text-left hover:text-blue-400 hover:underline cursor-pointer max-w-full"
      title="Open in editor"
    >
      {trimmedPath}
    </button>
  ) : (
    <span className="truncate">{trimmedPath || "—"}</span>
  );

  const footerContent = pending ? (
    <span className="inline-flex items-center">{SPINNER}</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[#858585] text-xs">
      {TICK}
      Done
    </span>
  );

  return (
    <div
      className="rounded-lg border shadow-md overflow-hidden my-1.5"
      style={{ borderColor: CARD_BORDER, backgroundColor: CARD_HEADER_BG }}
    >
      <div
        className="flex items-center justify-between gap-2 px-3 py-2 border-b min-h-[40px] text-[#d4d4d4]"
        style={{ borderColor: CARD_BORDER, backgroundColor: CARD_HEADER_BG }}
      >
        <span className="text-sm flex items-center gap-1.5 min-w-0 flex-1 leading-snug">
          {pending && SPINNER}
          <span className="font-medium text-gray-200">{label}</span>
          {headerPath}
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          <IconExpandCollapse collapsed={collapsed} onClick={() => setCollapsed((c) => !c)} />
          <IconMore onClose={onClose} />
        </div>
      </div>
      <div
        className="w-full transition-[height] duration-200 overflow-hidden overflow-x-auto overflow-y-auto"
        style={{
          height: collapsed ? 0 : SIX_LINES_HEIGHT,
          backgroundColor: CARD_BG,
          maxHeight: collapsed ? 0 : 200,
          borderColor: CARD_BORDER,
        }}
      >
        <pre
          className="p-3 text-xs whitespace-pre-wrap break-words font-mono m-0"
          style={{ color: CARD_FG, minHeight: SIX_LINES_HEIGHT }}
        >
          {hasContent ? content : pending ? "…" : ""}
        </pre>
      </div>
      <div
        className="flex items-center justify-end gap-0 px-3 py-1.5 border-t min-h-[28px] text-[#858585]"
        style={{ borderColor: CARD_BORDER, backgroundColor: CARD_HEADER_BG }}
      >
        {footerContent}
      </div>
    </div>
  );
}
