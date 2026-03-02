import { useEffect, useRef, useState } from "react";
import "xterm/css/xterm.css";
import { getTerminalWebSocketUrl } from "../api/client";

interface TerminalPanelProps {
  workspaceId: string;
}

export default function TerminalPanel({ workspaceId }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<{ dispose: () => void } | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);

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
    };
  }, [workspaceId, reconnectKey]);

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
          <button type="button" className="p-1 rounded hover:bg-white/10" title="New terminal">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
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

      <div className="flex-1 min-h-0">
        <div ref={containerRef} className="h-full w-full xterm-container min-h-0" />
      </div>
    </div>
  );
}
