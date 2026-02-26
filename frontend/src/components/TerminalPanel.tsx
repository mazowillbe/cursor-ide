import { useEffect, useRef, useState } from "react";
import "xterm/css/xterm.css";

export interface CursorSession {
  id: string;
  fullCmd: string;
  output: string;
}

interface TerminalPanelProps {
  workspaceId: string;
  /** Ref to receive the terminal write handler so agent output can be streamed here. */
  writeRef?: React.MutableRefObject<((chunk: string) => void) | null>;
  /** Called when the terminal is ready to receive output (for flushing buffered chunks). */
  onReady?: () => void;
  /** Cursor sessions from "show in main terminal" in chat mini terminals. */
  cursorSessions?: CursorSession[];
  /** Selected session id; null = show live terminal. */
  selectedCursorId?: string | null;
  /** Called when user selects a session in the side list. */
  onSelectCursorSession?: (id: string | null) => void;
  /** Called when user clicks bin to remove/kill a session. */
  onRemoveCursorSession?: (id: string) => void;
}

/** Strip output: trim and collapse excess newlines. */
function stripOutput(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .trim()
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Read-only xterm view for a Cursor session's output. */
function CursorSessionView({ fullCmd, output }: { fullCmd: string; output: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<{ dispose: () => void } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    (async () => {
      const { Terminal } = await import("xterm");
      const { FitAddon } = await import("xterm-addon-fit");

      const t = new Terminal({
        theme: {
          background: "#1A1A1A",
          foreground: "#d4d4d4",
          cursor: "transparent",
          black: "#1A1A1A",
          red: "#f44747",
          green: "#6a9955",
          yellow: "#dcdcaa",
          blue: "#569cd6",
          magenta: "#c586c0",
          cyan: "#4ec9b0",
          white: "#d4d4d4",
        },
        fontSize: 13,
        fontFamily: "Consolas, 'Courier New', monospace",
        allowProposedApi: false,
        cursorBlink: false,
        convertEol: true,
      });

      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(container);
      let disposed = false;
      const safeFit = () => {
        if (disposed || !container.isConnected) return;
        if (container.offsetWidth > 0 && container.offsetHeight > 0) {
          try {
            fit.fit();
          } catch {
            /* ignore xterm dimension errors when container is hidden or terminal disposed */
          }
        }
      };
      const prompt = "\x1b[36m$\x1b[0m \x1b[33m" + fullCmd + "\x1b[0m\r\n";
      t.write(prompt);
      const out = stripOutput(output);
      if (out) t.write(out);
      safeFit();

      const ro = new ResizeObserver(() => safeFit());
      ro.observe(container);

      terminalRef.current = {
        dispose() {
          disposed = true;
          ro.disconnect();
          fit.dispose();
          t.dispose();
        },
      };
    })();

    return () => {
      terminalRef.current?.dispose();
      terminalRef.current = null;
    };
  }, [fullCmd, output]);

  return <div ref={containerRef} className="h-full w-full xterm-container min-h-0" />;
}

/** Truncate command for side list label (e.g. "cd c:\...; npm run build" -> "cd c:\...; npm run") */
function truncateCmd(cmd: string, maxLen: number = 28): string {
  if (cmd.length <= maxLen) return cmd;
  return cmd.slice(0, maxLen - 3) + "...";
}

