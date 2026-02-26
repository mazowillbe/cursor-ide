import { useState, useRef, useEffect } from "react";
import MiniTerminal, { type MiniTerminalProps } from "./MiniTerminal";
import MiniFileEditor from "./MiniFileEditor";
import ToolCallCard from "./ToolCallCard";

function JumpingDots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span
        className="w-1 h-1 rounded-full bg-gray-400 animate-[jump_0.6s_ease-in-out_infinite]"
        style={{ animationDelay: "0ms" }}
      />
      <span
        className="w-1 h-1 rounded-full bg-gray-400 animate-[jump_0.6s_ease-in-out_infinite]"
        style={{ animationDelay: "150ms" }}
      />
      <span
        className="w-1 h-1 rounded-full bg-gray-400 animate-[jump_0.6s_ease-in-out_infinite]"
        style={{ animationDelay: "300ms" }}
      />
    </span>
  );
}

import type { Session } from "@supabase/supabase-js";
import { createSupabaseClient } from "../lib/supabase/client";
import {
  getAgentWebSocketUrl,
  listModels,
  generateChatTitle,
  suggestProjectName,
  updateProjectName,
  describeImages,
  killCommand,
  type ModelOption,
} from "../api/client";

const MAX_USER_HISTORY_MESSAGES = 12;

interface ChatSession {
  id: string;
  title: string | null;
}

/**
 * Build message with conversation context so the agent (OpenCode) is aware of chat history.
 * Puts the CURRENT user message first so it is never lost to command-line length limits (e.g. Windows ~8191 chars).
 * Includes a short "Conversation context" block with the last assistant turn so the agent knows what was already done.
 */
function buildMessageWithHistory(prevMessages: Message[], currentText: string): string {
  const userMessages = prevMessages.filter((m) => m.role === "user").slice(-MAX_USER_HISTORY_MESSAGES);
  const assistantMessages = prevMessages.filter((m) => m.role === "assistant");
  const lastAssistant = assistantMessages[assistantMessages.length - 1];
  const lastAssistantContent = lastAssistant?.content?.trim() ?? "";
  const CONVERSATION_CONTEXT_MAX = 1200;
  const conversationContext =
    lastAssistantContent.length > 0
      ? `Conversation context (what you already did or said): ${lastAssistantContent.length > CONVERSATION_CONTEXT_MAX ? "…" : ""}${lastAssistantContent.slice(-CONVERSATION_CONTEXT_MAX)}`
      : "";

  if (userMessages.length === 0 && !conversationContext) return currentText;

  const sections: string[] = [
    "Current user message (respond to this):",
    currentText,
    "",
  ];
  if (conversationContext) {
    sections.push("---", conversationContext, "");
  }
  if (userMessages.length > 0) {
    const historyLines = userMessages.map((m) => `User: ${(m.content || "").trim()}`).filter((line) => line.length > "User: ".length);
    sections.push("---", "Previous user messages:", ...historyLines);
  }
  return sections.join("\n");
}

/** Remove ANSI escape codes and OpenCode status prefix for clean display. */
function cleanOutput(str: string): string {
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/> build · [\w.-]+/g, "")
    .replace(/\s*invalid\s+Invalid Tool\s*/gi, " ");
}

/** For user messages that include image descriptions, return only the text the user sent (not the describe_image output). */
function getUserVisibleContent(content: string): string {
  const marker = "\n\n---\n\nUser message: ";
  const idx = content.indexOf(marker);
  if (idx !== -1) return content.slice(idx + marker.length).trim();
  if (/^\[User sent \d+ image\(s\)\. Image descriptions:\]/.test(content.trim())) return "";
  return content;
}

/** Extract path from ls command line. e.g. "$ ls -F" -> ".", "$ ls -la ./src" -> "./src" */
function getLsPath(line: string): string {
  const args = line.replace(/^\$\s*ls\s*/, "").trim().split(/\s+/).filter(Boolean);
  const pathArg = args.find((a) => !a.startsWith("-"));
  if (!pathArg) return ".";
  if (/^\d+$/.test(pathArg)) return "."; // "28" from "total 28" etc. -> current dir
  return pathArg;
}

const TOOL_LINE =
  "text-sm leading-snug text-gray-400 py-0.5 border-l-2 border-transparent pl-1 my-0.5";

/** Capitalize command name for header: "start-sleep" -> "Start-Sleep", "ls" -> "Ls" */
function commandNameForHeader(cmd: string): string {
  const first = cmd.trim().split(/\s+/)[0] || cmd;
  return first
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join("-");
}

/** Lookahead to stop command output before assistant narrative (so narrative stays in chat, not in card). */
const BEFORE_NARRATIVE = "\\n+(The |I'll |I'm |Let me )";

const LS_REGEX = new RegExp(`\\$ ls(?: [^\\n]*)?\\n([\\s\\S]*?)(?=\\r?\\n\\s*\\$\\s|\\$\\s|${BEFORE_NARRATIVE}|$)`, "g");
const BASH_REGEX = new RegExp(`\\$ ([^\\n]+)\\n([\\s\\S]*?)(?=\\r?\\n\\s*\\$\\s|\\$\\s|\\n\\n[A-ZI#]|\\n### |\\n\\nFeatures:|\\n\\nYour |\\n\\nRun |${BEFORE_NARRATIVE}|$)`, "g");

/**
 * Replace ls/bash blocks with __TERMINAL_N__ placeholders and collect terminal blocks for real xterm rendering.
 */
function extractTerminalsAndPlaceholders(content: string): { content: string; terminals: MiniTerminalProps[] } {
  const terminals: MiniTerminalProps[] = [];
  let out = content.replace(LS_REGEX, (match, output) => {
    const firstLine = match.split("\n")[0];
    const path = getLsPath(firstLine);
    const outTrimmed = output.trim();
    const label = outTrimmed ? "Ran" : "Running";
    const cmd = `ls ${path === "." ? "" : path}`.trim();
    terminals.push({ label, cmdName: "Ls", fullCmd: cmd, output: outTrimmed });
    return `__TERMINAL_${terminals.length - 1}__`;
  });
  out = out.replace(BASH_REGEX, (_, cmd, output) => {
    const cmdTrimmed = cmd.trim();
    const outTrimmed = output.trim();
    const label = outTrimmed ? "Ran" : "Running";
    const cmdName = commandNameForHeader(cmdTrimmed);
    terminals.push({ label, cmdName, fullCmd: cmdTrimmed, output: outTrimmed });
    return `__TERMINAL_${terminals.length - 1}__`;
  });
  return { content: out, terminals };
}

/**
 * Format read: compact single line "Read filename" or "Read filename L1-100" with collapsible output.
 * Stops before Edit/edit_file so they render as separate blocks.
 * Merges split lines like "Read App" + "Read .jsx L1-59" or standalone "App" + "Read .jsx L1-59" into "Read App.jsx L1-59".
 */
