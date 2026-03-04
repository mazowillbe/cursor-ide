import { useEffect, useRef } from "react";
import "xterm/css/xterm.css";

/** Chat/sidebar background; header, footer and terminal body match. Border matches former card bg. */
const CHAT_BG = "#1A1A1A";
const EXPLORER_BG = "#1A1A1A";
const CARD_BORDER = "#2D2D30";
const TEXT = "#F0F0F0";
const TEXT_MUTED = "#858585";
const PROMPT_BLUE = "#569CD6";
const COMMAND_WHITE = "#FFFFFF";
const OUTPUT_LIGHT_GREY = "#b0b0b0";

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
  /** True when user clicked close (X) — card stays visible but footer shows "Aborted". */
  aborted?: boolean;
  /** Called when user clicks "show in main terminal"; receives the full command to run in the main terminal. */
  onShowInMainTerminal?: (command: string) => void;
  /** Called when user clicks close (card remains; footer shows Aborted). */
  onClose?: () => void;
  /** Called when user clicks X to kill the running process (then onClose is also called). */
  onKill?: () => void;
}

/** Line height in px (match xterm fontSize 12 + padding). */
const LINE_HEIGHT_PX = 18;
/** Max height for 6 lines; beyond this the body scrolls. */
const SIX_LINES_HEIGHT = LINE_HEIGHT_PX * 6;

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

/** Stop icon for aborted */
const IconAborted = () => (
  <svg className="w-4 h-4 shrink-0 text-[#F0F0F0]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 6h12v12H6z" />
  </svg>
);

/** Spinner for running state */
const Spinner = () => (
  <svg className="w-4 h-4 animate-spin shrink-0 text-[#F0F0F0]" fill="none" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeDasharray="24 16" />
  </svg>
);

/** Number of lines in prompt + output (command line counts as 1, then each \\n in output). */
function countLines(_fullCmd: string, output: string): number {
  const cmdLine = 1;
  const outputLines = output ? output.split(/\r?\n/).length : 0;
  return cmdLine + outputLines;
}

export default function MiniTerminal({ label, cmdName: _cmdName, fullCmd, output, failed = false, aborted = false, onShowInMainTerminal, onClose, onKill }: MiniTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<{ term: import("xterm").Terminal; dispose: () => void } | null>(null);
  const outputLengthRef = useRef(0);

  const headerSummary = shortCommand(fullCmd);
  const totalLines = countLines(fullCmd, output);
  const visibleLines = Math.min(Math.max(totalLines, 1), 6);
  const bodyHeight = visibleLines * LINE_HEIGHT_PX;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    (async () => {
      const { Terminal } = await import("xterm");
      const { FitAddon } = await import("xterm-addon-fit");

      const t = new Terminal({
        theme: {
          background: EXPLORER_BG,
          foreground: OUTPUT_LIGHT_GREY,
          cursor: "transparent",
          black: EXPLORER_BG,
          red: "#f44747",
          green: "#6a9955",
          yellow: "#dcdcaa",
          blue: PROMPT_BLUE,
          magenta: "#c586c0",
          cyan: "#4ec9b0",
          white: COMMAND_WHITE,
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

      // $ = blue, space after $ = light pink, command = white; output uses theme.foreground (light grey)
      const pink = "\x1b[38;2;232;180;184m";
      const white = "\x1b[37m";
      const prompt = "\x1b[34m$\x1b[0m" + pink + " \x1b[0m" + white + fullCmd + "\x1b[0m\r\n";
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

      const ro = new ResizeObserver(() => safeFit());
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

  const isRunning = label === "Running" && !aborted;

  return (
    <div
      className="rounded-xl overflow-hidden my-1.5 border-2"
      style={{ backgroundColor: CHAT_BG, borderColor: CARD_BORDER, boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }}
    >
      {/* Header: "Running command: cd, npm run" / "Ran command: cd, npm run" */}
      <div
        className="flex items-center justify-between gap-2 px-3 py-2.5 border-b min-h-[40px]"
        style={{ borderColor: CARD_BORDER, backgroundColor: CHAT_BG }}
      >
        <span className="text-[13px] font-normal truncate" style={{ color: TEXT }}>
          {label} command: {headerSummary}
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          {onShowInMainTerminal && <IconExpand onClick={() => onShowInMainTerminal(fullCmd)} />}
          {!aborted && <IconKebab onClose={onClose} />}
        </div>
      </div>

      {/* Terminal output block: grows with streamed output up to 6 lines, then scrollable */}
      <div
        ref={containerRef}
        className="mini-terminal-body w-full pl-3 pr-4 py-2"
        style={{
          minHeight: LINE_HEIGHT_PX,
          height: bodyHeight,
          maxHeight: SIX_LINES_HEIGHT,
          overflow: "hidden",
          backgroundColor: EXPLORER_BG,
        }}
        data-mini-terminal
      />

      {/* Footer: running = "Shift+ Cancel" + icons; completed = checkmark + Success; aborted = Aborted */}
      <div
        className="flex items-center justify-between gap-2 px-3 py-1.5 min-h-[28px] border-t"
        style={{ borderColor: CARD_BORDER, backgroundColor: CHAT_BG }}
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
        ) : aborted ? (
          <span className="flex items-center gap-1.5 ml-auto text-[13px]" style={{ color: TEXT }}>
            <IconAborted />
            Aborted
          </span>
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
