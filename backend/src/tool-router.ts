/**
 * Tool router: single entry point for all tool execution.
 * No direct OS tool execution outside this module; run_terminal_cmd uses workspace.runCommandStream.
 * Supports parallel execution and optional streaming for bash.
 */

import path from "path";
import fs from "fs/promises";
import {
  getWorkspacePath,
  readFile,
  writeFile,
  listWorkspaceFiles,
  deletePath,
  runCommandStream,
  type WorkspaceId,
} from "./workspace.js";
import {
  isDevServerCommand,
  killExistingDevServer,
  registerDevServerProcess,
  unregisterDevServerProcess,
} from "./dev-server-manager.js";
import { reapplyEditWithModel } from "./reapply-agent.js";
import { applyEditWithModel, stripCodeFences } from "./apply-edit-agent.js";
import { getLastEdit, setLastEdit } from "./last-edit-store.js";
import type { ToolCall, ToolResult, ExecuteToolOptions, BatchToolResult } from "./types/tools.js";

const LOG_PREFIX = "[tool-router]";

/** Normalize stream/API tool name to our canonical handler name. */
function normalizeToolName(raw: string): string {
  const map: Record<string, string> = {
    run_terminal_cmd: "run_terminal_cmd",
    bash: "run_terminal_cmd",
    read_file: "read_file",
    read: "read_file",
    list_dir: "list_dir",
    list: "list_dir",
    grep_search: "grep_search",
    grep: "grep_search",
    edit_file: "edit_file",
    write_file: "edit_file",
    edit: "edit_file",
    write: "edit_file",
    search_replace: "search_replace",
    file_search: "file_search",
    glob: "file_search",
    delete_file: "delete_file",
    reapply: "reapply",
    codebase_search: "codebase_search",
    web_search: "web_search",
    create_diagram: "create_diagram",
    edit_notebook: "edit_notebook",
  };
  return map[raw] ?? raw;
}

/** Recursively list relative file paths under dir (relative to workspace). */
async function listFilesRecursive(workspaceId: WorkspaceId, dir: string): Promise<string[]> {
  const base = getWorkspacePath(workspaceId);
  const target = path.join(base, path.normalize(dir));
  if (!target.startsWith(base)) return [];
  const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const rel = path.join(dir, e.name).replace(/\\/g, "/");
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      out.push(...(await listFilesRecursive(workspaceId, rel)));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/** Simple glob: pattern like "*.ts" or "src/**" -> match relative paths. */
function matchGlob(relativePath: string, pattern: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return relativePath === pattern || relativePath.endsWith(pattern);
  let idx = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === "") continue;
    const next = relativePath.indexOf(p, idx);
    if (next === -1) return false;
    idx = next + p.length;
  }
  return true;
}

/**
 * Block commands that kill all Node (or other) processes system-wide.
 * The agent must not be able to kill the host app or processes outside the workspace.
 */
function isBlockedKillAllCommand(command: string): boolean {
  const c = command.trim().toLowerCase().replace(/\s+/g, " ");
  // Windows: taskkill /F /IM node.exe, taskkill /F /IM node, etc.
  if (/taskkill\s+(\/F|\-F)\s+(\/IM|\-IM)\s+node(\s|\.exe|$)/.test(c)) return true;
  if (/taskkill\s+(\/IM|\-IM)\s+node(\s|\.exe|$)/.test(c) && c.includes("/f")) return true;
  // Unix: pkill node, pkill -f node, killall node
  if (/^pkill\s+(-f\s+)?node(\s|$)/.test(c)) return true;
  if (/^killall\s+(-9\s+)?node(\s|$)/.test(c)) return true;
  if (/\bpkill\s+node\b/.test(c)) return true;
  if (/\bkillall\s+node\b/.test(c)) return true;
  return false;
}

/**
 * Execute a single tool. All OS/shell execution is contained here (run_terminal_cmd only).
 */
