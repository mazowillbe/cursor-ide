import { useEffect, useRef, useState } from "react";
import { getFileDiff, readFile } from "../api/client";
import FileIcon from "./FileIcon";

/* Match App.jsx-style diff card: dark grey card, light blue pill, white filename, monospace code, desaturated red/green diff. */
const CARD_BG = "#1e1e1e";
const HEADER_BG = "#252526";
const CONTENT_BG = "#1e1e1e";
const PILL_BG = "#5DA9E9";
const PILL_FG = "#ffffff";
const FILENAME_COLOR = "#ffffff";
const DIFF_STAT_COLOR = "#9e9e9e";
const CODE_FG = "#ffffff";
const CODE_FONT = "Consolas, Menlo, 'Courier New', monospace";
const CODE_FONT_SIZE = "13px";
const DIFF_REMOVE_BG = "#4B2B33";
const DIFF_REMOVE_BORDER = "#CB5661";
const DIFF_ADD_BG = "#334B33";
const DIFF_ADD_BORDER = "#6ABE70";
const DIFF_STAT_ADD_COLOR = "#6ABE70";
const DIFF_STAT_REMOVE_COLOR = "#CB5661";

export interface MiniFileEditorProps {
  /** File path being edited or written */
  path: string;
  /** File content; when pending, this may grow over time (streamed live). */
  content: string;
  /** True when tool is still running (show spinner in header). */
  pending: boolean;
  /** Label in header: "Edit" or "Write" (default "Edit"). */
  label?: "Edit" | "Write";
  /** When set and content is empty, fetch git diff or file snippet as fallback. */
  workspaceId?: string;
  /** Called when user clicks close (remove this card). */
  onClose?: () => void;
  /** Called when user clicks "Open in editor" (Cursor-style: open file in main editor). */
  onOpenFile?: (path: string) => void;
}

const SPINNER = (
  <svg className="w-4 h-4 text-gray-500 animate-spin shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden>
    <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeDasharray="24 16" />
  </svg>
);

const SIX_LINES_HEIGHT = 108;

/** Interval (ms) between revealing the next 2–3 words when streaming. */
const STREAM_WORD_INTERVAL_MS = 100;
/** Number of words to reveal per tick when pending. */
const STREAM_WORDS_PER_TICK = 3;

/** Get the next 2–3 words from the start of a string (for typewriter effect). */
function takeNextWords(text: string, count: number): string {
  const leading = text.match(/^\s*/)?.[0] ?? "";
  const rest = text.slice(leading.length);
  const words = rest.split(/\s+/).filter(Boolean);
  const take = words.slice(0, Math.min(count, words.length));
  return leading + take.join(" ");
}

const MAX_SNIPPET_LINES = 80;
const MAX_SNIPPET_CHARS = 6000;

/** When edit content is missing, try git diff first, then file content snippet. */
function useFallbackContent(
  pending: boolean,
  workspaceId: string | undefined,
  pathTrimmed: string,
  hasAgentContent: boolean
): { gitDiff: string | null; fileSnippet: string | null } {
  const [gitDiff, setGitDiff] = useState<string | null>(null);
  const [fileSnippet, setFileSnippet] = useState<string | null>(null);

  useEffect(() => {
    if (pending || !workspaceId || !pathTrimmed || hasAgentContent) return;
    let cancelled = false;
    Promise.all([
      getFileDiff(workspaceId, pathTrimmed),
      readFile(workspaceId, pathTrimmed).then((r) => r.content).catch(() => ""),
    ]).then(([diff, fullContent]) => {
      if (cancelled) return;
      if (diff) setGitDiff(diff);
      else if (fullContent && fullContent.trim()) {
        const lines = fullContent.split(/\r?\n/);
        const snippet =
          lines.length <= MAX_SNIPPET_LINES && fullContent.length <= MAX_SNIPPET_CHARS
            ? fullContent
            : lines.slice(0, MAX_SNIPPET_LINES).join("\n") +
              (lines.length > MAX_SNIPPET_LINES ? "\n…" : "");
        setFileSnippet(snippet.trim() || null);
      }
    });
    return () => { cancelled = true; };
  }, [pending, workspaceId, pathTrimmed, hasAgentContent]);

  return { gitDiff, fileSnippet };
}