function formatReadInContent(content: string): string {
  // Merge standalone filename line (no "Read" prefix) + "Read .<ext> L<start>-<end>" → "Read <name>.<ext> L<start>-<end>"
  let merged = content.replace(
    /(^|\n)(\s*)([A-Za-z0-9_-]+)(\s*\n+)\s*([Rr]ead)\s+(\.\w+)\s+[Ll](\d+)\s*-\s*(\d+)(\s*\n)/gm,
    (_m, start, spaceBefore, name, _newlines, readWord, ext, startLn, endLn, trailing) =>
      `${start}${spaceBefore}${readWord} ${name}${ext} L${startLn}-${endLn}${trailing}`
  );
  // Merge "Read <name>\n...\nRead .<ext> L<start>-<end>" into "Read <name>.<ext> L<start>-<end>"
  merged = merged.replace(
    /([Rr]ead)\s+([A-Za-z0-9_-]+)\s*\n([\s\S]*?)\n?\s*([Rr]ead)\s+(\.\w+)\s+[Ll](\d+)\s*-\s*(\d+)(\s*\n)/g,
    (_m, read1, name, between, _read2, ext, start, end, trailingNewline) => {
      const trimmed = between.trim();
      if (trimmed.length > 0) return _m;
      return `${read1} ${name}${ext} L${start}-${end}${trailingNewline}`;
    }
  );
  return merged.replace(
    /(?:\* [Rr]ead|[Rr]ead)\s+([^\s\n][^\n]*?)(?:\s+[Ll](\d+)\s*-\s*(\d+))?\n([\s\S]*?)(?=\n(?:\* [Rr]ead|[Rr]ead)\s+|\n\* [Ee]dit|\nedit_file\s|\n\$ |\n\n[A-ZI#]|\n### |$)/g,
    (_match, path, startLine, endLine, output) => {
      const cleanPath = path.trim().replace(/^<path>\s*/i, "");
      const displayPath = cleanPath.split(/[/\\]/).pop() || cleanPath;
      const rangeStr =
        startLine && endLine ? ` L${startLine} - ${endLine}` : "";
      const outTrimmed = output.trim();
      return `<details class="tool-call my-0.5"><summary class="${TOOL_LINE} cursor-pointer hover:text-gray-300"><b>Read</b> ${escapeHtml(displayPath)}${rangeStr}</summary><pre class="ml-3 mt-1 p-2 text-xs bg-surface-600/50 rounded overflow-x-auto overflow-y-auto whitespace-pre-wrap leading-tight max-h-[7.5rem]">${escapeHtml(outTrimmed)}</pre></details>`;
    }
  );
}

/**
 * Format edit/write: "Edit filepath", "Edited filepath", "edit_file failed...", etc. as separate block.
 */
function formatEditInContent(content: string): string {
  let out = content.replace(
    /edit_file\s+(?:failed|Error)[^\n]*(?:\n[^\n]*)?/gi,
    (match) => `<div class="${TOOL_LINE} text-red-400"><b>Edit</b> failed: ${escapeHtml(match.replace(/^edit_file\s+/i, "").trim())}</div>`
  );
  out = out.replace(
    /(?:\* [Ee]dit(?:ed)?|[Ee]dit(?:ed)?)\s+([^\s\n][^\n]*?)[\s\n]*([\s\S]*?)(?=\n(?:\* [Rr]ead|[Ee]dit|[Gg]rep|\* |\$ )|$)/g,
    (_match, path, output) => {
      const pathTrimmed = path.trim();
      const outTrimmed = output.trim();
      if (!outTrimmed) {
        return `<div class="${TOOL_LINE}"><b>Edit</b> ${escapeHtml(pathTrimmed)}</div>`;
      }
      return `<details class="tool-call my-0.5"><summary class="${TOOL_LINE} cursor-pointer hover:text-gray-300"><b>Edit</b> ${escapeHtml(pathTrimmed)}</summary><pre class="ml-3 mt-1 p-2 text-xs bg-surface-600/50 rounded overflow-x-auto overflow-y-auto whitespace-pre-wrap leading-tight max-h-[7.5rem]">${escapeHtml(outTrimmed)}</pre></details>`;
    }
  );
  return out;
}

/**
 * Format grep_search: compact single line "Grepped pattern in dir".
 */
function formatGrepInContent(content: string): string {
  return content.replace(
    /(?:\* [Gg]rep(?:ped)?|[Gg]rep(?:ped)?)\s+([^\n]+?)(?:\s+in\s+([^\s\n][^\n]*?))?\n([\s\S]*?)(?=\n(?:\* [Rr]ead|[Gg]rep|\* |\$ )|$)/g,
    (_match, pattern, dir, output) => {
      const patternTrimmed = pattern.trim();
      const dirPart = dir ? ` in ${dir.trim()}` : "";
      return `<details class="tool-call my-0.5"><summary class="${TOOL_LINE} cursor-pointer hover:text-gray-300"><b>Grepped</b> ${escapeHtml(patternTrimmed)}${escapeHtml(dirPart)}</summary><pre class="ml-3 mt-1 p-2 text-xs bg-surface-600/50 rounded overflow-x-auto whitespace-pre-wrap">${output}</pre></details>`;
    }
  );
}

/**
 * Format list/list_dir: "Listed path" and glob: "Globbed path" with collapsible output.
 */
function formatListInContent(content: string): string {
  return content.replace(
    /(Listed|Globbed)\s+([^\s\n][^\n]*)\n([\s\S]*?)(?=\n(?:Listed|Globbed)\s+|\n(?:Read|Edit|Grepped)\s+|\n\$ |\n\n|$)/g,
    (_match, label, path, output) => {
      const pathTrimmed = path.trim();
      const outTrimmed = output.trim();
      return `<details class="tool-call my-0.5"><summary class="${TOOL_LINE} cursor-pointer hover:text-gray-300"><b>${escapeHtml(label)}</b> ${escapeHtml(pathTrimmed)}</summary><pre class="ml-3 mt-1 p-2 text-xs bg-surface-600/50 rounded overflow-x-auto whitespace-pre-wrap">${escapeHtml(outTrimmed)}</pre></details>`;
    }
  );
}

/**
 * Format codebase_search: compact "Searched query".
 */
function formatSearchInContent(content: string): string {
  return content.replace(
    /(?:\* [Ss]earch(?:ed)?|[Ss]earch(?:ed)?)\s+([^\n]+?)\n([\s\S]*?)(?=\n(?:\* [Rr]ead|[Gg]rep|[Ss]earch|\* |\$ )|$)/g,
    (_match, query, output) => {
      return `<details class="tool-call my-0.5"><summary class="${TOOL_LINE} cursor-pointer hover:text-gray-300"><b>Searched</b> ${escapeHtml(query.trim())}</summary><pre class="ml-3 mt-1 p-2 text-xs bg-surface-600/50 rounded overflow-x-auto whitespace-pre-wrap">${output}</pre></details>`;
    }
  );
}

/**
 * Format background tasks: "Task name Ns".
 */
function formatTaskInContent(content: string): string {
  return content.replace(
    /^([^<\n]+?)\s+(\d+)s\s*$/gm,
    (_, name, secs) =>
      `<div class="${TOOL_LINE}"><b>${escapeHtml(name.trim())}</b> ${secs}s</div>`
  );
}

/** Checklist icon SVG for To-dos header */
const TODO_ICON =
  '<svg class="w-4 h-4 inline-block mr-1.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>';

/**
 * Format todo items as "To-dos N" block with checklist icon and checkbox list.
 * Matches: "Started to-do ✅ desc", "Started to-do desc", "- [x] item", "- [ ] item".
 */
function formatTodoInContent(content: string): string {
  const todoItems: { done: boolean; desc: string }[] = [];
  if (content.includes("Started to-do")) {
    const startedMatch = content.matchAll(/Started to-do\s+(✅\s*)?([^\n]+)/g);
    for (const m of startedMatch) {
      todoItems.push({ done: !!m[1], desc: m[2].trim() });
    }
  } else {
    const mdMatch = content.matchAll(/^[-*]\s+\[([ x])\]\s+(.+)$/gm);
    for (const m of mdMatch) {
      todoItems.push({ done: m[1].toLowerCase() === "x", desc: m[2].trim() });
    }
  }
  if (todoItems.length === 0) return content;
  const header = `To-dos ${todoItems.length}`;
  const listHtml = todoItems
    .map(
      (t) =>
        `<div class="flex items-center gap-2 py-0.5 text-sm text-gray-300">
          <span class="flex-shrink-0 w-4 h-4 rounded border border-gray-500 flex items-center justify-center ${t.done ? "bg-gray-500" : ""}">
            ${t.done ? '<svg class="w-2.5 h-2.5 text-gray-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>' : ""}
          </span>
          <span class="${t.done ? "line-through text-gray-500" : ""}">${escapeHtml(t.desc)}</span>
        </div>`
    )
    .join("");
  const block = `<div class="my-2 rounded-lg border border-surface-500 bg-surface-600/50 overflow-hidden">
    <div class="px-3 py-2 flex items-center gap-1 text-sm font-medium text-gray-300 border-b border-surface-500">
      ${TODO_ICON}${escapeHtml(header)}
    </div>
    <div class="px-3 py-2">${listHtml}</div>
  </div>`;
  // Replace "Started to-do" lines or markdown checklist with a single block
  const startedRegex = /(?:Started to-do\s+(?:✅\s*)?[^\n]+\n?)+/;
  const mdRegex = /(?:^[-*]\s+\[[ x]\]\s+[^\n]+\n?)+/gm;
  let out = content;
  if (content.includes("Started to-do")) {
    out = out.replace(startedRegex, block);
  } else {
    out = out.replace(mdRegex, block);
  }
  return out;
}

/** Escape HTML in a string for safe display. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** File icon for diff/edit blocks */
const FILE_ICON =
  '<svg class="w-4 h-4 inline-block mr-1.5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>';

/**
 * Format unified diff blocks: file header with +N -M, red for removals, green for additions.
 * Matches --- a/file, +++ b/file, @@ hunks. Collapsible when large. Also handles ```diff code blocks.
 */
function formatDiffInContent(content: string): string {
  let out = content;
  const unifiedDiff =
    /^(--- [^\n]+\n\+\+\+ [^\n]+)\n((?:@@[^\n]*\n(?:[^\n-+].*\n|-[^\n]*\n|\+[^\n]*\n)*)*)/gm;
  out = out.replace(unifiedDiff, (_match, header, body) => {
    const fromMatch = header.match(/^--- (?:a\/)?(.+)$/m);
    const toMatch = header.match(/^\+\+\+ (?:b\/)?(.+)$/m);
    const file = (toMatch?.[1] ?? fromMatch?.[1] ?? "file").trim();
    let adds = 0;
    let dels = 0;
    const lines = body.split("\n").map((line: string) => {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        adds++;
        return `<span class="block text-green-400 bg-green-900/30">${escapeHtml(line)}</span>`;
      }
      if (line.startsWith("-") && !line.startsWith("---")) {
        dels++;
        return `<span class="block text-red-400 bg-red-900/30">${escapeHtml(line)}</span>`;
      }
      return escapeHtml(line) || "";
    });
    const bodyHtml = lines.join("\n");
    const summary = ` <span class="text-gray-500 text-xs">+${adds} -${dels}</span>`;
    const isLarge = lines.length > 12;
    const visibleLines = isLarge ? lines.slice(0, 6) : lines;
    const hiddenCount = lines.length - visibleLines.length;
    const bodyContent = isLarge
      ? `<pre class="p-2 text-xs overflow-x-auto bg-surface-700/50 font-mono whitespace-pre">${visibleLines.join("\n")}</pre>
        <details class="group"><summary class="px-2 py-1.5 text-xs text-gray-500 cursor-pointer hover:bg-surface-600/50 flex items-center gap-1">
          <span class="transition-transform group-open:rotate-180">▼</span> ${hiddenCount} hidden line${hiddenCount !== 1 ? "s" : ""}
        </summary><pre class="p-2 text-xs overflow-x-auto bg-surface-700/50 font-mono whitespace-pre border-t border-surface-500">${lines.slice(6).join("\n")}</pre></details>`
      : `<pre class="p-2 text-xs overflow-x-auto bg-surface-700/50 font-mono whitespace-pre">${bodyHtml}</pre>`;
    return `<div class="my-2 rounded-lg border border-surface-500 overflow-hidden"><div class="px-3 py-2 flex items-center gap-1 bg-surface-600 text-sm font-medium text-gray-300 border-b border-surface-500">${FILE_ICON}${escapeHtml(file)}${summary}</div>${bodyContent}</div>`;
  });
  const diffCodeBlock = /```diff\n([\s\S]*?)```/g;
  out = out.replace(diffCodeBlock, (_m, block) => {
    const hasUnified = /^--- [^\n]+\n\+\+\+ [^\n]+/m.test(block);
    return hasUnified ? formatDiffInContent(block) : `<pre class="my-2 p-2 rounded border border-surface-500 bg-surface-700/50 text-xs font-mono overflow-x-auto">${block}</pre>`;
  });
  return out;
}

/** Simple markdown: ### headers, **bold**, `code`, Features: section, - bullets, ``` blocks. Escapes narrative but keeps code blocks readable. */
function formatMarkdownInContent(content: string): string {
  const codeBlocks: string[] = [];
  let out = content.replace(/```[\w]*\n([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code.trim());
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });
  out = escapeHtml(out);
  out = out.replace(/\x00CODE(\d+)\x00/g, (_, i) => {
    const code = codeBlocks[Number(i)] ?? "";
    return `<pre class="my-2 p-2 rounded border border-surface-500 bg-surface-700/50 text-xs font-mono overflow-x-auto whitespace-pre-wrap">${escapeHtml(code)}</pre>`;
  });
  return out
    .replace(/^### (.+)$/gm, '<h3 class="text-sm font-semibold text-gray-200 mt-3 mb-1">$1</h3>')
    .replace(/^Features:\s*$/gm, '<h3 class="text-sm font-semibold text-gray-200 mt-3 mb-1">Features</h3>')
    .replace(/^([-*])\s+([^\n]+)$/gm, (_, bullet, text) => {
      if (/^\[[ x]\]\s+/.test(text)) return bullet + " " + text;
      return `<div class="flex items-start gap-2 py-0.5 text-sm text-gray-300"><span class="text-gray-500 mt-0.5">•</span><span>${text.trim()}</span></div>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="text-gray-200">$1</strong>')
    .replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-surface-600 text-xs">$1</code>');
}

export interface FormattedAssistant {
  html: string;
  terminals: MiniTerminalProps[];
}

/** Parse saved content into text and "Edit path\ncontent" segments so we can render Edit blocks as MiniFileEditor. */
function parseContentWithEditBlocks(
  content: string
): ({ type: "text"; content: string } | { type: "edit"; path: string; content: string })[] {
  const segments: ({ type: "text"; content: string } | { type: "edit"; path: string; content: string })[] = [];
  const editRegex = /Edit\s+([^\n]+)\n([\s\S]*?)(?=\nEdit\s+|\nListed\s+|\nGlobbed\s+|\nRead\s+|\nGrepped\s+|\n\$ |$)/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  while ((match = editRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: content.slice(lastIndex, match.index) });
    }
    segments.push({ type: "edit", path: match[1].trim(), content: match[2] ?? "" });
    lastIndex = editRegex.lastIndex;
  }
  if (lastIndex < content.length) {
    segments.push({ type: "text", content: content.slice(lastIndex) });
  }
  return segments.length ? segments : [{ type: "text", content }];
}