export async function executeTool(
  workspaceId: WorkspaceId,
  call: ToolCall,
  options?: ExecuteToolOptions
): Promise<ToolResult> {
  const { callId, tool: rawTool, args } = call;
  const tool = normalizeToolName(rawTool);
  const log = (msg: string, meta?: Record<string, unknown>) =>
    console.log(LOG_PREFIX, msg, callId, tool, meta ?? "");

  try {
    if (tool === "run_terminal_cmd") {
      const command =
        (args.command as string) ??
        (args as Record<string, unknown>).command;
      if (typeof command !== "string" || !command.trim()) {
        log("run_terminal_cmd: missing command");
        return { callId, tool: rawTool, success: false, error: "Missing command" };
      }
      const cmdTrimmed = command.trim();
      if (isBlockedKillAllCommand(cmdTrimmed)) {
        log("run_terminal_cmd: blocked kill-all command");
        return {
          callId,
          tool: rawTool,
          success: false,
          error:
            "Killing all Node processes is not allowed (it would stop the host app and other apps). " +
            "You can only stop processes started in this workspace. To stop the dev server for this project, ask to stop it and I will stop only that process, or close the terminal that is running it.",
        };
      }
      if (isDevServerCommand(cmdTrimmed)) {
        killExistingDevServer(workspaceId);
      }
      return new Promise<ToolResult>((resolve) => {
        const chunks: string[] = [];
        const proc = runCommandStream(workspaceId, cmdTrimmed, {
          onChunk(chunk) {
            chunks.push(chunk);
            options?.onStream?.(callId, chunk);
          },
          onEnd(exitCode) {
            const code = exitCode ?? 1;
            options?.onStreamEnd?.(callId, code);
            if (isDevServerCommand(cmdTrimmed)) {
              unregisterDevServerProcess(workspaceId);
            }
            const output = chunks.join("");
            resolve({
              callId,
              tool: rawTool,
              success: code === 0,
              output,
              exitCode: code,
            });
          },
        });
        if (isDevServerCommand(cmdTrimmed)) {
          registerDevServerProcess(workspaceId, proc.kill);
        }
        options?.onSpawn?.(callId, proc.kill);
      });
    }

    if (tool === "read_file") {
      const targetFile =
        (args.target_file as string) ??
        (args.path as string) ??
        (args.file_path as string);
      if (typeof targetFile !== "string" || !targetFile.trim()) {
        return { callId, tool: rawTool, success: false, error: "Missing target_file" };
      }
      console.log(LOG_PREFIX, "read_file args", callId, JSON.stringify(args, null, 0));
      const startLine = (args.start_line_one_indexed as number) ?? (args.startLine as number);
      const endLine =
        (args.end_line_one_indexed_inclusive as number) ?? (args.endLine as number);
      const readEntire = (args.should_read_entire_file as boolean) ?? !startLine;
      let content = await readFile(workspaceId, targetFile.trim());
      let actualStart = 1;
      let actualEnd: number;
      if (!readEntire && (typeof startLine === "number" || typeof endLine === "number")) {
        const lines = content.split(/\r?\n/);
        const oneBased = 1;
        actualStart = Math.max(oneBased, typeof startLine === "number" ? startLine : 1);
        actualEnd =
          typeof endLine === "number"
            ? Math.min(endLine, lines.length)
            : Math.min(actualStart + 249, lines.length);
        content = lines.slice(actualStart - 1, actualEnd).join("\n");
      } else {
        const lineCount = content.split(/\r?\n/).length;
        actualEnd = lineCount;
      }
      log("read_file ok", { path: targetFile, startLine: actualStart, endLine: actualEnd });
      return {
        callId,
        tool: rawTool,
        success: true,
        output: content,
        startLine: actualStart,
        endLine: actualEnd,
      };
    }

    if (tool === "list_dir") {
      const relPath =
        (args.relative_workspace_path as string) ??
        (args.path as string) ??
        (args.dir as string) ??
        ".";
      const normalized = path.normalize(relPath).replace(/\\/g, "/");
      if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
        return { callId, tool: rawTool, success: false, error: "Invalid path" };
      }
      const nodes = await listWorkspaceFiles(workspaceId, relPath);
      const lines = nodes.map((n) => `${n.kind === "directory" ? "d" : "f"} ${n.path}`);
      log("list_dir ok", { path: relPath, count: nodes.length });
      return { callId, tool: rawTool, success: true, output: lines.join("\n") };
    }

    if (tool === "grep_search") {
      const query = (args.query as string) ?? (args.pattern as string);
      if (typeof query !== "string" || !query.trim()) {
        return { callId, tool: rawTool, success: false, error: "Missing query" };
      }
      const includePattern = (args.include_pattern as string) ?? "*";
      const caseSensitive = (args.case_sensitive as boolean) ?? false;
      const files = await listFilesRecursive(workspaceId, ".");
      const regex = new RegExp(
        query,
        caseSensitive ? "g" : "gi"
      );
      const maxMatches = 50;
      const matches: string[] = [];
      for (const rel of files) {
        if (matches.length >= maxMatches) break;
        if (!matchGlob(rel, includePattern)) continue;
        try {
          const content = await readFile(workspaceId, rel);
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
            const line = lines[i]!;
            if (regex.test(line)) {
              matches.push(`${rel}:${i + 1}:${line}`);
            }
          }
        } catch {
          // skip binary or unreadable
        }
      }
      log("grep_search ok", { matches: matches.length });
      return { callId, tool: rawTool, success: true, output: matches.join("\n") || "No matches" };
    }

    if (tool === "edit_file") {
      const targetFile =
        (args.target_file as string) ??
        (args.path as string) ??
        (args.file_path as string);
      const codeEdit =
        (args.code_edit as string) ??
        (args.content as string) ??
        (args.contents as string);
      const instructions = (args.instructions as string) ?? "";
      if (typeof targetFile !== "string" || !targetFile.trim()) {
        return { callId, tool: rawTool, success: false, error: "Missing target_file" };
      }
      if (typeof codeEdit !== "string") {
        return { callId, tool: rawTool, success: false, error: "Missing code_edit/content" };
      }
      let currentContent: string;
      try {
        currentContent = await readFile(workspaceId, targetFile.trim());
      } catch {
        currentContent = "";
      }
      const applied = await applyEditWithModel(currentContent, {
        target_file: targetFile.trim(),
        instructions,
        code_edit: codeEdit,
      });
      const toWrite = stripCodeFences(applied);
      await writeFile(workspaceId, targetFile.trim(), toWrite);
      setLastEdit(workspaceId, {
        target_file: targetFile.trim(),
        instructions,
        code_edit: codeEdit,
      });
      log("edit_file ok (apply model)", { path: targetFile });
      // Send written content to UI so the mini file editor can show it (cap size for large files)
      const MAX_EDIT_OUTPUT_CHARS = 120_000;
      const outputContent =
        toWrite.length <= MAX_EDIT_OUTPUT_CHARS
          ? toWrite
          : toWrite.slice(0, MAX_EDIT_OUTPUT_CHARS) + "\n\n… (truncated for display)";
      return { callId, tool: rawTool, success: true, output: outputContent };
    }

    if (tool === "search_replace") {
      const filePath =
        (args.file_path as string) ??
        (args.path as string) ??
        (args.target_file as string);
      const oldStr = args.old_string as string;
      const newStr = args.new_string as string;
      if (typeof filePath !== "string" || !filePath.trim()) {
        return { callId, tool: rawTool, success: false, error: "Missing file_path" };
      }
      if (typeof oldStr !== "string") {
        return { callId, tool: rawTool, success: false, error: "Missing old_string" };
      }
      if (typeof newStr !== "string") {
        return { callId, tool: rawTool, success: false, error: "Missing new_string" };
      }
      const content = await readFile(workspaceId, filePath.trim());
      const first = content.indexOf(oldStr);
      if (first === -1) {
        return {
          callId,
          tool: rawTool,
          success: false,
          error: "old_string not found in file",
        };
      }
      const updated =
        content.slice(0, first) + newStr + content.slice(first + oldStr.length);
      await writeFile(workspaceId, filePath.trim(), updated);
      log("search_replace ok", { path: filePath });
      const MAX_EDIT_OUTPUT_CHARS = 120_000;
      const outputContent =
        updated.length <= MAX_EDIT_OUTPUT_CHARS
          ? updated
          : updated.slice(0, MAX_EDIT_OUTPUT_CHARS) + "\n\n… (truncated for display)";
      return { callId, tool: rawTool, success: true, output: outputContent };
    }

    if (tool === "file_search") {
      const query = (args.query as string) ?? (args.pattern as string);
      if (typeof query !== "string" || !query.trim()) {
        return { callId, tool: rawTool, success: false, error: "Missing query" };
      }
      const all = await listFilesRecursive(workspaceId, ".");
      const q = query.trim().toLowerCase();
      const filtered = all.filter((p) => p.toLowerCase().includes(q));
      const capped = filtered.slice(0, 10);
      log("file_search ok", { results: capped.length });
      return { callId, tool: rawTool, success: true, output: capped.join("\n") || "No matches" };
    }

    if (tool === "delete_file") {
      const filePath =
        (args.path as string) ??
        (args.file_path as string) ??
        (args.target_file as string);
      if (typeof filePath !== "string" || !filePath.trim()) {
        return { callId, tool: rawTool, success: false, error: "Missing path" };
      }
      await deletePath(workspaceId, filePath.trim());
      log("delete_file ok", { path: filePath });
      return { callId, tool: rawTool, success: true, output: "Deleted." };
    }

    if (tool === "reapply") {
      const targetFile =
        (args.target_file as string) ??
        (args.path as string) ??
        (args.file_path as string);
      if (typeof targetFile !== "string" || !targetFile.trim()) {
        return { callId, tool: rawTool, success: false, error: "Missing target_file" };
      }
      const last = getLastEdit(workspaceId);
      if (!last) {
        return {
          callId,
          tool: rawTool,
          success: false,
          error: "No previous edit_file to reapply. Use edit_file first, then reapply if the result was wrong.",
        };
      }
      const currentContent = await readFile(workspaceId, targetFile.trim());
      const newContent = await reapplyEditWithModel(currentContent, last);
      const toWrite = stripCodeFences(newContent);
      await writeFile(workspaceId, targetFile.trim(), toWrite);
      log("reapply ok", { path: targetFile });
      return { callId, tool: rawTool, success: true, output: "Reapply completed. The smarter model has applied the edit." };
    }

    if (tool === "create_diagram") {
      const content = (args.content as string) ?? "";
      if (typeof content !== "string" || !content.trim()) {
        return { callId, tool: rawTool, success: false, error: "Missing content" };
      }
      log("create_diagram ok", { length: content.length });
      return {
        callId,
        tool: rawTool,
        success: true,
        output: content.trim(),
        payload: { mermaid: content.trim() },
      };
    }

    if (tool === "edit_notebook") {
      const targetNotebook =
        (args.target_notebook as string) ?? (args.path as string) ?? (args.file_path as string);
      const cellIdx = (args.cell_idx as number) ?? (args.cellIdx as number);
      const isNewCell = (args.is_new_cell as boolean) ?? (args.isNewCell as boolean);
      const cellLanguage = (args.cell_language as string) ?? (args.cellLanguage as string) ?? "python";
      const oldString = (args.old_string as string) ?? "";
      const newString = (args.new_string as string) ?? (args.newString as string) ?? "";
      if (typeof targetNotebook !== "string" || !targetNotebook.trim()) {
        return { callId, tool: rawTool, success: false, error: "Missing target_notebook" };
      }
      const raw = await readFile(workspaceId, targetNotebook.trim());
      let nb: { cells?: { cell_type?: string; source?: string[] }[] };
      try {
        nb = JSON.parse(raw) as { cells?: { cell_type?: string; source?: string[] }[] };
      } catch {
        return { callId, tool: rawTool, success: false, error: "Invalid notebook JSON" };
      }
      const cells = nb.cells ?? [];
      if (isNewCell) {
        const source = newString.split(/\r?\n/);
        cells.splice(Math.min(cellIdx, cells.length), 0, {
          cell_type: cellLanguage === "markdown" || cellLanguage === "raw" ? "markdown" : "code",
          source,
        });
      } else {
        const cell = cells[cellIdx];
        if (!cell) {
          return { callId, tool: rawTool, success: false, error: `No cell at index ${cellIdx}` };
        }
        const src = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source ?? "");
        const first = src.indexOf(oldString);
        if (first === -1) {
          return {
            callId,
            tool: rawTool,
            success: false,
            error: "old_string not found in cell",
          };
        }
        const updated = src.slice(0, first) + newString + src.slice(first + oldString.length);
        cell.source = updated.split(/\r?\n/).map((l) => l + "\n");
        if (cell.source.length > 0) {
          const last = cell.source[cell.source.length - 1]!;
          if (last.endsWith("\n")) cell.source[cell.source.length - 1] = last.slice(0, -1);
        }
      }
      nb.cells = cells;
      await writeFile(workspaceId, targetNotebook.trim(), JSON.stringify(nb, null, 1));
      log("edit_notebook ok", { path: targetNotebook });
      return { callId, tool: rawTool, success: true, output: "Notebook cell updated." };
    }

    if (tool === "codebase_search") {
      const query = (args.query as string) ?? "";
      if (typeof query !== "string" || !query.trim()) {
        return { callId, tool: rawTool, success: false, error: "Missing query" };
      }
      const dirs = (args.target_directories as string[]) ?? [];
      const includePattern = dirs.length > 0 ? dirs.map((d) => d + "/**").join(",") : "*";
      const files = await listFilesRecursive(workspaceId, ".");
      const filtered = includePattern === "*" ? files : files.filter((f) => dirs.some((d) => f.startsWith(d)));
      const q = query.trim().toLowerCase();
      const maxMatches = 20;
      const matches: string[] = [];
      for (const rel of filtered) {
        if (matches.length >= maxMatches) break;
        try {
          const content = await readFile(workspaceId, rel);
          if (!content.toLowerCase().includes(q)) continue;
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
            if (lines[i]!.toLowerCase().includes(q)) {
              matches.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 120)}`);
            }
          }
        } catch {
          // skip
        }
      }
      log("codebase_search ok (keyword fallback)", { results: matches.length });
      return {
        callId,
        tool: rawTool,
        success: true,
        output: matches.length ? matches.join("\n") : `No keyword matches for "${query}" in codebase.`,
      };
    }

    if (tool === "web_search") {
      const searchTerm = (args.search_term as string) ?? (args.query as string);
      if (typeof searchTerm !== "string" || !searchTerm.trim()) {
        return { callId, tool: rawTool, success: false, error: "Missing search_term" };
      }
      log("web_search unimplemented", { search_term: searchTerm });
      return {
        callId,
        tool: rawTool,
        success: false,
        error: "Web search is not configured. Set up a search API (e.g. SERPER_API_KEY) to enable this tool.",
      };
    }

    // Unknown tool
    log("unsupported tool", { tool });
    return {
      callId,
      tool: rawTool,
      success: false,
      error: `Tool not implemented: ${tool}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "executeTool error", callId, tool, message, err instanceof Error ? err.stack : "");
    return {
      callId,
      tool: rawTool,
      success: false,
      error: message,
    };
  }
}

/**
 * Execute multiple tool calls in parallel and collect results as JSON.
 * For run_terminal_cmd, pass onStream/onStreamEnd to stream output to the UI.
 */
export async function executeToolCallsParallel(
  workspaceId: WorkspaceId,
  calls: ToolCall[],
  options?: ExecuteToolOptions
): Promise<BatchToolResult> {
  if (calls.length === 0) {
    return { results: [], errors: [] };
  }
  console.log(LOG_PREFIX, "parallel execution", "count:", calls.length, "callIds:", calls.map((c) => c.callId).join(", "));
  const results = await Promise.all(
    calls.map((call) => executeTool(workspaceId, call, options))
  );
  const errors = results
    .filter((r) => !r.success && r.error)
    .map((r) => ({ callId: r.callId, error: r.error! }));
  if (errors.length > 0) {
    console.warn(LOG_PREFIX, "batch had failures:", errors.length, errors.map((e) => e.callId + ": " + e.error).join("; "));
  }
  return { results, errors };
}
