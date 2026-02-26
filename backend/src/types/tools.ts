/**
 * Shared types for the custom tool interface and agent loop.
 * All tool execution goes through the tool router; no direct OS/spawn outside it.
 */

export type WorkspaceId = string;

/** Normalized tool name (our frontend/API names). */
export type ToolName =
  | "read_file"
  | "run_terminal_cmd"
  | "list_dir"
  | "grep_search"
  | "edit_file"
  | "search_replace"
  | "file_search"
  | "delete_file"
  | "read_lints"
  | "codebase_search"
  | "web_search"
  | "create_diagram"
  | "edit_notebook"
  | "reapply"
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "grep"
  | "glob"
  | "list";

/** A single tool invocation from the agent stream or API. */
export interface ToolCall {
  callId: string;
  tool: ToolName | string;
  args: Record<string, unknown>;
  /** Original raw tool name from stream (e.g. run_terminal_cmd, read_file). */
  rawTool?: string;
}

/** Structured result for one tool execution. */
export interface ToolResult {
  callId: string;
  tool: ToolName | string;
  success: boolean;
  /** Combined stdout/stderr or content. */
  output?: string;
  /** When success is false. */
  error?: string;
  /** For run_terminal_cmd. */
  exitCode?: number;
  /** For read_file: 1-based start/end line actually read (inclusive). */
  startLine?: number;
  endLine?: number;
  /** Optional structured payload (e.g. read_lints: { errorCount, summary }). */
  payload?: Record<string, unknown>;
}

/** Options when executing a tool (e.g. for streaming run_terminal_cmd to the UI). */
export interface ExecuteToolOptions {
  /** Stream chunks for run_terminal_cmd; called in addition to collecting output. */
  onStream?: (callId: string, chunk: string) => void;
  /** Called when run_terminal_cmd ends. */
  onStreamEnd?: (callId: string, exitCode: number | null) => void;
  /** Called when run_terminal_cmd process is spawned; pass kill so the client can request abort. */
  onSpawn?: (callId: string, kill: () => void) => void;
}

/** Result of executing multiple tools in parallel. */
export interface BatchToolResult {
  results: ToolResult[];
  /** Any callIds that failed to execute (e.g. unknown tool). */
  errors: { callId: string; error: string }[];
}
