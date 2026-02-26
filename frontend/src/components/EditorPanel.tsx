import { useState, useCallback, useEffect, useRef } from "react";
import Editor, { type OnMount, type BeforeMount } from "@monaco-editor/react";
import { readFile, writeFile, getFileDiff } from "../api/client";
import type * as Monaco from "monaco-editor";
import FileIcon from "./FileIcon";

/** Cursor IDE dark theme: blue keywords, cyan types, orange strings, yellow functions. */
function defineCursorDarkTheme(monaco: typeof Monaco): void {
  const keywordBlue = "#569CD6";
  const typeCyan = "#4EC9B0";
  const variableLightBlue = "#9CDCFE";
  const stringOrange = "#CE9178";
  const functionYellow = "#DCDCAA";
  const white = "#D4D4D4";
  const commentGreen = "#6A9955";
  const numberGreen = "#B5CEA8";

  monaco.editor.defineTheme("cursor-dark", {
    base: "vs-dark",
    inherit: false,
    rules: [
      { token: "", foreground: white },
      { token: "keyword", foreground: keywordBlue },
      { token: "keyword.control", foreground: keywordBlue },
      { token: "keyword.operator", foreground: white },
      { token: "storage", foreground: keywordBlue },
      { token: "storage.type", foreground: keywordBlue },

      { token: "string", foreground: stringOrange },
      { token: "string.escape", foreground: "#D7BA7D" },

      { token: "comment", foreground: commentGreen },
      { token: "comment.doc", foreground: commentGreen },

      { token: "number", foreground: numberGreen },
      { token: "constant.numeric", foreground: numberGreen },

      { token: "type", foreground: typeCyan },
      { token: "type.identifier", foreground: typeCyan },
      { token: "class", foreground: typeCyan },
      { token: "support.class", foreground: typeCyan },
      { token: "entity.name.type", foreground: typeCyan },

      { token: "function", foreground: functionYellow },
      { token: "support.function", foreground: functionYellow },
      { token: "entity.name.function", foreground: functionYellow },

      { token: "variable", foreground: variableLightBlue },
      { token: "variable.parameter", foreground: variableLightBlue },
      { token: "variable.other", foreground: variableLightBlue },

      { token: "constant", foreground: variableLightBlue },
      { token: "support.constant", foreground: variableLightBlue },
      { token: "constant.language", foreground: keywordBlue },

      { token: "tag", foreground: keywordBlue },
      { token: "attribute.name", foreground: variableLightBlue },

      { token: "delimiter", foreground: white },
      { token: "delimiter.bracket", foreground: white },
      { token: "identifier", foreground: white },
      { token: "operator", foreground: white },
    ],
    colors: {
      "editor.background": "#1E1E1E",
      "editor.foreground": "#D4D4D4",
      "editor.lineHighlightBackground": "#2D2D2D",
      "editor.lineHighlightBorder": "#2D2D2D",
      "editorLineNumber.foreground": "#858585",
      "editorLineNumber.activeForeground": "#C6C6C6",
    },
  });
  monaco.editor.setTheme("cursor-dark");
}

interface EditorPanelProps {
  workspaceId: string;
  openFilePaths: string[];
  activeFilePath: string | null;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
}

/** Parse unified diff and return 1-based line numbers in the new file for added/modified lines. */
function parseDiffForNewFileLines(diff: string): { added: number[]; modified: number[] } {
  const added: number[] = [];
  const modified: number[] = [];
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  let newLineNum = 0;
  let prevWasRemoval = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("@@ ")) {
      const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) newLineNum = parseInt(m[1]!, 10);
      prevWasRemoval = false;
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+") && !line.startsWith("++")) {
      if (prevWasRemoval) modified.push(newLineNum);
      else added.push(newLineNum);
      newLineNum++;
      prevWasRemoval = false;
    } else if (line.startsWith("-") && !line.startsWith("--")) {
      prevWasRemoval = true;
    } else {
      newLineNum++;
      prevWasRemoval = false;
    }
  }
  return { added, modified };
}

function inferLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    json: "json",
    html: "html",
    css: "css",
    md: "markdown",
    py: "python",
  };
  return map[ext ?? ""] ?? "plaintext";
}

function basename(path: string): string {
  return path.replace(/^.*[/\\]/, "");
}

