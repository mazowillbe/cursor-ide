/**
 * Tool router: single entry point for all tool execution.
 * No direct OS tool execution outside this module; run_terminal_cmd uses workspace.runCommandStream.
 * Supports parallel execution and optional streaming for bash.
 */

import path from "path";
import fs from "fs/promises";
import {
  getWorkspacePath,
  findProjectRoot,
  readFile,
  writeFile,
  listWorkspaceFiles,
  deletePath,
  runCommandStream,
  type WorkspaceId,
} from "./workspace.js";
import { config } from "./config.js";
import {
  isCommandAllowed,
  isCommandAttemptingEscape,
  looksLikeBarePath,
  DEFAULT_COMMAND_TIMEOUT_MS,
} from "./command-sandbox.js";
import {
  isDevServerCommand,
  DEV_SERVER_INITIAL_OUTPUT_MS,
  killExistingDevServer,
  registerDevServerProcess,
  unregisterDevServerProcess,
} from "./dev-server-manager.js";
import { reapplyEditWithModel } from "./reapply-agent.js";
import { applyEditWithModel, stripCodeFences } from "./apply-edit-agent.js";
import { getLastEdit, setLastEdit } from "./last-edit-store.js";
import { startEdit, endEdit, waitForEditComplete } from "./file-edit-lock.js";
import type { ToolCall, ToolResult, ExecuteToolOptions, BatchToolResult } from "./types/tools.js";
import { createTwoFilesPatch } from "diff";

const LOG_PREFIX = "[tool-router]";

/** When file content exceeds this size, send unified diff instead of full content to reduce SSE/WS payload. */
const DIFF_PAYLOAD_THRESHOLD = 8 * 1024;

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
    read_lints: "read_lints",
    reapply: "reapply",
    codebase_search: "codebase_search",
    web_search: "web_search",
    create_diagram: "create_diagram",
    edit_notebook: "edit_notebook",
    thinking_tool: "thinking_tool",
    image_tool: "image_tool",
  };
  return map[raw] ?? raw;
}

/**
 * Normalize escaped sequences in tool args.
 * Models sometimes send literal \n (backslash+n) instead of actual newlines when outputting JSON.
 * This converts those to real newlines/tabs so search_replace matches and writes correctly.
 */
function unescapeToolString(s: string): string {
  if (typeof s !== "string") return "";
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");
}