/** Parse content as unified diff or plain; return { lines: { type: 'add'|'remove'|'context', text }[], addCount, removeCount }. */
function parseDiffOrPlain(content: string): {
  lines: { type: "add" | "remove" | "context"; text: string }[];
  addCount: number;
  removeCount: number;
} {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  const result: { type: "add" | "remove" | "context"; text: string }[] = [];
  let addCount = 0;
  let removeCount = 0;
  const hasDiffMarkers = lines.some(
    (l) => (l.startsWith("-") && !l.startsWith("---")) || (l.startsWith("+") && !l.startsWith("+++")) || l.startsWith(" +")
  );
  if (!hasDiffMarkers) {
    lines.forEach((l) => {
      result.push({ type: "context", text: l });
    });
    return { lines: result, addCount: 0, removeCount: 0 };
  }
  lines.forEach((line) => {
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@")) {
      result.push({ type: "context", text: line });
      return;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      removeCount += 1;
      result.push({ type: "remove", text: line.slice(1).replace(/\r$/, "") });
      return;
    }
    if (line.startsWith(" +")) {
      addCount += 1;
      result.push({ type: "add", text: line.slice(2).replace(/\r$/, "") });
      return;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      addCount += 1;
      result.push({ type: "add", text: line.slice(1).replace(/\r$/, "") });
      return;
    }
    result.push({ type: "context", text: line });
  });
  return { lines: result, addCount, removeCount };
}

