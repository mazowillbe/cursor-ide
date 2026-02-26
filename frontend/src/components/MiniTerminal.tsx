import { useEffect, useRef } from "react";
import "xterm/css/xterm.css";

/** Match reference: dark charcoal card, light text, blue prompt */
const CARD_BG = "#2D2D30";
const TEXT = "#F0F0F0";
const TEXT_MUTED = "#858585";
const PROMPT_BLUE = "#569CD6";
const BORDER = "#3c3c3c";

export interface MiniTerminalProps {
  /** "Running" | "Ran" */
  label: "Running" | "Ran";
  /** Display name for header e.g. "cd, npm run" */
  cmdName: string;
  /** Full command line e.g. "cd path; npm run build" */
  fullCmd: string;
  /** Command output (can include ANSI). */
  output: string;
  /** Show failure icon when Ran. */
  failed?: boolean;
  /** Called when user clicks "show in main terminal". */
  onShowInMainTerminal?: () => void;
  /** Called when user clicks close (remove this card). */
  onClose?: () => void;
  /** Called when user clicks X to kill the running process (then onClose is also called). */
  onKill?: () => void;
}

/** Height for 6 lines at ~18px line height */
const SIX_LINES_HEIGHT = 108;

/** Short command for header: "cd, npm run" style (first command + next part's start), max ~28 chars */
function shortCommand(fullCmd: string): string {
  const t = fullCmd.trim();
  const parts = t.split(/\s*[;&]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return t.length <= 28 ? t : t.slice(0, 25) + "...";
  const first = parts[0]!.split(/\s+/)[0] ?? parts[0];
  if (parts.length === 1) return first.length <= 28 ? first : first.slice(0, 25) + "...";
  const second = parts[1]!.split(/\s+/).slice(0, 2).join(" ");
  const combined = `${first}, ${second}`;
  return combined.length <= 28 ? combined : combined.slice(0, 25) + "...";
}

/** Expand / open in main terminal (square with diagonal arrow) */
const IconExpand = ({ onClick }: { onClick?: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className="p-0.5 rounded hover:bg-white/10 cursor-pointer text-[#F0F0F0]"
    title="Show in main terminal"
  >
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  </button>
);

/** Kebab menu (three vertical dots) - closes card */
const IconKebab = ({ onClose }: { onClose?: () => void }) => (
  <button
    type="button"
    onClick={onClose}
    className="p-0.5 rounded hover:bg-white/10 cursor-pointer text-[#F0F0F0]"
    title="Close card"
  >
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
    </svg>
  </button>
);

/** Cancel (X) icon */
const IconCancel = ({ onClick }: { onClick?: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className="p-0.5 rounded hover:bg-white/10 cursor-pointer text-[#F0F0F0]"
    title="Cancel"
  >
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  </button>
);

/** Checkmark for success */
const IconCheck = () => (
  <svg className="w-4 h-4 shrink-0 text-[#F0F0F0]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
  </svg>
);

/** X for failed */
const IconFail = () => (
  <svg className="w-4 h-4 shrink-0 text-[#F0F0F0]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);

/** Spinner for running state */
const Spinner = () => (
  <svg className="w-4 h-4 animate-spin shrink-0 text-[#F0F0F0]" fill="none" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeDasharray="24 16" />
  </svg>
);

export default function MiniTerminal({ label, cmdName, fullCmd, output, failed = false, onShowInMainTerminal, onClose, onKill }: MiniTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<{ term: import("xterm").Terminal; dispose: () => void } | null>(null);
  const outputLengthRef = useRef(0);

  const headerSummary = shortCommand(fullCmd);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    (async () => {
      const { Terminal } = await import("xterm");
      const { FitAddon } = await import("xterm-addon-fit");

      const t = new Terminal({
        theme: {
          background: CARD_BG,
          foreground: TEXT,
          cursor: "transparent",
          black: CARD_BG,
          red: "#f44747",
          green: "#6a9955",
          yellow: "#dcdcaa",
          blue: PROMPT_BLUE,
          magenta: "#c586c0",
          cyan: "#4ec9b0",
          white: TEXT,
        },
        fontSize: 12,
        fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace",
        rows: 6,
        cols: 80,
        scrollback: 100,
        allowProposedApi: false,
        cursorBlink: false,
        cursorStyle: "block",
        convertEol: true,
      });

      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(container);
      fit.fit();

      const prompt = "\x1b[34m$\x1b[0m " + fullCmd + "\r\n";
      t.write(prompt);
      if (output.length > 0) {
        t.write(output);
        outputLengthRef.current = output.length;
      }

      if (disposed) {
        t.dispose();
        fit.dispose();
        return;
      }

      const ro = new ResizeObserver(() => fit.fit());
      ro.observe(container);

      terminalRef.current = {
        term: t,
        dispose() {
          ro.disconnect();
          fit.dispose();
          t.dispose();
        },
      };
      outputLengthRef.current = output.length;
    })();

    return () => {
      disposed = true;
      terminalRef.current?.dispose();
      terminalRef.current = null;
    };
  }, [fullCmd]);

  useEffect(() => {
    const handle = terminalRef.current;
    if (!handle || output.length <= outputLengthRef.current) return;
    const chunk = output.slice(outputLengthRef.current);
    outputLengthRef.current = output.length;
    handle.term.write(chunk);
  }, [output]);

  const isRunning = label === "Running";

  return (
    <div
      className="rounded-xl overflow-hidden my-1.5"
      style={{ backgroundColor: CARD_BG, boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }}
    >
      {/* Header: "Running command: cd, npm run" / "Ran command: cd, npm run" */}
      <div
        className="flex items-center justify-between gap-2 px-3 py-2.5 border-b min-h-[40px]"
        style={{ borderColor: BORDER }}
      >
        <span className="text-[13px] font-normal truncate" style={{ color: TEXT }}>
          {label} command: {headerSummary}
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          <IconExpand onClick={onShowInMainTerminal} />
          <IconKebab onClose={onClose} />
        </div>
      </div>

      {/* Terminal output block (indented feel via padding) */}
      <div
        ref={containerRef}
        className="mini-terminal-body w-full overflow-hidden pl-3 pr-2 py-2"
        style={{
          height: SIX_LINES_HEIGHT,
          backgroundColor: CARD_BG,
        }}
        data-mini-terminal
      />

      {/* Footer: running = "Shift+ Cancel" + icons; completed = checkmark + Success */}
      <div
        className="flex items-center justify-between gap-2 px-3 py-1.5 min-h-[28px] border-t"
        style={{ borderColor: BORDER, backgroundColor: CARD_BG }}
      >
        {isRunning ? (
          <>
            <span className="text-xs" style={{ color: TEXT_MUTED }}>
              Shift+ Cancel
            </span>
            <div className="flex items-center gap-0.5">
              <IconCancel
                onClick={() => {
                  onKill?.();
                  onClose?.();
                }}
              />
              <Spinner />
            </div>
          </>
        ) : (
          <span className="flex items-center gap-1.5 ml-auto text-[13px]" style={{ color: TEXT }}>
            {failed ? <IconFail /> : <IconCheck />}
            {failed ? "Failed" : "Success"}
          </span>
        )}
      </div>
    </div>
  );
}