/** Escape HTML, extract command blocks as terminal placeholders, then apply tool-call/diff/markdown formatting. */
function formatAssistantContent(content: string): FormattedAssistant {
  const escaped = escapeHtml(content);
  const { content: withPlaceholders, terminals } = extractTerminalsAndPlaceholders(escaped);
  const withEdit = formatEditInContent(withPlaceholders);
  const withRead = formatReadInContent(withEdit);
  const withList = formatListInContent(withRead);
  const withGrep = formatGrepInContent(withList);
  const withSearch = formatSearchInContent(withGrep);
  const withTodo = formatTodoInContent(withSearch);
  const withTask = formatTaskInContent(withTodo);
  const withDiff = formatDiffInContent(withTask);
  const html = formatMarkdownInContent(withDiff);
  return { html, terminals };
}

/** If path is absolute and contains workspaceId, return the part relative to workspace (for opening in editor). */
function toWorkspaceRelative(path: string, workspaceId: string): string {
  const normalized = path.replace(/\\/g, "/");
  const needle = `workspaces/${workspaceId}/`;
  const i = normalized.toLowerCase().indexOf(needle.toLowerCase());
  if (i !== -1) return normalized.slice(i + needle.length).replace(/\//g, "/");
  return path;
}

interface ChatPanelProps {
  workspaceId: string;
  selectedFilePath: string | null;
  session?: Session | null;
  onAgentComplete?: () => void;
  onAgentChunk?: (chunk: string) => void;
  onSessionTitleUpdate?: (title: string) => void;
  /** Add a mini-terminal's output to the main terminal panel (show in main terminal). */
  onAddCursorSession?: (fullCmd: string, output: string) => void;
  /** Open a file in the editor (path can be absolute; will be normalized for workspace). */
  onOpenFile?: (path: string) => void;
  /** Called when the agent starts a dev server and the backend detects a preview URL (and optional port for iframe key). */
  onPreviewReady?: (url: string, port?: number) => void;
  /** Called when the workspace app rebuilds (e.g. HMR) so the preview iframe can auto-reload. */
  onPreviewRefresh?: () => void;
  /** When true, first user message triggers project naming AI (blank project only). False for opened or cloned projects. */
  enableProjectNaming?: boolean;
}

/** Text chunk from the agent (narrative). */
export interface TextBlock {
  type: "text";
  content: string;
}

/** Structured tool call (pending or completed); rendered as MiniTerminal, MiniFileEditor, or collapsible. */
export interface ToolCallBlock {
  type: "tool";
  callId: string;
  tool: string;
  path?: string;
  command?: string;
  content?: string;
  pending: boolean;
  /** For bash: true if command failed (non-zero exit). */
  failed?: boolean;
  /** For read tool: line range (1-indexed). */
  startLine?: number;
  endLine?: number;
  /** For todowrite/todoread: list of tasks (id, content, status). */
  todos?: { id: string; content: string; status?: string }[];
}

/** Merge consecutive read blocks that are split as "App" + ".jsx" or "App" + "App.jsx" (with range) into one "Read App.jsx L1-59". */
function mergeReadBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type !== "tool" || (b.tool !== "read" && b.tool !== "read_file")) {
      out.push(b);
      continue;
    }
    const prev = out[out.length - 1];
    const isPrevRead =
      prev?.type === "tool" && (prev.tool === "read" || prev.tool === "read_file");
    const prevPath = isPrevRead ? (prev as ToolCallBlock).path ?? "" : "";
    const prevBase = prevPath.replace(/^<path>\s*/i, "").trim().split(/[/\\]/).pop() || prevPath.trim();
    const currPath = (b.path ?? "").replace(/^<path>\s*/i, "").trim();
    const currBase = currPath.split(/[/\\]/).pop() || currPath;
    const prevHasNoExt = prevBase.length > 0 && !prevBase.includes(".");
    const currIsExtOnly = /^\.\w+$/.test(currBase) && b.startLine != null && b.endLine != null;
    const currStemMatchesPrev = prevHasNoExt && currBase.startsWith(prevBase + ".");
    if (isPrevRead && prevHasNoExt && (currIsExtOnly || currStemMatchesPrev) && (b.startLine != null && b.endLine != null)) {
      const mergedPath = currIsExtOnly ? prevBase + currBase : currPath;
      (out[out.length - 1] as ToolCallBlock).path = mergedPath;
      (out[out.length - 1] as ToolCallBlock).startLine = b.startLine;
      (out[out.length - 1] as ToolCallBlock).endLine = b.endLine;
      (out[out.length - 1] as ToolCallBlock).content = b.content;
      (out[out.length - 1] as ToolCallBlock).pending = b.pending;
      continue;
    }
    out.push(b);
  }
  return out;
}

