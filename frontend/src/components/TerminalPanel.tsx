import { useEffect, useRef, useState } from "react";
import "xterm/css/xterm.css";
import { getTerminalWebSocketUrl } from "../api/client";

export interface CursorSession {
  id: string;
  fullCmd: string;
  output: string;
}

interface TerminalPanelProps {
  workspaceId: string;
  /** When set, this text is sent to the terminal (e.g. command from mini terminal "open in main"). */
  pendingInput?: string | null;
  /** Called after pendingInput has been sent so the parent can clear it. */
  onPendingInputConsumed?: () => void;
  /** Saved Cursor sessions from mini terminal "show in main" actions. */
  cursorSessions?: CursorSession[];
  /** Selected session id; null = show live terminal. */
  selectedCursorId?: string | null;
  /** Called when user selects a session in the side list. */
  onSelectCursorSession?: (id: string | null) => void;
  /** Called when user clicks bin to remove a session. */
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

/** Read-only view for a saved Cursor session (command + output). */
function CursorSessionView({ fullCmd, output }: { fullCmd: string; output: string }) {
  const out = stripOutput(output);
  return (
    <div className="h-full w-full bg-[#1A1A1A] text-[#d4d4d4] text-xs font-mono p-2 overflow-auto">
      <div className="text-[#4ec9b0]">
        $ <span className="text-[#dcdcaa]">{fullCmd}</span>
      </div>
      {out && (
        <pre className="mt-1 whitespace-pre-wrap text-[#d4d4d4]">
          {out}
        </pre>
      )}
    </div>
  );
}

/** Truncate command for side list label. */
function truncateCmd(cmd: string, maxLen: number = 28): string {
  if (cmd.length <= maxLen) return cmd;
  return cmd.slice(0, maxLen - 3) + "...";
}

export default function TerminalPanel({
  workspaceId,
  pendingInput,
  onPendingInputConsumed,
  cursorSessions = [],
  selectedCursorId = null,
  onSelectCursorSession,
  onRemoveCursorSession,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<{ dispose: () => void } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [sideListOpen, setSideListOpen] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let ws: WebSocket | null = null;
    let disposed = false;

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
      const safeFit = () => {
        if (disposed || !container.isConnected) return;
        if (container.offsetWidth > 0 && container.offsetHeight > 0) {
          try {
            fit.fit();
            const { cols, rows } = t;
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ cols, rows }));
            }
          } catch {
            /* ignore */
          }
        }
      };
      safeFit();

      const url = getTerminalWebSocketUrl(workspaceId);
      ws = new WebSocket(url);
      wsRef.current = ws;
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        if (disposed) return;
        setDisconnected(false);
        const { cols, rows } = t;
        ws?.send(JSON.stringify({ cols, rows }));
      };

      ws.onmessage = (ev) => {
        if (disposed) return;
        const data = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
        t.write(data);
      };

      ws.onclose = () => {
        if (!disposed) {
          setDisconnected(true);
          t.writeln("\r\n\x1b[33m[Terminal disconnected]\x1b[0m");
        }
      };

      ws.onerror = () => {
        if (!disposed) {
          setDisconnected(true);
          t.writeln("\r\n\x1b[31m[Connection error]\x1b[0m");
        }
      };

      t.onData((data) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(data);
      });

      const resizeObserver = new ResizeObserver(() => safeFit());
      resizeObserver.observe(container);

      terminalRef.current = {
        dispose() {
          disposed = true;
          wsRef.current = null;
          ws?.close();
          ws = null;
          resizeObserver.disconnect();
          fit.dispose();
          t.dispose();
        },
      };
    })();

    return () => {
      terminalRef.current?.dispose();
      terminalRef.current = null;
      wsRef.current = null;
    };
  }, [workspaceId, reconnectKey]);

  // When "open in main terminal" is used, send the command to the live terminal once the WebSocket is ready.
  useEffect(() => {
    if (!pendingInput || !onPendingInputConsumed) return;
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(pendingInput);
      onPendingInputConsumed();
      return;
    }
    const id = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(pendingInput);
        onPendingInputConsumed();
        clearInterval(id);
      }
    }, 50);
    return () => clearInterval(id);
  }, [pendingInput, onPendingInputConsumed]);

  const showLive = selectedCursorId === null;
  const selectedSession = cursorSessions.find((s) => s.id === selectedCursorId) ?? null;

  return (
    <div className="h-full flex flex-col bg-[#1A1A1A] border-t border-[#3c3c3c]">
      <div className="flex-shrink-0 flex items-center justify-between bg-[#1A1A1A] border-b border-[#3c3c3c] min-h-[35px]">
        <div className="flex items-center gap-0">
          <span className="px-3 py-2 text-sm text-[#d4d4d4] bg-[#1A1A1A] border-r border-[#3c3c3c]">
            Terminal
          </span>
        </div>
        <div className="flex items-center gap-0.5 px-2 text-[#d4d4d4]">
          {disconnected && (
            <button
              type="button"
              onClick={() => setReconnectKey((k) => k + 1)}
              className="px-2 py-1 text-xs rounded bg-[#4ecdc4]/20 hover:bg-[#4ecdc4]/30 text-[#4ecdc4]"
            >
              Reconnect
            </button>
          )}
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
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Main area: live terminal (WebSocket) + optional saved session view */}
        <div className="flex-1 flex flex-col min-w-0 relative">
          <div
            ref={containerRef}
            className={`h-full w-full xterm-container min-h-0 absolute inset-0 ${showLive ? "" : "hidden"}`}
          />
          {selectedSession && (
            <div className={`h-full w-full absolute inset-0 ${showLive ? "hidden" : ""}`}>
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
                className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-white/5 ${
                  showLive ? "bg-white/10 text-[#d4d4d4]" : "text-[#858585]"
                }`}
              >
                <span className="text-[#858585]">&#9654;</span>
                <span>Live</span>
              </button>
              {cursorSessions.map((s) => (
                <div
                  key={s.id}
                  className={`group w-full flex items-center gap-1 px-3 py-2 text-sm hover:bg-white/5 ${
                    selectedCursorId === s.id ? "bg-white/10" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectCursorSession?.(s.id)}
                    className="flex-1 min-w-0 text-left flex items-center gap-2 truncate"
                    title={s.fullCmd}
                  >
                    <span className="flex-shrink-0 text-[#569cd6]" aria-hidden>
                      ∞
                    </span>
                    <span
                      className={`truncate ${
                        selectedCursorId === s.id ? "text-[#d4d4d4]" : "text-[#858585]"
                      }`}
                    >
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
                    title="Remove session"
                    aria-label="Remove session"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
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
