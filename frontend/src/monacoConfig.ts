/**
 * Configure Monaco before it loads. Must run before any Editor mounts.
 * Disables TS/JS diagnostics since Monaco only sees one file at a time
 * and can't resolve imports like ./lib/supabase.
 * Defines cursor-dark theme so it's available for all editors (including mini).
 */
import loader from "@monaco-editor/loader";
import * as monaco from "monaco-editor";
import { defineCursorDarkTheme } from "./lib/monacoTheme";

const ts = (monaco as unknown as { languages: { typescript?: { typescriptDefaults: { setDiagnosticsOptions: (o: object) => void }; javascriptDefaults: { setDiagnosticsOptions: (o: object) => void } } } }).languages.typescript;
if (ts) {
  ts.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });
  ts.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });
}

defineCursorDarkTheme(monaco);
loader.config({ monaco });