export type ContentBlock = TextBlock | ToolCallBlock;

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  thinking?: string;
  /** When present, assistant message is rendered from blocks (text + tool cards) instead of content. */
  blocks?: ContentBlock[];
}

export default function ChatPanel({
  workspaceId,
  selectedFilePath,
  session,
  onAgentComplete,
  onAgentChunk,
  onSessionTitleUpdate,
  onAddCursorSession,
  onOpenFile,
  onPreviewReady,
  onPreviewRefresh,
  enableProjectNaming = false,
}: ChatPanelProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [attachedImages, setAttachedImages] = useState<Array<{ id: string; dataUrl: string; mimeType?: string }>>([]);
  const [streaming, setStreaming] = useState(false);
  const [closedTerminals, setClosedTerminals] = useState<Set<string>>(new Set());
  const [wsError, setWsError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("opencode/minimax-m2.5-free");
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const infinityDropdownRef = useRef<HTMLDivElement>(null);
  const [agentMode, setAgentMode] = useState<"Agent" | "Plan" | "Debug" | "Ask">("Ask");
  const [infinityDropdownOpen, setInfinityDropdownOpen] = useState(false);
  const streamBufferRef = useRef<string>("");
  const blocksRef = useRef<ContentBlock[]>([]);
  const thinkingBufferRef = useRef<string>("");
  const skipLoadForSessionRef = useRef<string | null>(null);
  const messagesRef = useRef<Message[]>(messages);
  messagesRef.current = messages;

  /** Serialize blocks to the same format we used to save (for persistence). */
  function blocksToContent(blocks: ContentBlock[]): string {
    return blocks
      .map((b) => {
        if (b.type === "text") return b.content;
        if (b.tool === "bash" && b.command !== undefined)
          return `$ ${b.command}\n${b.content ?? ""}`;
        if ((b.tool === "read" || b.tool === "read_file") && b.path) {
          const cleanPath = b.path.replace(/^<path>\s*/i, "").trim();
          const basename = cleanPath.split(/[/\\]/).pop() || cleanPath;
          const range = b.startLine != null && b.endLine != null ? ` L${b.startLine} - ${b.endLine}` : "";
          return `Read ${basename}${range}\n`;
        }
        if (b.tool === "grep" || b.tool === "grep_search") {
          const summary = (b as ToolCallBlock).path?.trim() ? `Grepped ${(b as ToolCallBlock).path}\n` : "Grepped\n";
          return `${summary}${b.content ?? ""}`;
        }
        if (b.tool === "file_search" && b.path) return `Searched ${b.path}\n${b.content ?? ""}`;
        if ((b.tool === "websearch" || b.tool === "web_search") && b.path) return `Searched web ${b.path}\n${b.content ?? ""}`;
        if ((b.tool === "list" || b.tool === "list_dir" || b.tool === "glob") && b.path !== undefined) {
          const label = b.tool === "glob" ? "Globbed" : "Listed";
          return `${label} ${b.path}\n${b.content ?? ""}`;
        }
        if ((b.tool === "edit" || b.tool === "write" || b.tool === "search_replace") && b.path)
          return `Edit ${b.path}\n${b.content ?? ""}`;
        if ((b.tool === "todowrite" || b.tool === "todoread") && (b as ToolCallBlock).todos?.length) {
          const todos = (b as ToolCallBlock).todos!;
          return `To-dos (${todos.length})\n${todos.map((t) => `- [${t.status === "completed" ? "x" : " "}] ${t.content}`).join("\n")}\n`;
        }
        return `${b.tool}\n${b.content ?? ""}`;
      })
      .join("");
  }

  const loadSessions = async () => {
    if (!session?.user || !workspaceId) return;
    const supabase = createSupabaseClient();
    const { data } = await supabase
      .from("chat_sessions")
      .select("id, title")
      .eq("project_id", workspaceId)
      .eq("user_id", session.user.id)
      .order("updated_at", { ascending: false });
    const list = (data ?? []).map((s) => ({ id: s.id, title: s.title }));
    setSessions(list);
    setActiveSessionId(list.length > 0 ? list[0].id : null);
  };

  const loadMessages = async (sessionId: string) => {
    const supabase = createSupabaseClient();
    const { data } = await supabase
      .from("chat_messages")
      .select("id, role, content")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });
    setMessages(
      (data ?? []).map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        content: m.content,
      }))
    );
  };

  useEffect(() => {
    if (session?.user && workspaceId) loadSessions();
  }, [session?.user?.id, workspaceId]);

  useEffect(() => {
    setMessages([]);
    setActiveSessionId(null);
    setSessions([]);
  }, [workspaceId]);

  useEffect(() => {
    return () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "abort", workspaceId }));
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    if (skipLoadForSessionRef.current === activeSessionId) {
      skipLoadForSessionRef.current = null;
      return;
    }
    loadMessages(activeSessionId);
  }, [activeSessionId]);

  useEffect(() => {
    listModels().then((list) => {
      const fallback: ModelOption[] = [
        { id: "opencode/minimax-m2.5-free", label: "MiniMax M2.5 Free (Zen)" },
        { id: "opencode/glm-5-free", label: "GLM 5 Free (Zen)" },
        { id: "opencode/gpt-5-nano", label: "GPT 5 Nano (Zen)" },
      ];
      const modelsList = list.length > 0 ? list : fallback;
      setModels(modelsList);
      if (!modelsList.some((m) => m.id === selectedModel)) setSelectedModel(modelsList[0].id);
    });
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const onOutside = (e: MouseEvent) => {
      if (infinityDropdownRef.current && !infinityDropdownRef.current.contains(e.target as Node)) {
        setInfinityDropdownOpen(false);
      }
    };
    if (infinityDropdownOpen) {
      document.addEventListener("mousedown", onOutside);
      return () => document.removeEventListener("mousedown", onOutside);
    }
  }, [infinityDropdownOpen]);

  const createNewChat = async () => {
    if (!session?.user || !workspaceId) return;
    const supabase = createSupabaseClient();
    const { data, error } = await supabase
      .from("chat_sessions")
      .insert({ project_id: workspaceId, user_id: session.user.id, title: "New Chat" })
      .select("id")
      .single();
    if (!error && data) {
      setSessions((prev) => [{ id: data.id, title: "New Chat" }, ...prev]);
      setActiveSessionId(data.id);
      setMessages([]);
    }
  };

  const sendMessage = async () => {
    const text = input.trim();
    const hasImages = attachedImages.length > 0;
    if ((!text && !hasImages) || streaming || !session?.user || !workspaceId) return;

    let sessId = activeSessionId;

    if (!sessId) {
      const supabase = createSupabaseClient();
      const { data, error: sessErr } = await supabase
        .from("chat_sessions")
        .insert({ project_id: workspaceId, user_id: session.user.id, title: "New Chat" })
        .select("id")
        .single();
      if (sessErr || !data) {
        console.error("[Chat] Failed to create session:", sessErr);
        setWsError("Failed to create chat session. Check Supabase config and RLS.");
        return;
      }
      sessId = data.id;
      skipLoadForSessionRef.current = data.id;
      setSessions((prev) => [{ id: data.id, title: "New Chat" }, ...prev]);
      setActiveSessionId(data.id);
    }

    let messageToSend = text;
    if (hasImages) {
      try {
        const imagePayloads = attachedImages.map((img) => {
          const base64 = img.dataUrl.includes(",") ? img.dataUrl.split(",")[1] : img.dataUrl;
          return { data: base64 ?? "", mimeType: img.mimeType || "image/png" };
        });
        const descriptions = await describeImages(imagePayloads);
        const imageBlock =
          `[User sent ${attachedImages.length} image(s). Image descriptions:]\n\n` +
          descriptions.map((d, i) => `Image ${i + 1}: ${d}`).join("\n\n");
        messageToSend = text ? `${imageBlock}\n\n---\n\nUser message: ${text}` : imageBlock;
      } catch (err) {
        console.error("[Chat] Failed to describe images:", err);
        setWsError("Failed to describe images. Check GEMINI_API_KEY and try again.");
        setStreaming(false);
        return;
      }
      setAttachedImages([]);
    }

    const previousMessages = messagesRef.current;
    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: messageToSend };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setStreaming(true);
    setWsError(null);

    if (enableProjectNaming) {
      const suggestedName = await suggestProjectName(messageToSend).catch(() => null);
      if (suggestedName && session?.access_token) {
        updateProjectName(workspaceId, suggestedName, session.access_token).catch(() => {});
        onSessionTitleUpdate?.(suggestedName);
      }
    }

    const supabase = createSupabaseClient();
    const { error: userMsgErr } = await supabase
      .from("chat_messages")
      .insert({ session_id: sessId, role: "user", content: messageToSend });
    if (userMsgErr) console.error("[Chat] Failed to save user message:", userMsgErr);

    const updateSessionTitle = async (
      content: string,
      sessId: string,
      alsoUpdateProjectName: boolean
    ) => {
      const title = await generateChatTitle(content).catch(() => content.slice(0, 30).trim() || "New Chat");
      const supabase = createSupabaseClient();
      const { error } = await supabase.from("chat_sessions").update({ title }).eq("id", sessId);
      if (!error) setSessions((prev) => prev.map((s) => (s.id === sessId ? { ...s, title } : s)));
      if (alsoUpdateProjectName && title && session?.access_token) {
        updateProjectName(workspaceId, title, session.access_token).catch(() => {});
        onSessionTitleUpdate?.(title);
      }
    };
    if (sessId && previousMessages.length === 0) {
      updateSessionTitle(messageToSend, sessId, false);
    }
    const assistantId = crypto.randomUUID();
    setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "", streaming: true, blocks: [] }]);
    streamBufferRef.current = "";
    blocksRef.current = [];
    thinkingBufferRef.current = "";

    const url = getAgentWebSocketUrl();
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      const messageWithHistory = buildMessageWithHistory(previousMessages, messageToSend);
      const conversationMessages = previousMessages.slice(-20).map((m) => ({
        role: m.role as "user" | "assistant",
        content: (m.content || "").trim(),
      }));
      ws.send(JSON.stringify({
        type: "run",
        workspaceId,
        message: messageWithHistory,
        currentUserMessage: messageToSend,
        conversationMessages: conversationMessages.length > 0 ? conversationMessages : undefined,
        chatSessionId: sessId,
        model: selectedModel,
        agentMode: agentMode,
      }));
    };

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data.type === "chunk") {
          const raw = data.data ?? "";
          onAgentChunk?.(raw);
          const cleaned = cleanOutput(raw);
          streamBufferRef.current += cleaned;
          blocksRef.current = [...blocksRef.current, { type: "text", content: cleaned }];
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: streamBufferRef.current, blocks: [...blocksRef.current] } : m
            )
          );
        } else if (data.type === "tool_call") {
          const callId = data.callId ?? `tool-${blocksRef.current.length}`;
          const toolBlock: ToolCallBlock = {
            type: "tool",
            callId,
            tool: data.tool ?? "unknown",
            path: data.path,
            command: data.command,
            content: data.content,
            pending: !!data.pending,
            failed: data.failed === true,
            startLine: typeof data.startLine === "number" ? data.startLine : undefined,
            endLine: typeof data.endLine === "number" ? data.endLine : undefined,
            todos: Array.isArray(data.todos) ? data.todos as { id: string; content: string; status?: string }[] : undefined,
          };
          let idx = blocksRef.current.findIndex((b) => b.type === "tool" && b.callId === callId);
          const isTerminalTool = data.tool === "bash" || data.tool === "run_terminal_cmd";
          if (idx < 0 && isTerminalTool && !data.pending && typeof data.command === "string") {
            const cmd = String(data.command).trim();
            idx = blocksRef.current.findIndex(
              (b) => b.type === "tool" && ((b as ToolCallBlock).tool === "bash" || (b as ToolCallBlock).tool === "run_terminal_cmd") && (b as ToolCallBlock).pending && (b as ToolCallBlock).command?.trim() === cmd
            );
            if (idx >= 0) (toolBlock as ToolCallBlock).callId = (blocksRef.current[idx] as ToolCallBlock).callId;
          } else if (idx < 0 && !data.pending && (data.tool === "read_file" || data.tool === "list_dir" || data.tool === "edit_file" || data.tool === "search_replace" || data.tool === "write_file" || data.tool === "file_search" || data.tool === "grep_search" || data.tool === "grep" || data.tool === "websearch" || data.tool === "web_search" || data.tool === "delete_file")) {
            const pathMatch = typeof data.path === "string" ? data.path.trim() : "";
            idx = blocksRef.current.findIndex((b) => {
              if (b.type !== "tool") return false;
              const tb = b as ToolCallBlock;
              if (!tb.pending) return false;
              if (tb.tool !== data.tool) return false;
              const p = (tb.path ?? "").trim();
              return pathMatch === p || (pathMatch && p && (pathMatch.endsWith(p) || p.endsWith(pathMatch)));
            });
            if (idx >= 0) (toolBlock as ToolCallBlock).callId = (blocksRef.current[idx] as ToolCallBlock).callId;
          }
          if (idx >= 0) {
            blocksRef.current = [...blocksRef.current];
            const prev = blocksRef.current[idx] as ToolCallBlock;
            if (isTerminalTool && toolBlock.command == null && prev.command != null)
              (toolBlock as ToolCallBlock).command = prev.command;
            // Preserve failed state: stream may send completed without failed; don't overwrite failed=true
            if (isTerminalTool && prev.failed === true && data.failed !== true)
              (toolBlock as ToolCallBlock).failed = true;
            blocksRef.current[idx] = toolBlock;
          } else {
            blocksRef.current = [...blocksRef.current, toolBlock];
          }
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, blocks: [...blocksRef.current] } : m))
          );
        } else if (data.type === "tool_output_stream") {
          const callId = data.callId;
          const chunk = data.chunk ?? "";
          if (callId && chunk) {
            const idx = blocksRef.current.findIndex((b) => b.type === "tool" && b.callId === callId);
            if (idx >= 0) {
              blocksRef.current = [...blocksRef.current];
              const block = blocksRef.current[idx] as ToolCallBlock;
              (blocksRef.current[idx] as ToolCallBlock).content = (block.content ?? "") + chunk;
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, blocks: [...blocksRef.current] } : m))
              );
            }
          }
        } else if (data.type === "tool_output_end") {
          const callId = data.callId;
          const exitCode = data.exitCode;
          if (callId != null) {
            const idx = blocksRef.current.findIndex((b) => b.type === "tool" && b.callId === callId);
            if (idx >= 0) {
              blocksRef.current = [...blocksRef.current];
              (blocksRef.current[idx] as ToolCallBlock).pending = false;
              (blocksRef.current[idx] as ToolCallBlock).failed = exitCode !== undefined && exitCode !== 0;
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, blocks: [...blocksRef.current] } : m))
              );
            }
          }
        } else if (data.type === "thinking") {
          const text = data.data ?? "";
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, thinking: (m.thinking ?? "") + text } : m
            )
          );
        } else if (data.type === "preview_ready" && data.workspaceId === workspaceId && data.url) {
          onPreviewReady?.(data.url, data.port);
        } else if (data.type === "preview_refresh" && data.workspaceId === workspaceId) {
          onPreviewRefresh?.();
        } else if (data.type === "end") {
          const contentToSave = blocksRef.current.length > 0 ? blocksToContent(blocksRef.current) : streamBufferRef.current || "(No response)";
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: contentToSave, streaming: false } : m))
          );
          setStreaming(false);
          ws.close();
          const sid = sessId;
          if (sid) {
            const { error: assistErr } = await createSupabaseClient()
              .from("chat_messages")
              .insert({ session_id: sid, role: "assistant", content: contentToSave });
            if (assistErr) console.error("[Chat] Failed to save assistant message:", assistErr);
          }
          onAgentComplete?.();
        } else if (data.type === "error") {
          const errText = data.error || "Unknown error";
          onAgentChunk?.(`\r\nError: ${errText}\r\n`);
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: `Error: ${errText}`, streaming: false } : m))
          );
          setStreaming(false);
          ws.close();
          if (sessId) {
            const { error: errMsgErr } = await createSupabaseClient()
              .from("chat_messages")
              .insert({ session_id: sessId, role: "assistant", content: `Error: ${errText}` });
            if (errMsgErr) console.error("[Chat] Failed to save error message:", errMsgErr);
          }
          onAgentComplete?.();
        }
      } catch {
        /* ignore */
      }
    };

    ws.onerror = () => setWsError("WebSocket error");
    ws.onclose = (ev) => {
      setStreaming(false);
      wsRef.current = null;
      if (ev.code !== 1000 && ev.code !== 1005) {
        setWsError("Connection closed. Is the backend running on port 3001?");
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId && m.streaming
              ? { ...m, content: "Connection failed. Start the backend and try again.", streaming: false }
              : m
          )
        );
      }
    };
  };

  const abortRun = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "abort", workspaceId }));
      wsRef.current.close();
    }
    setStreaming(false);
  };

  return (
    <div className="h-full flex flex-col bg-[#1A1A1A] border-l border-surface-500">
      <div className="flex-shrink-0 flex flex-col bg-[#1A1A1A]">
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-surface-500 overflow-x-auto bg-[#1A1A1A]">
          <button
            type="button"
            onClick={createNewChat}
            className="flex-shrink-0 p-1.5 rounded text-gray-500 hover:bg-surface-600 hover:text-gray-300"
            title="New chat"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setActiveSessionId(s.id)}
              className={`flex-shrink-0 px-2.5 py-1.5 rounded text-xs truncate max-w-[120px] ${
                s.id === activeSessionId
                  ? "bg-surface-600 text-gray-200"
                  : "text-gray-500 hover:bg-surface-600/50 hover:text-gray-400"
              }`}
            >
              {s.title || "New Chat"}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
        {messages.length === 0 && (
          <p className="text-gray-500 text-sm">
            Ask OpenCode to build features, fix bugs, or explain code. Type below and press Enter.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "text-right" : "text-left"}>
            <span className="text-xs text-gray-500 block mb-0.5">{m.role === "user" ? "You" : "OpenCode"}</span>
            {m.role === "assistant" && (m.streaming || m.thinking) && !m.content && (
              <div className="mt-1">
                <JumpingDots />
              </div>
            )}
            <div
              className={
                m.role === "user"
                  ? "inline-block text-sm bg-surface-600 rounded-lg px-3 py-2 text-left max-w-[95%]"
                  : "text-sm text-gray-300 whitespace-pre-wrap break-words"
              }
            >
              {m.role === "user"
                ? (() => {
                    const visible = getUserVisibleContent(m.content || "");
                    return visible || "Sent with image(s)";
                  })()
                : (() => {
                    if (m.blocks && m.blocks.length > 0) {
                      const blocksToRender = mergeReadBlocks(m.blocks);
                      const merged: ({ type: "text"; content: string } | ToolCallBlock)[] = [];
                      let textAcc = "";
                      for (const b of blocksToRender) {
                        if (b.type === "text") {
                          textAcc += b.content;
                        } else {
                          if (textAcc) {
                            const trimmed = textAcc.trim();
                            const singleWordNoExt = /^[A-Za-z0-9_-]+$/.test(trimmed) && trimmed.length > 0;
                            const isRead = b.type === "tool" && (b.tool === "read" || b.tool === "read_file");
                            const bPath = (b as ToolCallBlock).path ?? "";
                            const bBase = bPath.replace(/^<path>\s*/i, "").trim().split(/[/\\]/).pop() || bPath.trim();
                            const extOnly = /^\.\w+$/.test(bBase) && (b as ToolCallBlock).startLine != null && (b as ToolCallBlock).endLine != null;
                            if (singleWordNoExt && isRead && extOnly) {
                              const mergedPath = trimmed + bBase;
                              merged.push({ ...(b as ToolCallBlock), path: mergedPath });
                              textAcc = "";
                              continue;
                            }
                            merged.push({ type: "text", content: textAcc });
                            textAcc = "";
                          }
                          merged.push(b);
                        }
                      }
                      if (textAcc) merged.push({ type: "text", content: textAcc });

                      const TOOL_SPINNER = (
                        <svg className="w-4 h-4 text-gray-500 animate-spin shrink-0 inline" fill="none" viewBox="0 0 24 24">
                          <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeDasharray="24 16" />
                        </svg>
                      );
                      return (
                        <>
                          {merged.map((block, i) => {
                            if (block.type === "text") {
                              const html = formatMarkdownInContent(block.content);
                              return <span key={`t-${i}`} dangerouslySetInnerHTML={{ __html: html }} />;
                            }
                            const tb = block as ToolCallBlock;
                            const terminalKey = `${m.id}-${tb.callId}`;
                            if (tb.tool === "bash" || tb.tool === "run_terminal_cmd") {
                              if (tb.command !== undefined) {
                                const label = tb.pending ? "Running" : "Ran";
                                const cmdName = commandNameForHeader(tb.command);
                                return (
                                  <MiniTerminal
                                    key={tb.callId}
                                    label={label}
                                    cmdName={cmdName}
                                    fullCmd={tb.command}
                                    output={tb.content ?? ""}
                                    failed={tb.failed ?? false}
                                    aborted={closedTerminals.has(terminalKey)}
                                    onShowInMainTerminal={() => onAddCursorSession?.(tb.command ?? "", tb.content ?? "")}
                                    onClose={() => setClosedTerminals((prev) => new Set([...prev, terminalKey]))}
                                    onKill={() => void killCommand(workspaceId, tb.callId)}
                                  />
                                );
                              }
                            }
                            if ((tb.tool === "edit" || tb.tool === "write" || tb.tool === "edit_file" || tb.tool === "write_file" || tb.tool === "search_replace") && tb.path) {
                              const hasPath = Boolean(tb.path && tb.path.trim());
                              const hasContent = tb.content !== undefined && tb.content !== null;
                              const showEditor = hasPath;
                              if (closedTerminals.has(terminalKey)) {
                                return (
                                  <div key={tb.callId} className="my-1.5 rounded border border-[#3c3c3c] bg-[#252526] px-3 py-2 text-xs text-[#858585]">
                                    File editor closed
                                  </div>
                                );
                              }
                              if (showEditor) {
                                return (
                                  <MiniFileEditor
                                    key={tb.callId}
                                    path={tb.path!.trim()}
                                    content={tb.content ?? ""}
                                    pending={tb.pending}
                                    label={tb.tool === "write" || tb.tool === "write_file" ? "Write" : "Edit"}
                                    workspaceId={workspaceId}
                                    onClose={() => setClosedTerminals((prev) => new Set([...prev, terminalKey]))}
                                    onOpenFile={onOpenFile ? (p) => onOpenFile(toWorkspaceRelative(p, workspaceId)) : undefined}
                                  />
                                );
                              }
                              const label = tb.tool === "write" || tb.tool === "write_file" ? "Write" : "Edit";
                              return (
                                <details key={tb.callId} className="tool-call my-0.5">
                                  <summary className={`${TOOL_LINE} cursor-pointer hover:text-gray-300 flex items-center gap-1.5`}>
                                    {tb.pending && TOOL_SPINNER}
                                    <span className="font-medium text-gray-200">{label}</span>{" "}
                                    {hasPath ? tb.path : "path required"}
                                    {!hasContent && !tb.pending && " — content required"}
                                  </summary>
                                  {(tb.content ?? "").trim() && (
                                    <pre className="ml-3 mt-1 p-2 text-xs bg-surface-600/50 rounded overflow-x-auto whitespace-pre-wrap max-h-[7.5rem]">
                                      {tb.content}
                                    </pre>
                                  )}
                                </details>
                              );
                            }
                            if (tb.tool === "read" || tb.tool === "read_file") {
                              const cleanPath = (tb.path ?? "").replace(/^<path>\s*/i, "").trim();
                              const basename = cleanPath.split(/[/\\]/).pop() || cleanPath;
                              const range = tb.startLine != null && tb.endLine != null ? ` L${tb.startLine} - ${tb.endLine}` : "";
                              const readLabel = tb.pending ? "Reading" : "Read";
                              const openPath = tb.path && onOpenFile ? () => onOpenFile(toWorkspaceRelative(cleanPath, workspaceId)) : undefined;
                              const summaryText = `${readLabel} ${basename}${range}`;
                              return (
                                <div key={tb.callId} className={`${TOOL_LINE} my-0.5 whitespace-nowrap min-w-0 overflow-hidden`} title={summaryText}>
                                  <span className="font-medium text-gray-200">{readLabel}</span>{" "}
                                  {openPath ? (
                                    <button
                                      type="button"
                                      onClick={openPath}
                                      className="hover:text-blue-400 hover:underline cursor-pointer text-left truncate inline-block max-w-full align-baseline"
                                    >
                                      {basename}
                                      {range}
                                    </button>
                                  ) : (
                                    <span className="truncate inline-block max-w-full">
                                      {basename}
                                      {range}
                                    </span>
                                  )}
                                </div>
                              );
                            }
                            if (tb.tool === "read_lints") {
                              const label = tb.pending
                                ? "Reading lints"
                                : (() => {
                                    const c = (tb.content ?? "").trim();
                                    if (/^No linting errors found/i.test(c)) return "No linting errors found";
                                    const m = c.match(/^(\d+)\s+linting error(s?) found/i);
                                    return m ? `${m[1]} linting error${m[2]} found` : "Lints";
                                  })();
                              return (
                                <div
                                  key={tb.callId}
                                  className={`${TOOL_LINE} my-0.5 whitespace-nowrap min-w-0 overflow-hidden`}
                                  title={label}
                                >
                                  <span className="inline-flex items-baseline gap-1 min-w-0">
                                    {tb.pending && <span className="shrink-0">{TOOL_SPINNER}</span>}
                                    <strong className="font-semibold text-gray-200">{label}</strong>
                                  </span>
                                  {!tb.pending && (tb.content ?? "").trim() && (tb.content ?? "").includes("\n\n") && (
                                    <details className="ml-3 mt-0.5">
                                      <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-400">Details</summary>
                                      <pre className="mt-1 p-2 text-xs bg-surface-600/50 rounded overflow-x-auto whitespace-pre-wrap max-h-32">
                                        {(tb.content ?? "").trim().split("\n\n").slice(1).join("\n\n")}
                                      </pre>
                                    </details>
                                  )}
                                </div>
                              );
                            }
                            if (tb.tool === "file_search") {
                              const query = (tb.path ?? "").trim() || "query";
                              const searchLabel = tb.pending ? "Searching" : "Searched";
                              return (
                                <div
                                  key={tb.callId}
                                  className={`${TOOL_LINE} my-0.5 whitespace-nowrap min-w-0 overflow-hidden`}
                                  title={`${searchLabel} ${query}`}
                                >
                                  <span className="font-medium text-gray-200">{searchLabel}</span>{" "}
                                  <span className="truncate inline-block max-w-full">{query}</span>
                                </div>
                              );
                            }
                            if (tb.tool === "websearch" || tb.tool === "web_search") {
                              const searchTerm = (tb.path ?? "").trim() || "query";
                              const searchLabel = tb.pending ? "Searching" : "Searched";
                              return (
                                <div
                                  key={tb.callId}
                                  className={`${TOOL_LINE} my-0.5 whitespace-nowrap min-w-0 overflow-hidden`}
                                  title={`${searchLabel} web ${searchTerm}`}
                                >
                                  <span className="font-medium text-gray-200">{searchLabel} web</span>{" "}
                                  <span className="truncate inline-block max-w-full">{searchTerm}</span>
                                </div>
                              );
                            }
                            if (tb.tool === "list" || tb.tool === "list_dir" || tb.tool === "glob") {
                              const label = tb.tool === "glob" ? "Globbed" : "Listed";
                              const pathOrPattern = (tb.path ?? tb.command ?? "").trim();
                              const displayValue = pathOrPattern || (tb.tool === "glob" ? "pattern" : "path");
                              const lineLabel = tb.pending ? (tb.tool === "glob" ? "Globbing" : "Listing") : label;
                              return (
                                <div
                                  key={tb.callId}
                                  className={`${TOOL_LINE} my-0.5 whitespace-nowrap min-w-0 overflow-hidden`}
                                  title={`${lineLabel} ${displayValue}`}
                                >
                                  <span className="inline-flex items-baseline gap-1 min-w-0">
                                    {tb.pending && <span className="shrink-0">{TOOL_SPINNER}</span>}
                                    <span className="shrink-0 font-medium text-gray-200">{lineLabel}</span>
                                    <span className="truncate min-w-0">{displayValue}</span>
                                  </span>
                                </div>
                              );
                            }
                            if (tb.tool === "grep" || tb.tool === "grep_search") {
                              const summary = (tb.path ?? tb.command ?? "").trim() || "pattern";
                              const lineLabel = tb.pending ? "Grepping" : "Grepped";
                              return (
                                <div
                                  key={tb.callId}
                                  className={`${TOOL_LINE} my-0.5 whitespace-nowrap min-w-0 overflow-hidden`}
                                  title={`${lineLabel} ${summary}`}
                                >
                                  <span className="inline-flex items-baseline gap-1 min-w-0">
                                    {tb.pending && <span className="shrink-0">{TOOL_SPINNER}</span>}
                                    <span className="shrink-0 font-medium text-gray-200">{lineLabel}</span>{" "}
                                    <span className="truncate min-w-0">{summary}</span>
                                  </span>
                                </div>
                              );
                            }
                            if (tb.tool === "delete_file") {
                              const cleanPath = (tb.path ?? "").replace(/^<path>\s*/i, "").trim();
                              const basename = cleanPath.split(/[/\\]/).pop() || cleanPath || "file";
                              const lineLabel = tb.pending ? "Deleting" : "Deleted";
                              const openPath = tb.path && onOpenFile ? () => onOpenFile(toWorkspaceRelative(cleanPath, workspaceId)) : undefined;
                              const summaryText = `${lineLabel} ${basename}`;
                              return (
                                <div key={tb.callId} className={`${TOOL_LINE} my-0.5 whitespace-nowrap min-w-0 overflow-hidden`} title={summaryText}>
                                  <span className="font-medium text-gray-200">{lineLabel}</span>{" "}
                                  {openPath ? (
                                    <button
                                      type="button"
                                      onClick={openPath}
                                      className="hover:text-blue-400 hover:underline cursor-pointer text-left truncate inline-block max-w-full align-baseline"
                                    >
                                      {basename}
                                    </button>
                                  ) : (
                                    <span className="truncate inline-block max-w-full">{basename}</span>
                                  )}
                                </div>
                              );
                            }
                            if (tb.tool === "todowrite" || tb.tool === "todoread") {
                              const todoList = tb.todos && tb.todos.length > 0
                                ? tb.todos
                                : (() => {
                                    if (!tb.content?.trim()) return [];
                                    try {
                                      const parsed = JSON.parse(tb.content) as unknown;
                                      return Array.isArray(parsed) ? parsed as { id: string; content: string; status?: string }[] : [];
                                    } catch {
                                      return [];
                                    }
                                  })();
                              const count = todoList.length;
                              return (
                                <div key={tb.callId} className="my-1.5 rounded-lg border border-[#3c3c3c] bg-[#2d2d2d] px-3 py-2.5 text-sm text-gray-300">
                                  <div className="flex items-center gap-2 mb-2">
                                    <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                                    </svg>
                                    <span className="font-medium text-gray-200">To-dos</span>
                                    {count > 0 && <span className="text-gray-500">{count}</span>}
                                  </div>
                                  {tb.pending && !todoList.length ? (
                                    <div className="flex items-center gap-2 text-gray-500">
                                      {TOOL_SPINNER}
                                      <span>Updating task list…</span>
                                    </div>
                                  ) : todoList.length > 0 ? (
                                    <ul className="space-y-1.5 list-none pl-0">
                                      {todoList.map((todo) => {
                                        const done = todo.status === "completed";
                                        return (
                                          <li key={todo.id} className="flex items-start gap-2">
                                            <span className="shrink-0 mt-0.5 flex items-center justify-center w-4 h-4 rounded border border-gray-500 bg-[#252526] text-gray-400">
                                              {done ? (
                                                <svg className="w-3 h-3 text-gray-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                                </svg>
                                              ) : null}
                                            </span>
                                            <span className={done ? "text-gray-500 line-through" : undefined}>{todo.content}</span>
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  ) : null}
                                </div>
                              );
                            }
                            const label =
                              tb.tool === "glob" ? "Globbed" : tb.tool === "list" || tb.tool === "list_dir" ? "Listed" : tb.tool === "grep" || tb.tool === "grep_search" ? "Grepped" : tb.tool === "file_search" ? "Searched" : tb.tool === "websearch" || tb.tool === "web_search" ? "Searched web" : tb.tool;
                            const pathOrCmd = tb.path ?? tb.command ?? "";
                            if (closedTerminals.has(terminalKey)) {
                              return (
                                <div key={tb.callId} className="my-1.5 rounded border border-[#3c3c3c] bg-[#252526] px-3 py-2 text-xs text-[#858585]">
                                  Card closed
                                </div>
                              );
                            }
                            return (
                              <ToolCallCard
                                key={tb.callId}
                                label={label}
                                pathOrCommand={pathOrCmd}
                                content={tb.content ?? ""}
                                pending={tb.pending}
                                onOpenFile={undefined}
                                onClose={() => setClosedTerminals((prev) => new Set([...prev, terminalKey]))}
                              />
                            );
                          })}
                        </>
                      );
                    }
                    const rawContent = m.content || (m.streaming && m.content ? "…" : "");
                    const parsed = parseContentWithEditBlocks(rawContent);
                    const hasEditBlocks = parsed.some((s) => s.type === "edit");
                    if (hasEditBlocks) {
                      return (
                        <>
                          {parsed.map((seg, i) => {
                            if (seg.type === "text") {
                              const { html, terminals } = formatAssistantContent(seg.content);
                              if (terminals.length === 0) {
                                return <span key={`seg-${i}`} dangerouslySetInnerHTML={{ __html: html }} />;
                              }
                              const parts = html.split(/(__TERMINAL_\d+__)/g);
                              return (
                                <span key={`seg-${i}`}>
                                  {parts.map((part, j) => {
                                    const termMatch = part.match(/^__TERMINAL_(\d+)__$/);
                                    if (termMatch) {
                                      const idx = parseInt(termMatch[1], 10);
                                      const term = terminals[idx];
                                      if (!term) return null;
                                      const terminalKey = `${m.id}-${i}-${idx}`;
                                      return (
                                        <MiniTerminal
                                          key={`t-${j}`}
                                          {...term}
                                          aborted={closedTerminals.has(terminalKey)}
                                          onShowInMainTerminal={() => onAddCursorSession?.(term.fullCmd, term.output)}
                                          onClose={() => setClosedTerminals((prev) => new Set([...prev, terminalKey]))}
                                        />
                                      );
                                    }
                                    return <span key={`t-${j}`} dangerouslySetInnerHTML={{ __html: part }} />;
                                  })}
                                </span>
                              );
                            }
                            return (
                              <MiniFileEditor
                                key={`seg-${i}`}
                                path={seg.path}
                                content={seg.content}
                                pending={false}
                                workspaceId={workspaceId}
                                onOpenFile={onOpenFile ? (p) => onOpenFile(toWorkspaceRelative(p, workspaceId)) : undefined}
                              />
                            );
                          })}
                        </>
                      );
                    }
                    const { html, terminals } = formatAssistantContent(rawContent);
                    if (terminals.length === 0) {
                      return <span dangerouslySetInnerHTML={{ __html: html }} />;
                    }
                    const parts = html.split(/(__TERMINAL_\d+__)/g);
                    return (
                      <>
                        {parts.map((part, i) => {
                          const match = part.match(/^__TERMINAL_(\d+)__$/);
                          if (match) {
                            const idx = parseInt(match[1], 10);
                            const term = terminals[idx];
                            if (!term) return null;
                            const terminalKey = `${m.id}-${idx}`;
                            const isStuckRunning = !m.streaming && term.label === "Running" && !term.output.trim();
                            const effectiveLabel = isStuckRunning ? "Ran" : term.label;
                            const effectiveFailed = isStuckRunning ? false : term.failed;
                            return (
                              <MiniTerminal
                                key={`term-${i}-${idx}`}
                                {...term}
                                label={effectiveLabel}
                                failed={effectiveFailed}
                                aborted={closedTerminals.has(terminalKey)}
                                onShowInMainTerminal={() => onAddCursorSession?.(term.fullCmd, term.output)}
                                onClose={() => setClosedTerminals((prev) => new Set([...prev, terminalKey]))}
                              />
                            );
                          }
                          return <span key={i} dangerouslySetInnerHTML={{ __html: part }} />;
                        })}
                      </>
                    );
                  })()}
            </div>
          </div>
        ))}
        {wsError && (
          <p className="text-red-400 text-sm">Connection error. Ensure OpenCode is installed and backend is running.</p>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="flex-shrink-0 p-2 border-t border-surface-500">
        <div className="text-xs text-gray-500 mb-1.5">{selectedFilePath ?? "No file selected"}</div>
        <div
          className="rounded-xl overflow-hidden focus-within:ring-1 focus-within:ring-gray-500"
          style={{ backgroundColor: "rgb(45, 45, 45)", border: "1px solid rgba(255,255,255,0.06)" }}
        >
          {attachedImages.length > 0 && (
            <div className="flex flex-wrap gap-2 p-2 border-b border-white/10">
              {attachedImages.map((img) => (
                <div
                  key={img.id}
                  className="relative group rounded-lg overflow-hidden shrink-0"
                  style={{ width: 56, height: 56 }}
                >
                  <img
                    src={img.dataUrl}
                    alt="Attached"
                    className="w-full h-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => setAttachedImages((prev) => prev.filter((i) => i.id !== img.id))}
                    className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity rounded-lg"
                    title="Remove image"
                  >
                    <span className="text-white text-lg font-bold">×</span>
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const items = e.clipboardData?.items;
              if (!items) return;
              for (const item of items) {
                if (item.type.startsWith("image/")) {
                  e.preventDefault();
                  const file = item.getAsFile();
                  if (!file) continue;
                  const reader = new FileReader();
                  reader.onload = () => {
                    const dataUrl = reader.result as string;
                    setAttachedImages((prev) => [
                      ...prev,
                      { id: crypto.randomUUID(), dataUrl, mimeType: file.type },
                    ]);
                  };
                  reader.readAsDataURL(file);
                  break;
                }
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Plan, @ for context, / for commands"
            rows={3}
            className="w-full resize-none bg-transparent px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none border-0"
            style={{ minHeight: "72px" }}
            disabled={streaming}
          />
          <div className="flex items-center gap-2 px-2 py-1.5 border-t border-white/10">
            <div className="relative" ref={infinityDropdownRef}>
              <button
                type="button"
                onClick={() => setInfinityDropdownOpen((o) => !o)}
                className="rounded-md px-2.5 py-1.5 text-xs text-gray-300 hover:text-white hover:bg-white/10 flex items-center gap-1.5 border border-white/10 bg-[#2a2a2a] focus:outline-none focus:ring-1 focus:ring-gray-500 min-h-[28px]"
                title="Agent mode"
              >
                <span className="text-base font-medium leading-none" style={{ fontFamily: "sans-serif" }}>∞</span>
                <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {infinityDropdownOpen && (
                <div
                  className="absolute left-0 bottom-full mb-1 min-w-[160px] rounded-lg border border-white/10 shadow-xl z-50 overflow-hidden"
                  style={{ backgroundColor: "#1e1e1e" }}
                >
                  {[
                    { id: "Agent" as const, icon: "∞", shortcut: "Ctrl+I" },
                    { id: "Plan" as const, icon: "list", shortcut: null },
                    { id: "Debug" as const, icon: "bug", shortcut: null },
                    { id: "Ask" as const, icon: "chat", shortcut: null },
                  ].map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        setAgentMode(opt.id);
                        setInfinityDropdownOpen(false);
                      }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-left transition-colors ${
                        agentMode === opt.id ? "bg-white/15 text-white" : "text-gray-300 hover:bg-white/10"
                      }`}
                    >
                      {opt.icon === "∞" ? (
                        <span className="text-base font-medium w-5 text-center">∞</span>
                      ) : opt.icon === "list" ? (
                        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <circle cx="6" cy="12" r="2.5" strokeWidth={2} />
                          <path strokeLinecap="round" strokeWidth={2} d="M12 8h6M12 12h6M12 16h6" />
                        </svg>
                      ) : opt.icon === "bug" ? (
                        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 012 2v2a2 2 0 01-2 2m0 4a2 2 0 01-2 2v2a2 2 0 002 2m0-4a2 2 0 002-2v-2a2 2 0 00-2-2m0-4V4m0 4h.01M6 20h12a2 2 0 002-2V8a2 2 0 00-2-2H6a2 2 0 00-2 2v10a2 2 0 002 2z" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                        </svg>
                      )}
                      <span className="flex-1">{opt.id}</span>
                      {opt.shortcut && <span className="text-xs text-gray-500">{opt.shortcut}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="rounded-md px-2.5 py-1.5 text-xs text-gray-300 border border-white/10 bg-[#2a2a2a] focus:outline-none focus:ring-1 focus:ring-gray-500 min-w-[80px] min-h-[28px] [&>option]:bg-[#1e1e1e] [&>option]:text-gray-200"
              disabled={streaming}
            >
              {models.length === 0 ? (
                <option value={selectedModel}>Loading models…</option>
              ) : (
                <>
                  <option value={models[0]!.id}>Auto</option>
                  {models.slice(1).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </>
              )}
            </select>
            <div className="ml-auto flex items-center gap-1">
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = e.target.files;
                  if (!files?.length) return;
                  Array.from(files).forEach((file) => {
                    const reader = new FileReader();
                    reader.onload = () => {
                      setAttachedImages((prev) => [
                        ...prev,
                        { id: crypto.randomUUID(), dataUrl: reader.result as string, mimeType: file.type },
                      ]);
                    };
                    reader.readAsDataURL(file);
                  });
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                disabled={streaming}
                className="p-1.5 rounded-md text-gray-400 hover:text-gray-300 hover:bg-white/10 border border-white/10 bg-[#2a2a2a] transition-colors min-h-[28px]"
                title="Attach image"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </button>
              <button
                onClick={streaming ? abortRun : sendMessage}
                className={`p-1.5 rounded-full flex items-center justify-center transition-colors min-h-[28px] min-w-[28px] ${
                  streaming
                    ? "bg-gray-400 hover:bg-gray-300"
                    : "bg-gray-500/80 text-gray-200 hover:bg-accent hover:text-white"
                }`}
                title={streaming ? "Stop" : "Send"}
              >
                {streaming ? (
                  <span className="w-3 h-3 rounded-sm bg-gray-800" />
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