export default function EditorPanel({
  workspaceId,
  openFilePaths,
  activeFilePath,
  onSelectTab,
  onCloseTab,
}: EditorPanelProps) {
  const [contentByPath, setContentByPath] = useState<Record<string, string>>({});
  const [dirtyByPath, setDirtyByPath] = useState<Record<string, boolean>>({});
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<string[]>([]);
  const themeDefinedRef = useRef(false);

  const loadFile = useCallback(
    async (path: string) => {
      setLoadingPath(path);
      setError(null);
      try {
        const { content: text } = await readFile(workspaceId, path);
        setContentByPath((prev) => ({ ...prev, [path]: text }));
        setDirtyByPath((prev) => ({ ...prev, [path]: false }));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
        setContentByPath((prev) => ({ ...prev, [path]: "" }));
      } finally {
        setLoadingPath(null);
      }
    },
    [workspaceId]
  );

  useEffect(() => {
    if (activeFilePath && !(activeFilePath in contentByPath)) loadFile(activeFilePath);
  }, [activeFilePath, contentByPath, loadFile]);

  const content = activeFilePath ? contentByPath[activeFilePath] ?? "" : "";
  const dirty = activeFilePath ? dirtyByPath[activeFilePath] ?? false : false;

  const handleEditorChange = useCallback((value: string | undefined, path: string) => {
    setContentByPath((prev) => ({ ...prev, [path]: value ?? "" }));
    setDirtyByPath((prev) => ({ ...prev, [path]: true }));
  }, []);

  const handleSave = useCallback(
    async (path: string) => {
      const c = contentByPath[path];
      if (c === undefined || !dirtyByPath[path]) return;
      setError(null);
      try {
        await writeFile(workspaceId, path, c);
        setDirtyByPath((prev) => ({ ...prev, [path]: false }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to save";
        setError(msg);
        console.error("[Editor] Save failed:", msg);
      }
    },
    [workspaceId, contentByPath, dirtyByPath]
  );

  const saveActive = useCallback(() => {
    if (activeFilePath) handleSave(activeFilePath);
  }, [activeFilePath, handleSave]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        saveActive();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveActive]);

  const applyGitDecorations = useCallback(
    (editor: Monaco.editor.IStandaloneCodeEditor, path: string) => {
      getFileDiff(workspaceId, path)
        .then((diff) => {
          if (!diff || !editor.getModel()) return;
          const { added, modified } = parseDiffForNewFileLines(diff);
          const deco: Monaco.editor.IModelDeltaDecoration[] = [];
          const addLineDeco = (lineNum: number, className: string, overviewColor: string) => {
            deco.push({
              range: { startLineNumber: lineNum, startColumn: 1, endLineNumber: lineNum, endColumn: 1 },
              options: {
                isWholeLine: true,
                linesDecorationsClassName: className,
                marginClassName: className,
                overviewRuler: { color: overviewColor, position: 4 },
              },
            });
          };
          added.forEach((n) => addLineDeco(n, "git-line-added", "rgba(78, 201, 176, 0.8)"));
          modified.forEach((n) => addLineDeco(n, "git-line-modified", "rgba(220, 220, 170, 0.8)"));
          decorationsRef.current = editor.deltaDecorations(decorationsRef.current, deco);
        })
        .catch(() => {});
    },
    [workspaceId]
  );

  const handleBeforeMount: BeforeMount = useCallback((monaco) => {
    defineCursorDarkTheme(monaco);
    themeDefinedRef.current = true;
  }, []);

  const handleEditorMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
  
      defineCursorDarkTheme(monaco);
      monaco.editor.setTheme("cursor-dark");
      requestAnimationFrame(() => {
        monaco.editor.setTheme("cursor-dark");
      });
  
      if (activeFilePath) applyGitDecorations(editor, activeFilePath);
  
      editor.updateOptions({
        scrollbar: {
          verticalScrollbarSize: 6,
          horizontalScrollbarSize: 6,
          useShadows: false,
        },
        folding: true,
        showFoldingControls: "mouseover",
        renderLineHighlight: "all",
        minimap: { enabled: true, size: "proportional" },
      });
    },
    [activeFilePath, applyGitDecorations]
  );

  useEffect(() => {
    const ed = editorRef.current;
    if (ed && activeFilePath) applyGitDecorations(ed, activeFilePath);
  }, [activeFilePath, content, applyGitDecorations]);

  const hasTabs = openFilePaths.length > 0;

  return (
    <div className="h-full flex flex-col bg-[#1A1A1A]">
      <div className="flex-shrink-0 flex items-center bg-[#1A1A1A] min-h-[35px]">
        <div className="flex items-center min-w-0 flex-1 overflow-x-auto hide-scrollbar-mini-editor">
          {openFilePaths.map((path) => {
            const isActive = path === activeFilePath;
            const isDirty = dirtyByPath[path];
            const name = basename(path);
            return (
              <div
                key={path}
                role="button"
                tabIndex={0}
                onClick={() => onSelectTab(path)}
                onKeyDown={(e) => e.key === "Enter" && onSelectTab(path)}
                className={
                  isActive
                    ? "flex items-center gap-1.5 pl-3 pr-1 py-1.5 border-r border-[#3c3c3c] shrink-0 cursor-pointer bg-[#1e1e1e] text-gray-200 border-b-2 border-b-transparent -mb-px"
                    : "flex items-center gap-1.5 pl-3 pr-1 py-1.5 border-r border-b border-[#3c3c3c] shrink-0 cursor-pointer text-gray-400 hover:bg-[#252525] hover:text-gray-200"
                }
              >
                <FileIcon path={path} size={16} className="shrink-0" title={path} />
                <span className="truncate max-w-[120px] text-sm">{name}</span>
                {isDirty && <span className="w-2 h-2 rounded-full bg-gray-400" title="Unsaved" />}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(path);
                  }}
                  className="p-0.5 rounded hover:bg-[#3c3c3c] text-gray-400 hover:text-gray-200"
                  aria-label="Close tab"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        {hasTabs && activeFilePath && (
          <div className="flex-shrink-0 flex items-center gap-2 px-3 border-l border-[#3c3c3c]">
            <button
              type="button"
              onClick={saveActive}
              disabled={!dirty}
              className="px-3 py-1.5 rounded text-sm font-medium bg-[#0e639c] text-white disabled:opacity-50 disabled:cursor-not-allowed hover:enabled:bg-[#1177bb]"
            >
              Save
            </button>
          </div>
        )}
      </div>
      {activeFilePath && (
        <div className="flex-shrink-0 flex items-center gap-1 px-3 py-1.5 bg-[#1e1e1e] text-sm text-gray-400 font-mono overflow-x-auto hide-scrollbar-mini-editor">
          {activeFilePath.split(/[/\\]/).filter(Boolean).map((segment, i, parts) => {
            const isLast = i === parts.length - 1;
            return (
              <span key={i} className="flex items-center gap-1 shrink-0">
                {i > 0 && <span className="text-gray-500 mx-0.5" aria-hidden>&gt;</span>}
                {isLast ? (
                  <>
                    <FileIcon path={activeFilePath} size={14} className="shrink-0" />
                    <span className="text-gray-400">{segment}</span>
                  </>
                ) : (
                  <span className="text-gray-500">{segment}</span>
                )}
              </span>
            );
          })}
        </div>
      )}
      <div className="flex-1 min-h-0">
        {error && <div className="px-3 py-2 text-red-400 text-sm bg-[#1A1A1A]">{error}</div>}
        {!hasTabs ? (
          <div className="flex items-center justify-center h-full text-gray-500 bg-[#1A1A1A]">
            No file open — select a file from the explorer or chat.
          </div>
        ) : activeFilePath && loadingPath === activeFilePath ? (
          <div className="flex items-center justify-center h-full text-gray-500 bg-[#1A1A1A]">
            Loading…
          </div>
        ) : (
          <Editor
            key={activeFilePath ?? "empty"}
            height="100%"
            defaultLanguage="javascript"
            language={activeFilePath ? inferLanguage(activeFilePath) : "plaintext"}
            value={content}
            onChange={(value) => activeFilePath && handleEditorChange(value, activeFilePath)}
            beforeMount={handleBeforeMount}
            onMount={handleEditorMount}
            options={{
              minimap: { enabled: true, size: "proportional" },
              fontFamily: "Consolas, Monaco, 'Courier New', monospace",
              fontSize: 14,
              wordWrap: "on",
              automaticLayout: true,
              scrollbar: {
                verticalScrollbarSize: 6,
                horizontalScrollbarSize: 6,
                useShadows: false,
              },
              showUnused: false,
              folding: true,
              showFoldingControls: "mouseover",
              renderLineHighlight: "all",
              lineNumbers: "on",
              glyphMargin: true,
              overviewRulerLanes: 3,
              overviewRulerBorder: true,
            }}
          />
        )}
      </div>
      <style>{`
        .git-line-added { background: rgba(52, 75, 51, 0.45); }
        .git-line-added::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: #6ABE70; }
        .git-line-modified { background: rgba(75, 43, 51, 0.45); }
        .git-line-modified::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: #CB5661; }
      `}</style>
    </div>
  );
}