export default function TerminalPanel({
  workspaceId,
  writeRef,
  onReady,
  cursorSessions = [],
  selectedCursorId = null,
  onSelectCursorSession,
  onRemoveCursorSession,
}: TerminalPanelProps) {
  const [sideListOpen, setSideListOpen] = useState(true);
  const liveContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<{ dispose: () => void } | null>(null);

  useEffect(() => {
    const container = liveContainerRef.current;
    if (!container) return;

    (async () => {
      const { Terminal } = await import("xterm");
      const { FitAddon } = await import("xterm-addon-fit");
      const { WebLinksAddon } = await import("xterm-addon-web-links");

      const t = new Terminal({
        theme: {
          background: "#1A1A1A",
          foreground: "#d4d4d4",
          cursor: "#d4d4d4",
          black: "#1A1A1A",
          red: "#f44747",
          green: "#6a9955",
          yellow: "#dcdcaa",
          blue: "#569cd6",
          magenta: "#c586c0",
          cyan: "#4ec9b0",
          white: "#d4d4d4",
        },
        fontSize: 13,
        fontFamily: "Consolas, 'Courier New', monospace",
        allowProposedApi: false,
      });

      const fit = new FitAddon();
      t.loadAddon(fit);
      t.loadAddon(new WebLinksAddon());

      t.open(container);
      let disposed = false;
      const safeFit = () => {
        if (disposed || !container.isConnected) return;
        if (container.offsetWidth > 0 && container.offsetHeight > 0) {
          try {
            fit.fit();
          } catch {
            /* ignore xterm dimension errors when container is hidden or terminal disposed */
          }
        }
      };
      safeFit();
      t.clear();
      t.writeln("Terminal — agent commands appear here when you run OpenCode from Chat.");
      t.writeln(`Workspace: ${workspaceId}`);

      if (writeRef) writeRef.current = (chunk: string) => t.write(chunk);
      onReady?.();

      const resizeObserver = new ResizeObserver(() => safeFit());
      resizeObserver.observe(container);

      terminalRef.current = {
        dispose() {
          disposed = true;
          if (writeRef) writeRef.current = null;
          resizeObserver.disconnect();
          fit.dispose();
          t.dispose();
        },
      };
    })();

    return () => {
      terminalRef.current?.dispose();
      terminalRef.current = null;
    };
  }, [workspaceId]);

  const showLive = selectedCursorId === null;
  const selectedSession = cursorSessions.find((s) => s.id === selectedCursorId);

  return (
    <div className="h-full flex flex-col bg-[#1A1A1A] border-t border-[#3c3c3c]">
      {/* Header: IDE-style tab + icons */}
      <div className="flex-shrink-0 flex items-center justify-between bg-[#1A1A1A] border-b border-[#3c3c3c] min-h-[35px]">
        <div className="flex items-center gap-0">
          <span className="px-3 py-2 text-sm text-[#d4d4d4] bg-[#1A1A1A] border-r border-[#3c3c3c]">
            Terminal
          </span>
        </div>
        <div className="flex items-center gap-0.5 px-2 text-[#d4d4d4]">
          <button type="button" className="p-1 rounded hover:bg-white/10" title="New terminal">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
          <button
            type="button"
            className="p-1 rounded hover:bg-white/10"
            title={sideListOpen ? "Hide terminal list" : "Show terminal list"}
            onClick={() => setSideListOpen((o) => !o)}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <button type="button" className="p-1 rounded hover:bg-white/10" title="More options">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
            </svg>
          </button>
          <button type="button" className="p-1 rounded hover:bg-white/10" title="Maximize">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          </button>
          <button type="button" className="p-1 rounded hover:bg-white/10" title="Close panel">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Main terminal area: live and cursor view both mounted, toggle visibility */}
        <div className="flex-1 flex flex-col min-w-0 relative">
          <div
            ref={liveContainerRef}
            className={`flex-1 xterm-container min-h-0 absolute inset-0 ${showLive ? "" : "hidden"}`}
          />
          {selectedSession && (
            <div className={`flex-1 absolute inset-0 ${showLive ? "hidden" : ""}`}>
              <CursorSessionView fullCmd={selectedSession.fullCmd} output={selectedSession.output} />
            </div>
          )}
          <div className="flex-shrink-0 text-center py-1 text-xs text-[#858585] border-t border-[#3c3c3c]">
            Agent terminals are read-only
          </div>
        </div>

        {/* Side list: ∞ Cursor (command) */}
        {sideListOpen && cursorSessions.length > 0 && (
          <div className="w-[200px] flex-shrink-0 flex flex-col border-l border-[#3c3c3c] bg-[#1A1A1A]">
            <div className="flex-shrink-0 px-2 py-1.5 text-xs text-[#858585] border-b border-[#3c3c3c]">
              Sessions
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              <button
                type="button"
                onClick={() => onSelectCursorSession?.(null)}
                className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-white/5 ${showLive ? "bg-white/10 text-[#d4d4d4]" : "text-[#858585]"}`}
              >
                <span className="text-[#858585]">&#9654;</span>
                <span>Live</span>
              </button>
              {cursorSessions.map((s) => (
                <div
                  key={s.id}
                  className={`group w-full flex items-center gap-1 px-3 py-2 text-sm hover:bg-white/5 ${selectedCursorId === s.id ? "bg-white/10" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectCursorSession?.(s.id)}
                    className="flex-1 min-w-0 text-left flex items-center gap-2 truncate"
                    title={s.fullCmd}
                  >
                    <span className="flex-shrink-0 text-[#569cd6]" aria-hidden>∞</span>
                    <span className={`truncate ${selectedCursorId === s.id ? "text-[#d4d4d4]" : "text-[#858585]"}`}>
                      Cursor ({truncateCmd(s.fullCmd)})
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveCursorSession?.(s.id);
                    }}
                    className="flex-shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/20 text-[#858585] hover:text-red-400 transition-opacity"
                    title="Kill and remove session"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