/** Parse lint output to count errors. Handles eslint, tsc, and common formats. */
function parseLintErrorCount(output: string): number {
  if (!output || typeof output !== "string") return 0;
  const s = output;
  const eslintMatch = s.match(/(\d+)\s+error(s?)\s+and\s+(\d+)\s+warning/i)
    ?? s.match(/(\d+)\s+error(s?)\b/i)
    ?? s.match(/✖\s*(\d+)\s+problem/i)
    ?? s.match(/(\d+)\s+problem(s?)\s+\((\d+)\s+error/i);
  if (eslintMatch) {
    const err = parseInt(eslintMatch[1], 10);
    const errFromProblems = eslintMatch[3] ? parseInt(eslintMatch[3], 10) : err;
    return Number.isNaN(errFromProblems) ? (Number.isNaN(err) ? 0 : err) : errFromProblems;
  }
  const tscMatch = s.match(/(\d+)\s+error(s?)\s+found/i);
  if (tscMatch) return parseInt(tscMatch[1], 10) || 0;
  if (/\berror\s*:\s*\d+/i.test(s) || /Found\s+\d+\s+error/i.test(s)) {
    const n = s.match(/(\d+)\s*error/i);
    return n ? parseInt(n[1], 10) || 0 : 0;
  }
  return 0;
}

/** Recursively list relative file paths under dir (relative to project root). */
async function listFilesRecursive(workspaceId: WorkspaceId, dir: string): Promise<string[]> {
  const base = findProjectRoot(workspaceId);
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
    if (tool === "thinking_tool") {
      const thought = typeof args.thought === "string" ? args.thought.trim() : "";
      return {
        callId,
        tool: rawTool,
        success: true,
        output: thought ? "Thinking recorded." : "No thought provided.",
        payload: thought ? { thought } : undefined,
      };
    }

    if (tool === "image_tool") {
      const query =
        (args.query as string) ??
        (args.prompt as string) ??
        (args.description as string);
      if (typeof query !== "string" || !query.trim()) {
        return { callId, tool: rawTool, success: false, error: "Missing query" };
      }
      const q = query.trim();
      const perPageRaw =
        (args.per_page as number) ??
        (args.limit as number) ??
        (args.count as number);
      const perPage =
        typeof perPageRaw === "number" && Number.isFinite(perPageRaw)
          ? Math.min(12, Math.max(1, Math.round(perPageRaw)))
          : 6;
      const color = (args.color as string) ?? undefined;
      const licenseType = (args.license as string) ?? (args.license_type as string) ?? undefined;
      const orientation = (args.orientation as string) ?? undefined;

      const searchParams = new URLSearchParams();
      searchParams.set("q", q);
      searchParams.set("per_page", String(perPage));
      if (color && color.trim()) searchParams.set("color", color.trim());
      // Openverse supports filtering by license; prefer the documented "license" param, but accept legacy license_type too.
      if (licenseType && licenseType.trim()) {
        searchParams.set("license", licenseType.trim());
      }
      if (orientation && orientation.trim()) searchParams.set("aspect_ratio", orientation.trim());

      const url = `https://api.openverse.engineering/v1/images/?${searchParams.toString()}`;
      const resp = await fetch(url, {
        headers: { Accept: "application/json" },
      });
      if (!resp.ok) {
        const bodyText = await resp.text().catch(() => "");
        const message = bodyText || resp.statusText || "Openverse request failed";
        return {
          callId,
          tool: rawTool,
          success: false,
          error: `Openverse API error (${resp.status}): ${message}`,
        };
      }
      const json = (await resp.json().catch(() => ({}))) as {
        results?: unknown[];
      };
      const results = Array.isArray(json.results) ? json.results : [];
      const images = results.map((r, idx) => {
        const anyR = r as Record<string, unknown>;
        const directImage =
          (anyR.image as string | undefined) ??
          (anyR.image_url as string | undefined) ??
          (anyR.url as string | undefined) ??
          (anyR.foreign_landing_url as string | undefined) ??
          (anyR.thumbnail as string | undefined) ??
          "";
        return {
          index: idx,
          id: String(anyR.id ?? ""),
          title: (anyR.title as string | undefined) || "",
          url: directImage,
          thumbnail: (anyR.thumbnail as string | undefined) || "",
          creator: (anyR.creator as string | undefined) || "",
          provider: (anyR.provider as string | undefined) || "",
          source: (anyR.source as string | undefined) || "",
          license: (anyR.license as string | undefined) || "",
          licenseVersion: (anyR.license_version as string | undefined) || "",
        };
      });

      if (images.length === 0) {
        return {
          callId,
          tool: rawTool,
          success: true,
          output: `No Openverse image results for query: "${q}".`,
          payload: { images: [] },
        };
      }

      const best = images[0]!;
      const summaryLines = images.slice(0, 5).map((img, i) => {
        const title = img.title || img.id || img.url;
        const by = img.creator ? ` by ${img.creator}` : "";
        const license = img.license ? ` (${img.license}${img.licenseVersion ? " " + img.licenseVersion : ""})` : "";
        return `${i + 1}. ${title}${by} — ${img.url}${license}`;
      });

      const output =
        `Openverse image search for "${q}" (showing up to ${images.length} result${images.length === 1 ? "" : "s"}).\n\n` +
        summaryLines.join("\n") +
        `\n\nUse the "best" image URL when you need a single image, or pick from payload.images.`;

      return {
        callId,
        tool: rawTool,
        success: true,
        output,
        payload: {
          images,
          best,
        },
      };
    }

    if (tool === "run_terminal_cmd") {
      const command =
        (args.command as string) ??
        (args as Record<string, unknown>).command;
      if (typeof command !== "string" || !command.trim()) {
        log("run_terminal_cmd: missing command");
        return { callId, tool: rawTool, success: false, error: "Missing command" };
      }
      const cmdTrimmed = command.trim();
      if (looksLikeBarePath(cmdTrimmed)) {
        log("run_terminal_cmd: command looks like bare path");
        return {
          callId,
          tool: rawTool,
          success: false,
          error:
            "That looks like a file or directory path, not a shell command. Use list_dir to list directories and read_file to read files. run_terminal_cmd requires full commands (e.g. 'npm run dev', 'ls src').",
        };
      }
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
      const projectRoot = findProjectRoot(workspaceId);
      if (!isCommandAllowed(cmdTrimmed)) {
        log("run_terminal_cmd: command not on allowlist");
        return {
          callId,
          tool: rawTool,
          success: false,
          error:
            "Command not allowed. Only npm, npx, node, yarn, pnpm, git, supabase (and cd within workspace) are permitted.",
        };
      }
      if (isCommandAttemptingEscape(cmdTrimmed, projectRoot)) {
        log("run_terminal_cmd: command attempts to leave workspace");
        return {
          callId,
          tool: rawTool,
          success: false,
          error: "Command may not leave the workspace directory.",
        };
      }
      if (isDevServerCommand(cmdTrimmed)) {
        killExistingDevServer(workspaceId);
      }
      const isDevServer = isDevServerCommand(cmdTrimmed);
      // When NODE_ENV=production, npm install skips devDependencies (vite, etc.). Force development so dev deps install.
      const isNpmInstall = /^npm\s+(?:i|install|ci)(?:\s|$)/.test(cmdTrimmed);
      const isSupabaseCmd = /^(npx\s+)?supabase\b/i.test(cmdTrimmed);
      const supabaseEnv: NodeJS.ProcessEnv = {};
      let finalCommand: string = cmdTrimmed;
      if (isSupabaseCmd) {
        const supabaseBin = path.join(process.cwd(), "node_modules", ".bin");
        supabaseEnv.PATH = `${supabaseBin}${path.delimiter}${process.env.PATH || ""}`;
        if (process.env.SUPABASE_ACCESS_TOKEN) supabaseEnv.SUPABASE_ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
        if (process.env.SUPABASE_URL) supabaseEnv.SUPABASE_URL = process.env.SUPABASE_URL;
        if (process.env.SUPABASE_SERVICE_ROLE_KEY) supabaseEnv.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        const ref = process.env.SUPABASE_URL?.match(/https:\/\/([a-zA-Z0-9]+)\.supabase\.co/)?.[1];
        if (ref) {
          supabaseEnv.SUPABASE_PROJECT_REF = ref;
          finalCommand = cmdTrimmed.replace(/\$SUPABASE_PROJECT_REF|%SUPABASE_PROJECT_REF%/g, ref);
        }
      }
      const streamOptions = {
        timeoutMs: isDevServer ? undefined : DEFAULT_COMMAND_TIMEOUT_MS,
        envOverride: {
          ...(isNpmInstall && { NODE_ENV: "development" }),
          ...(Object.keys(supabaseEnv).length > 0 && supabaseEnv),
        },
      };
      return new Promise<ToolResult>((resolve) => {
        const chunks: string[] = [];
        let resolved = false;
        let initialOutputTimer: ReturnType<typeof setTimeout> | undefined;
        const doResolve = (result: ToolResult) => {
          if (resolved) return;
          resolved = true;
          if (initialOutputTimer != null) {
            clearTimeout(initialOutputTimer);
            initialOutputTimer = undefined;
          }
          resolve(result);
        };
        const proc = runCommandStream(
          workspaceId,
          finalCommand,
          {
            onChunk(chunk) {
              chunks.push(chunk);
              options?.onStream?.(callId, chunk);
            },
            onEnd(exitCode) {
              const code = exitCode ?? 1;
              options?.onStreamEnd?.(callId, code);
              if (isDevServer) {
                unregisterDevServerProcess(workspaceId);
              }
              const output = chunks.join("");
              doResolve({
                callId,
                tool: rawTool,
                success: code === 0,
                output,
                exitCode: code,
              });
            },
          },
          streamOptions
        );
        if (isDevServer) {
          registerDevServerProcess(workspaceId, proc.kill);
          initialOutputTimer = setTimeout(() => {
            doResolve({
              callId,
              tool: rawTool,
              success: true,
              output:
                chunks.join("") ||
                "(Dev server started. Output will stream in the terminal. If you see errors in the terminal, fix them and re-run if needed.)",
              exitCode: 0,
            });
          }, DEV_SERVER_INITIAL_OUTPUT_MS);
        }
        options?.onSpawn?.(callId, proc.kill);
      });
    }

    if (tool === "read_lints") {
      const LINT_TIMEOUT_MS = 60_000;
      return new Promise<ToolResult>((resolve) => {
        const chunks: string[] = [];
        const proc = runCommandStream(
          workspaceId,
          "npm run lint 2>&1",
          {
            onChunk(chunk) {
              chunks.push(chunk);
            },
            onEnd(exitCode) {
              const output = chunks.join("");
              const code = exitCode ?? 1;
              const errorCount = parseLintErrorCount(output);
              const summary =
                errorCount === 0
                  ? "No linting errors found."
                  : `${errorCount} linting error${errorCount === 1 ? "" : "s"} found.`;
              const fullOutput = output.trim()
                ? `${summary}\n\n${output.trim()}`
                : summary;
              resolve({
                callId,
                tool: rawTool,
                success: code === 0 && errorCount === 0,
                output: fullOutput,
                exitCode: code,
                payload: { errorCount, summary },
              });
            },
          },
          { timeoutMs: LINT_TIMEOUT_MS }
        );
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
      const pathTrimmed = targetFile.trim();
      await waitForEditComplete(workspaceId, pathTrimmed);
      console.log(LOG_PREFIX, "read_file args", callId, JSON.stringify(args, null, 0));
      const startLine = (args.start_line_one_indexed as number) ?? (args.startLine as number);
      const endLine =
        (args.end_line_one_indexed_inclusive as number) ?? (args.endLine as number);
      const readEntire = (args.should_read_entire_file as boolean) ?? !startLine;
      let content = await readFile(workspaceId, pathTrimmed);
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
      const pathTrimmed = targetFile.trim();
      startEdit(workspaceId, pathTrimmed);
      try {
        const codeEditStripped = stripCodeFences(codeEdit);
        let currentContent: string;
        try {
          currentContent = await readFile(workspaceId, pathTrimmed);
        } catch {
          currentContent = "";
        }
        const applied = await applyEditWithModel(workspaceId, currentContent, {
          target_file: pathTrimmed,
          instructions,
          code_edit: codeEditStripped,
        });
        const toWrite = stripCodeFences(applied);
        const MAX_EDIT_OUTPUT_CHARS = 120_000;
        let outputContent: string;
        if (toWrite.length > DIFF_PAYLOAD_THRESHOLD) {
          outputContent = createTwoFilesPatch(pathTrimmed, pathTrimmed, currentContent, toWrite);
        } else {
          outputContent =
            toWrite.length <= MAX_EDIT_OUTPUT_CHARS
              ? toWrite
              : toWrite.slice(0, MAX_EDIT_OUTPUT_CHARS) + "\n\n… (truncated for display)";
        }
        await writeFile(workspaceId, pathTrimmed, toWrite);
        if (options?.onStream && outputContent) {
          const lines = outputContent.split(/\n/);
          const STREAM_LINE_DELAY_MS = 12;
          for (let i = 0; i < lines.length; i++) {
            const chunk = i < lines.length - 1 ? lines[i] + "\n" : (lines[i] || "");
            if (chunk) options.onStream(callId, chunk);
            if (i < lines.length - 1) await new Promise((r) => setTimeout(r, STREAM_LINE_DELAY_MS));
          }
        }
        setLastEdit(workspaceId, {
          target_file: pathTrimmed,
          instructions,
          code_edit: codeEditStripped,
        });
        log("edit_file ok (apply model)", { path: targetFile });
        return { callId, tool: rawTool, success: true, output: outputContent };
      } finally {
        endEdit(workspaceId, pathTrimmed);
      }
    }

    if (tool === "search_replace") {
      const filePath =
        (args.file_path as string) ??
        (args.path as string) ??
        (args.target_file as string);
      const oldStr = unescapeToolString(String(args.old_string ?? ""));
      const newStr = unescapeToolString(String(args.new_string ?? ""));
      if (typeof filePath !== "string" || !filePath.trim()) {
        return { callId, tool: rawTool, success: false, error: "Missing file_path" };
      }
      if (!oldStr) {
        return { callId, tool: rawTool, success: false, error: "Missing old_string" };
      }
      const pathTrimmed = filePath.trim();
      startEdit(workspaceId, pathTrimmed);
      try {
        const content = await readFile(workspaceId, pathTrimmed);
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
        const MAX_EDIT_OUTPUT_CHARS = 120_000;
        let outputContent: string;
        if (updated.length > DIFF_PAYLOAD_THRESHOLD) {
          outputContent = createTwoFilesPatch(pathTrimmed, pathTrimmed, content, updated);
        } else {
          outputContent =
            updated.length <= MAX_EDIT_OUTPUT_CHARS
              ? updated
              : updated.slice(0, MAX_EDIT_OUTPUT_CHARS) + "\n\n… (truncated for display)";
        }
        await writeFile(workspaceId, pathTrimmed, updated);
        if (options?.onStream && outputContent) {
          const lines = outputContent.split(/\n/);
          const STREAM_LINE_DELAY_MS = 12;
          for (let i = 0; i < lines.length; i++) {
            const chunk = i < lines.length - 1 ? lines[i] + "\n" : (lines[i] || "");
            if (chunk) options.onStream(callId, chunk);
            if (i < lines.length - 1) await new Promise((r) => setTimeout(r, STREAM_LINE_DELAY_MS));
          }
        }
        log("search_replace ok", { path: filePath });
        return { callId, tool: rawTool, success: true, output: outputContent };
      } finally {
        endEdit(workspaceId, pathTrimmed);
      }
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
      const newContent = await reapplyEditWithModel(workspaceId, currentContent, last);
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
      const oldString = unescapeToolString((args.old_string as string) ?? "");
      const newString = unescapeToolString((args.new_string as string) ?? (args.newString as string) ?? "");
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
