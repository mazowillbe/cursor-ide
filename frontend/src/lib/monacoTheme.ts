import type * as Monaco from "monaco-editor";

/** Matches useState setter names (setX convention) - these are variables but should be orange. */
export const SETTER_PATTERN = /\bset[A-Z][a-zA-Z0-9]*\b/g;
/** Matches type alias, interface, and function declaration names. */
export const TYPE_ALIAS_PATTERN = /\btype\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
export const INTERFACE_PATTERN = /\binterface\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
export const FUNCTION_PATTERN = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g;

/** Cursor IDE dark theme: keywords light cyan #4EC9B0, strings dark pink #C586C0, identifiers #9CDCFE. */
export function defineCursorDarkTheme(monaco: typeof Monaco): void {
  const keywordCyan = "4EC9B0";
  const identifierLightBlue = "9CDCFE";
  const identifierOrange = "F0A060";
  const stringDarkPink = "C586C0";
  const numberGreen = "B5CEA8";
  const white = "D4D4D4";
  const commentGreen = "6A9955";

  const suffixes = ["", ".ts", ".tsx", ".js", ".jsx"];
  const rule = (token: string, foreground: string, fontStyle?: string) =>
    suffixes.map((s) => ({ token: token + s, foreground, fontStyle }));
  const rules: { token: string; foreground: string; fontStyle?: string }[] = [
    ...rule("keyword", keywordCyan),
    ...rule("keyword.control", keywordCyan),
    ...rule("storage", keywordCyan),
    ...rule("storage.type", keywordCyan),
    ...rule("constant", numberGreen),
    ...rule("constant.language", numberGreen),
    ...rule("string", stringDarkPink),
    ...rule("string.escape", stringDarkPink),
    ...rule("comment", commentGreen),
    ...rule("comment.doc", commentGreen),
    ...rule("number", numberGreen),
    ...rule("number.float", numberGreen),
    ...rule("number.hex", numberGreen),
    ...rule("number.octal", numberGreen),
    ...rule("number.binary", numberGreen),
    ...rule("type", identifierLightBlue),
    ...rule("type.identifier", identifierLightBlue),
    ...rule("identifier", identifierLightBlue),
    ...rule("identifier.function", identifierLightBlue),
    { token: "class", foreground: identifierOrange },
    { token: "interface", foreground: identifierOrange },
    { token: "type", foreground: identifierOrange },
    { token: "typeParameter", foreground: identifierOrange },
    { token: "enum", foreground: identifierOrange },
    { token: "function", foreground: identifierOrange },
    { token: "method", foreground: identifierOrange },
    { token: "constructor", foreground: identifierOrange },
    { token: "variable", foreground: identifierLightBlue },
    { token: "property", foreground: identifierLightBlue },
    { token: "namespace", foreground: identifierLightBlue },
    { token: "enumMember", foreground: identifierLightBlue },
    { token: "parameter", foreground: identifierLightBlue },
    ...rule("delimiter", white),
    ...rule("delimiter.bracket", white),
    ...rule("regexp", stringDarkPink),
    ...rule("regexp.escape", stringDarkPink),
    { token: "", foreground: white },
  ];

  monaco.editor.defineTheme("cursor-dark", {
    base: "vs-dark",
    inherit: true,
    rules,
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

/** Decorate type aliases, interfaces, function names, and useState setters with light orange. */
export function applyOrangeDecorations(
  editor: Monaco.editor.IStandaloneCodeEditor,
  decorationsRef: { current: string[] }
): void {
  const model = editor.getModel();
  if (!model) return;
  const text = model.getValue();
  const deco: Monaco.editor.IModelDeltaDecoration[] = [];
  const lines = text.split(/\r?\n/);
  const addMatch = (m: RegExpExecArray, lineNum: number, groupIndex: number) => {
    const name = m[groupIndex];
    if (!name) return;
    const startCol = m.index + (m[0].indexOf(name) ?? 0) + 1;
    deco.push({
      range: {
        startLineNumber: lineNum,
        startColumn: startCol,
        endLineNumber: lineNum,
        endColumn: startCol + name.length,
      },
      options: { inlineClassName: "identifier-orange" },
    });
  };
  for (let lineNum = 1; lineNum <= lines.length; lineNum++) {
    const line = lines[lineNum - 1] ?? "";
    let m: RegExpExecArray | null;
    SETTER_PATTERN.lastIndex = 0;
    while ((m = SETTER_PATTERN.exec(line)) !== null) {
      deco.push({
        range: {
          startLineNumber: lineNum,
          startColumn: (m.index ?? 0) + 1,
          endLineNumber: lineNum,
          endColumn: (m.index ?? 0) + (m[0]?.length ?? 0) + 1,
        },
        options: { inlineClassName: "identifier-orange" },
      });
    }
    TYPE_ALIAS_PATTERN.lastIndex = 0;
    while ((m = TYPE_ALIAS_PATTERN.exec(line)) !== null) {
      addMatch(m, lineNum, 1);
    }
    INTERFACE_PATTERN.lastIndex = 0;
    while ((m = INTERFACE_PATTERN.exec(line)) !== null) {
      addMatch(m, lineNum, 1);
    }
    FUNCTION_PATTERN.lastIndex = 0;
    while ((m = FUNCTION_PATTERN.exec(line)) !== null) {
      addMatch(m, lineNum, 1);
    }
  }
  decorationsRef.current = editor.deltaDecorations(decorationsRef.current, deco);
}

export const MONACO_EDITOR_OPTIONS = {
  fontFamily: "'Cascadia Code', Consolas, Monaco, 'Courier New', monospace",
  fontSize: 14,
  "semanticHighlighting.enabled": false,
  minimap: { enabled: false },
  lineNumbers: "off" as const,
  scrollBeyondLastLine: false,
  readOnly: true,
  folding: false,
  renderLineHighlight: "none" as const,
  scrollbar: {
    verticalScrollbarSize: 6,
    horizontalScrollbarSize: 6,
    useShadows: false,
  },
};