export default function MiniFileEditor({ path, content, pending, label = "Edit", workspaceId, onClose, onOpenFile }: MiniFileEditorProps) {
  const pathTrimmed = path.trim();
  const preRef = useRef<HTMLPreElement>(null);
  const prevLenRef = useRef(0);

  const contentRef = useRef(content);
  contentRef.current = content;

  const [displayedContent, setDisplayedContent] = useState("");

  useEffect(() => {
    if (!pending) setDisplayedContent(content);
  }, [pending, content]);

  useEffect(() => {
    if (!pending) return;
    setDisplayedContent("");
    const id = setInterval(() => {
      const target = contentRef.current;
      setDisplayedContent((prev) => {
        if (target.length <= prev.length) return prev;
        const remainder = target.slice(prev.length);
        const chunk = takeNextWords(remainder, STREAM_WORDS_PER_TICK);
        if (!chunk) return prev;
        return prev + chunk;
      });
    }, STREAM_WORD_INTERVAL_MS);
    return () => clearInterval(id);
  }, [pending]);

  const streamedContent = pending ? displayedContent : content;
  const displayContent = streamedContent || (pending ? "…" : "");
  const isSuccessOnlyMessage = /^(edit|write)\s+applied\s+successfully\.?$/i.test(displayContent.trim()) || /^done\.?$/i.test(displayContent.trim());
  const effectiveContent = isSuccessOnlyMessage ? "" : displayContent;
  const hasAgentContent = effectiveContent.length > 0;

  const { gitDiff: gitDiffFallback, fileSnippet: fileSnippetFallback } = useFallbackContent(
    pending,
    workspaceId,
    pathTrimmed,
    hasAgentContent
  );

  const contentToShow = effectiveContent || gitDiffFallback || fileSnippetFallback || "";
  const { lines: diffLines, addCount, removeCount } = parseDiffOrPlain(contentToShow);
  const hasDiff = addCount > 0 || removeCount > 0;
  const showSnippetLabel = !effectiveContent && !gitDiffFallback && fileSnippetFallback != null;
  const showEmptyMessage = !effectiveContent && !gitDiffFallback && !fileSnippetFallback && !pending;

  useEffect(() => {
    const len = pending ? streamedContent.length : content.length;
    if (len > prevLenRef.current && preRef.current) {
      prevLenRef.current = len;
      preRef.current.scrollTop = preRef.current.scrollHeight;
    } else if (len <= prevLenRef.current) {
      prevLenRef.current = len;
    }
  }, [pending, streamedContent.length, content.length]);
  const diffSummary =
    !pending ? (
      <span className="tabular-nums shrink-0" style={{ fontSize: "12px", fontWeight: 400, marginLeft: 6 }}>
        <span style={{ color: DIFF_STAT_ADD_COLOR }}>+{addCount}</span>
        {" "}
        <span style={{ color: DIFF_STAT_REMOVE_COLOR }}>-{removeCount}</span>
      </span>
    ) : null;

  const basename = pathTrimmed.split(/[/\\]/).pop() || pathTrimmed;

  return (
    <div
      className="overflow-hidden my-1.5"
      style={{
        backgroundColor: CARD_BG,
        border: "1px solid #3c3c3c",
        borderRadius: 6,
        boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
      }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 min-h-[40px] border-b border-[#3c3c3c]"
        style={{ backgroundColor: HEADER_BG }}
      >
        {pending && SPINNER}
        <FileIcon path={pathTrimmed} size={18} className="shrink-0" />
        <span
          className="truncate min-w-0"
          style={{
            color: FILENAME_COLOR,
            fontSize: "13px",
            fontFamily: "Segoe UI, Inter, system-ui, sans-serif",
          }}
          title={pathTrimmed}
        >
          {basename}
        </span>
        {diffSummary != null && diffSummary}
      </div>
      <div
        className="w-full overflow-auto overflow-x-auto overflow-y-auto hide-scrollbar-mini-editor"
        style={{
          height: SIX_LINES_HEIGHT,
          backgroundColor: CONTENT_BG,
          maxHeight: 200,
          scrollbarWidth: "none",
          msOverflowStyle: "none",
        }}
      >
        <pre
          ref={preRef}
          className="p-3 whitespace-pre-wrap break-words m-0 block"
          style={{
            color: CODE_FG,
            fontFamily: CODE_FONT,
            fontSize: CODE_FONT_SIZE,
            minHeight: SIX_LINES_HEIGHT,
            lineHeight: 1.5,
          }}
        >
          {hasDiff
            ? diffLines.map((l, i) => (
                <span
                  key={i}
                  className="block pl-2 border-l-4"
                  style={
                    l.type === "remove"
                      ? {
                          backgroundColor: DIFF_REMOVE_BG,
                          borderLeftColor: DIFF_REMOVE_BORDER,
                          color: CODE_FG,
                          fontFamily: CODE_FONT,
                          fontSize: CODE_FONT_SIZE,
                        }
                      : l.type === "add"
                        ? {
                            backgroundColor: DIFF_ADD_BG,
                            borderLeftColor: DIFF_ADD_BORDER,
                            color: CODE_FG,
                            fontFamily: CODE_FONT,
                            fontSize: CODE_FONT_SIZE,
                          }
                        : {
                            fontFamily: CODE_FONT,
                            fontSize: CODE_FONT_SIZE,
                            color: CODE_FG,
                          }
                  }
                >
                  {l.text || " "}
                  {"\n"}
                </span>
              ))
            : contentToShow ? (
                <span className="block pl-2" style={{ fontFamily: CODE_FONT, fontSize: CODE_FONT_SIZE, color: CODE_FG }}>
                  {showSnippetLabel && (
                    <span className="block mb-1" style={{ color: "#858585", fontStyle: "italic", fontSize: "12px" }}>
                      Code snippet (file content):
                    </span>
                  )}
                  {contentToShow}
                </span>
              ) : showEmptyMessage ? (
                <span
                  className="block pl-2"
                  style={{ color: "#858585", fontStyle: "italic", fontSize: "12px", fontFamily: CODE_FONT }}
                >
                  No diff content — edit was applied but the change snippet wasn’t captured (stream/parse limit).
                  {workspaceId && " Init git in this workspace to see diffs here."}
                </span>
              ) : null}
        </pre>
      </div>
    </div>
  );
}
