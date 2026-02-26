import { writeFileSync } from "fs";
import { join } from "path";
import stripAnsi from "strip-ansi";
import { jsonrepair } from "jsonrepair";
import { WebSocketServer, type WebSocket } from "ws";
import { runOpenCode, abortProcess, type WorkspaceId } from "./agent.js";
import { summarizeConversation, type ConversationMessage } from "./summarizer.js";
import { executeToolCallsParallel } from "./tool-router.js";
import type { ToolCall } from "./types/tools.js";
import { config } from "./config.js";
import { getCustomToolNamesSync } from "./agent-config.js";
import { stripCodeFences } from "./apply-edit-agent.js";
import { detectAndRegister, waitForPortReachable, setPreviewHost } from "./preview-manager.js";
import { detectRebuildFromOutput } from "./dev-server-manager.js";

/** Custom tool names from tools.json — only these are executed (via OpenCode stubs + execute-tool API). */
const CUSTOM_TOOL_NAMES = new Set(getCustomToolNamesSync());

/** Built-in tools we allow (e.g. websearch for web search, todowrite/todoread for task list). OpenCode runs them; we send pending then completed to UI. */
const ALLOWED_BUILTIN_TOOLS = new Set(["websearch", "webfetch", "todowrite", "todoread"]);

const RUN = "run";
const ABORT = "abort";

/** Extract the file body from read_file tool output that uses <path>, <type>, <content> tags. */
function extractReadFileContent(raw: string): string {
  const m = raw.match(/<content>([\s\S]*?)<\/content>/i);
  if (m) return m[1].trim();
  return raw;
}

/** Extract path and optional line range from read_file output. */
function extractPathAndRangeFromReadOutput(output: string): { path?: string; startLine?: number; endLine?: number } {
  const pathMatch = output.match(/<path>([\s\S]*?)<\/path>/i);
  const path = pathMatch?.[1]?.replace(/^<path>\s*/i, "").trim();
  const contentMatch = output.match(/<content>([\s\S]*?)<\/content>/i);
  const content = contentMatch?.[1];
  let startLine: number | undefined;
  let endLine: number | undefined;
  if (content) {
    const lineNumRe = /^\s*(\d+):/gm;
    let m;
    const nums: number[] = [];
    while ((m = lineNumRe.exec(content)) !== null) nums.push(parseInt(m[1]!, 10));
    if (nums.length > 0) {
      startLine = Math.min(...nums);
      endLine = Math.max(...nums);
    }
  }
  return { path: path || undefined, startLine, endLine };
}

/** Remove read_file tool echo from narrative (model sometimes echoes <path>, <type>, <content> in its text). */
function stripReadToolEchoFromNarrative(text: string): string {
  let out = text;
  out = out.replace(/<path>[\s\S]*?<\/path>\s*<type>[\s\S]*?<\/type>\s*<content>[\s\S]*?<\/content>/gi, "");
  out = out.replace(/<\/content>\s*read\s*/gi, "");
  out = out.replace(/(<path>[\s\S]*?<\/path>|<type>[\s\S]*?<\/type>|<content>[\s\S]*?<\/content>)/gi, "");
  return out.trim();
}

function escapeJsonString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

const MAX_LINE_FOR_MERGE = 120000;

/** Strip leading TTY/ANSI/CSI escape sequences only (e.g. \u001b[?9001h, \u001b[?1004h). Used so PTY's first chunk on Windows doesn't pollute the JSONL buffer. */
function stripLeadingAnsi(s: string): string {
  return s.replace(/^(\s|\u001b\[[?0-9;]*[A-Za-z])*/g, "");
}

/** Strip ANSI and CSI from the line (including [0K, [1G, [?25h, [?25l etc), fix TTY-broken newlines inside words/numbers, then merge adjacent quoted strings. */
function stripAnsiFromJson(s: string): string {
  let out = stripAnsi(s);
  out = out.replace(/\r\n/g, "\n").replace(/\r/g, "");
  out = out.replace(/\u001b\[[?0-9;]*[A-Za-z]/g, "").replace(/\[[?0-9;]*[A-Za-z]/g, "");
  out = out.replace(/([a-zA-Z0-9_])\n([a-zA-Z0-9_])/g, "$1$2");
  for (let i = 0; i < 5; i++) {
    const next = out.replace(/(\d+)\n(\d+)/g, "$1$2");
    if (next === out) break;
    out = next;
  }
  // Fix newlines that break structure: quote-newline-colon (TTY injected newline after key or value)
  out = out.replace(/"\s*\n\s*:/g, '": ""');  // "key"\n: or ""\n: -> "key": "" or "": ""
  out = out.replace(/"\s*\n\s*,/g, '",');
  out = out.replace(/"\s*\n\s*}/g, '"}');
  out = out.replace(/"\s*\n\s*]/g, '"]');
  if (out.length > MAX_LINE_FOR_MERGE) return out;
  const quoted = '"([^"]*)"';
  const adjacentStrings = new RegExp(quoted + "\\s*" + quoted + "(?!\\s*:)", "g");
  for (let i = 0; i < 20; i++) {
    const next = out.replace(adjacentStrings, (_: string, p1: string, p2: string) => `"${escapeJsonString(p1)}${escapeJsonString(p2)}"`);
    if (next === out) break;
    out = next;
  }
  return out;
}

let parseFailureLogged = false;
function logFirstParseFailure(trimmed: string, shaped: string, err: string): void {
  if (parseFailureLogged) return;
  parseFailureLogged = true;
  try {
    const sample = [
      "# First parse failure - raw line (first 4000 chars):",
      trimmed.slice(0, 4000),
      "",
      "# After fixPartArrayShape (first 4000 chars):",
      shaped.slice(0, 4000),
      "",
      "# Error:",
      err,
    ].join("\n");
    writeFileSync(join(process.cwd(), "parse-failure-sample.txt"), sample, "utf8");
    console.warn("[agent] Wrote first failure to parse-failure-sample.txt for inspection");
  } catch (_) {}
}

/** Replace raw control chars and convert single-quoted strings to double-quoted so JSON.parse accepts it. */
function sanitizeControlChars(s: string): string {
  let out = "";
  let inString = false;
  let quoteChar: string | null = null;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = c.charCodeAt(0);
    if (escape) {
      const validJsonEscape = /^["\\\/bfnrtu]$/.test(c) || (code >= 0 && code <= 31);
      if (code >= 0 && code <= 31) {
        if (code === 0x0a) out += "\\n";
        else if (code === 0x0d) out += "\\r";
        else if (code === 0x09) out += "\\t";
        else out += " ";
      } else if (c === "u" && i + 4 < s.length && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) {
        out += c + s[i + 1]! + s[i + 2]! + s[i + 3]! + s[i + 4]!;
        i += 4;
      } else if (c === "u") {
        out += "\\\\u";
      } else if (validJsonEscape) {
        out += c;
      } else {
        out += "\\\\" + c;
      }
      escape = false;
      continue;
    }
    if (inString && quoteChar !== null) {
      if (c === "\\") {
        if (i + 1 >= s.length) {
          out += "\\\\";
        } else {
          escape = true;
          out += c;
        }
        continue;
      }
      if (c === quoteChar) {
        inString = false;
        out += quoteChar === "'" ? '"' : c;
        quoteChar = null;
        continue;
      }
      if (c === '"' && quoteChar === "'") { out += '\\"'; continue; }
      if (c === "'" && quoteChar === '"') { out += c; continue; }
      if (code >= 0 && code <= 31) {
        if (code === 0x0a) out += "\\n";
        else if (code === 0x0d) out += "\\r";
        else if (code === 0x09) out += "\\t";
        else out += " ";
      } else out += c;
      continue;
    }
    if (c === '"') { inString = true; quoteChar = '"'; out += c; continue; }
    if (c === "'") { inString = true; quoteChar = "'"; out += '"'; continue; }
    if (c === "\\") { out += " "; continue; }
    if (code >= 0 && code <= 31) out += " ";
    else out += c;
  }
  out = out.replace(/,(\s*[}\]])/g, "$1");
  out = insertMissingCommas(out);
  out = out.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, " ");
  return out;
}

/** OpenCode sends object keys with a bare array: "key":"value", [ or "key":"value" [. Fix every quoted-string then , [ or " [. */
function fixPartBareArray(s: string): string {
  let out = s;
  const quoted = '"((?:[^"\\\\]|\\\\.)*)"';
  out = out.replace(new RegExp(quoted + "\\s*,\\s*\\[", "g"), '"$1", "_": [');
  out = out.replace(new RegExp(quoted + "\\s*\\[\\s*\\]", "g"), '"$1", "_": []');
  out = out.replace(new RegExp(quoted + "\\s*\\[(?=\\s*[{\\[])", "g"), '"$1", "_": [');
  out = out.replace(/"part"\s*:\s*\{\s*"id"\s*:\s*"([^"]*)"\s*,\s*\[/g, '"part":{"id":"$1", "_": [');
  out = out.replace(/"part"\s*:\s*\{\s*"id"\s*:\s*"([^"]*)"\s*\[\s*\]/g, '"part":{"id":"$1", "_": []');
  out = out.replace(/"part"\s*:\s*\{\s*"id"\s*:\s*"([^"]*)"\s*\[\s*/g, '"part":{"id":"$1", "_": [');
  out = out.replace(/'part'\s*:\s*\{\s*'id'\s*:\s*'([^']*)'\s*,\s*\[/g, '"part":{"id":"$1", "_": [');
  out = out.replace(/'part'\s*:\s*\{\s*'id'\s*:\s*'([^']*)'\s*\[\s*\]/g, '"part":{"id":"$1", "_": []');
  out = out.replace(/'part'\s*:\s*\{\s*'id'\s*:\s*'([^']*)'\s*\[\s*/g, '"part":{"id":"$1", "_": [');
  return out;
}

/**
 * Fix OpenCode's "bare array" in objects: they send {"part":{"id":"x", [ ] } } where an array
 * has no key. We walk the string and, when inside an object (not in a string), insert "_": 
 * before any [ that follows , or { so the result is valid JSON.
 */
function fixPartArrayShape(s: string): string {
  const s2 = fixPartBareArray(s);
  let out = "";
  let i = 0;
  const len = s2.length;
  let objectDepth = 0;
  let arrayDepth = 0;
  let inString = false;
  let quoteChar: string | null = null;
  let escape = false;

  while (i < len) {
    const c = s2[i];
    if (escape) {
      escape = false;
      out += c;
      i++;
      continue;
    }
    if (inString && quoteChar !== null) {
      if (c === "\\") {
        escape = true;
        out += c;
        i++;
        continue;
      }
      if (c === quoteChar) {
        inString = false;
        quoteChar = null;
        out += c;
        i++;
        let j = i;
        while (j < len && /[\s]/.test(s2[j]!)) j++;
        if (objectDepth >= 2 && arrayDepth === 0 && j < len && s2[j] === "[") {
          out += ', "_": ';
          i = j;
        }
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quoteChar = c;
      out += c === "'" ? '"' : c;
      i++;
      continue;
    }
    if (c === "{") {
      objectDepth++;
      out += c;
      i++;
      continue;
    }
    if (c === "}") {
      objectDepth--;
      out += c;
      i++;
      continue;
    }
    if (c === "[") {
      arrayDepth++;
      out += c;
      i++;
      continue;
    }
    if (c === "]") {
      arrayDepth--;
      out += c;
      i++;
      continue;
    }
    if (objectDepth > 0 && arrayDepth === 0 && (c === "," || c === "{")) {
      let spaces = "";
      i++;
      while (i < len && /[\s]/.test(s2[i]!)) {
        spaces += s2[i];
        i++;
      }
      if (i < len && s2[i] === "[") {
        out += c + spaces + '"_": ';
        continue;
      }
      out += c + spaces;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Insert comma between adjacent string literals (e.g. "value" "key" -> "value", "key") to fix Expected ',' errors. */
function insertMissingCommas(s: string): string {
  let result = "";
  let i = 0;
  const len = s.length;
  let inString = false;
  let escape = false;
  while (i < len) {
    const c = s[i];
    if (escape) {
      escape = false;
      result += c;
      i++;
      continue;
    }
    if (inString) {
      if (c === "\\") {
        escape = true;
        result += c;
        i++;
        continue;
      }
      if (c === '"') {
        inString = false;
        result += c;
        i++;
        let j = i;
        while (j < len && /[\s]/.test(s[j]!)) j++;
        if (j < len && s[j] === '"') {
          result += ",";
        }
        continue;
      }
      result += c;
      i++;
      continue;
    }
    if (c === '"') {
      if (!inString && result.endsWith('"')) result += ",";
      inString = true;
      result += c;
      i++;
      continue;
    }
    result += c;
    i++;
  }
  return result;
}

/** Try to extract part.text from a string that failed to parse, so we can still show narrative to the user. */
function extractTextFromFailedJson(s: string): string | null {
  const match = s.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!match) return null;
  const raw = match[1];
  if (raw === undefined) return null;
  const unescaped = raw
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
  return unescaped.trim() || null;
}

/** Parse one JSONL line: strip ANSI, fix shape, then strict parse, jsonrepair, sanitizer, jsonrepair(sanitizer). */
function parseJsonLine(trimmed: string): unknown {
  let lastErr: Error | null = null;
  const cleaned = stripAnsiFromJson(trimmed);
  const sanitizedFirst = sanitizeControlChars(cleaned);
  const shaped = fixPartArrayShape(sanitizedFirst);
  try {
    return JSON.parse(shaped);
  } catch (e) {
    lastErr = e instanceof Error ? e : new Error(String(e));
  }
  try {
    return JSON.parse(jsonrepair(shaped));
  } catch (e) {
    lastErr = e instanceof Error ? e : new Error(String(e));
  }
  const sanitized = sanitizeControlChars(shaped);
  try {
    return JSON.parse(sanitized);
  } catch (e) {
    lastErr = e instanceof Error ? e : new Error(String(e));
  }
  try {
    return JSON.parse(jsonrepair(sanitized));
  } catch (e) {
    lastErr = e instanceof Error ? e : new Error(String(e));
  }
  throw new Error(lastErr ? `Could not parse JSON line: ${lastErr.message}` : "Could not parse JSON line");
}

/** When a tool_use line fails to parse (e.g. due to newlines in content), extract tool/callId/path/content from the start so we can still send a tool_call and show the card. */
function extractToolCallFromBrokenLine(line: string): { rawTool: string; callId: string; path?: string; content?: string } | null {
  if (!line.includes("tool_use") || !line.includes('"tool":')) return null;
  const head = line.slice(0, 4000);
  const toolM = head.match(/"tool"\s*:\s*"([^"]+)"/);
  const rawTool = toolM ? toolM[1]!.trim() : "";
  const callIdM = head.match(/"callID"\s*:\s*"([^"]+)"/);
  const callId = callIdM ? callIdM[1]!.trim() : `tool-recovery-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  let path: string | undefined;
  const filePathM = head.match(/"filePath"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (filePathM) path = filePathM[1]!.replace(/\\\\/g, "\\").trim();
  if (!path) {
    const pathM = head.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (pathM) path = pathM[1]!.replace(/\\\\/g, "\\").trim();
  }
  if (!path) {
    const tfM = head.match(/"target_file"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (tfM) path = tfM[1]!.replace(/\\\\/g, "\\").trim();
  }
  if (!path) {
    const fpM = head.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (fpM) path = fpM[1]!.replace(/\\\\/g, "\\").trim();
  }
  if (!path && head.includes('"title":')) {
    const titleM = head.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (titleM) {
      const t = titleM[1]!.replace(/\\\\/g, "\\").replace(/^write\s+/i, "").replace(/^edit\s+/i, "").trim();
      const firstWord = t.match(/^([^\s\\]+)/);
      if (firstWord) path = firstWord[1]!.trim();
    }
  }
  // If edit/write and still no path, search a longer window (path can appear after large payloads)
  if ((rawTool === "edit_file" || rawTool === "write_file") && !path && line.length > 4000) {
    const longHead = line.slice(0, 8000);
    const tfM = longHead.match(/"target_file"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (tfM) path = tfM[1]!.replace(/\\\\/g, "\\").trim();
    if (!path) {
      const pathM = longHead.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (pathM) path = pathM[1]!.replace(/\\\\/g, "\\").trim();
    }
    if (!path) {
      const fpM = longHead.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (fpM) path = fpM[1]!.replace(/\\\\/g, "\\").trim();
    }
  }
  let content: string | undefined;
  const maxLen = 12000;
  function extractStringAfterKey(key: string): string | undefined {
    const idx = line.indexOf(key);
    if (idx === -1) return undefined;
    let i = idx + key.length;
    while (i < line.length && /[\s:]/.test(line[i]!)) i++;
    if (i >= line.length || line[i] !== '"') return undefined;
    i++;
    const start = i;
    let out = "";
    let escape = false;
    while (i < line.length && out.length < maxLen) {
      const c = line[i];
      if (escape) {
        if (c === "n") out += "\n";
        else if (c === "r") out += "\r";
        else if (c === "t") out += "\t";
        else if (c === '"' || c === "\\") out += c;
        else out += c;
        escape = false;
        i++;
        continue;
      }
      if (c === "\\") {
        escape = true;
        i++;
        continue;
      }
      if (c === '"') break;
      out += c;
      i++;
    }
    return out.length > 0 ? out : undefined;
  }
  for (const key of ['"code_edit"', '"content"', '"codeEdit"', '"instructions"']) {
    const value = extractStringAfterKey(key);
    if (value) {
      content = value;
      break;
    }
  }
  if (!content) {
    const oldStr = extractStringAfterKey('"old_string"');
    const newStr = extractStringAfterKey('"new_string"');
    if (oldStr != null && newStr != null) {
      const oldLines = oldStr.split(/\r?\n/).map((l) => "-" + l);
      const newLines = newStr.split(/\r?\n/).map((l) => "+" + l);
      content = oldLines.join("\n") + "\n" + newLines.join("\n");
    }
  }
  if (!rawTool) return null;
  return { rawTool, callId, path, content };
}

/** Extract complete JSON objects from buffer. Tracks double- and single-quoted strings so } inside them don't end the object. */
function extractJsonObjects(buffer: string): { objects: string[]; remainder: string } {
  const objects: string[] = [];
  let i = 0;
  const len = buffer.length;
  while (i < len) {
    const ch = buffer[i];
    if (ch !== "{" && ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
      i++;
      continue;
    }
    if (ch === "{") {
      let depth = 0;
      let inDouble = false;
      let inSingle = false;
      let escape = false;
      let start = i;
      for (; i < len; i++) {
        const c = buffer[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (inDouble) {
          if (c === "\\") escape = true;
          else if (c === '"') inDouble = false;
          continue;
        }
        if (inSingle) {
          if (c === "\\") escape = true;
          else if (c === "'") inSingle = false;
          continue;
        }
        if (c === '"') { inDouble = true; continue; }
        if (c === "'") { inSingle = true; continue; }
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            objects.push(buffer.slice(start, i + 1));
            i++;
            break;
          }
        }
      }
      if (depth !== 0) {
        return { objects, remainder: buffer.slice(start) };
      }
      continue;
    }
    i++;
  }
  return { objects, remainder: buffer.slice(i) };
}

/** Split remainder into narrative (plain text lines to send as chunks) and tail (incomplete JSON or empty). */
function flushNarrativeFromRemainder(remainder: string): { narrative: string; toKeep: string } {
  const lines = remainder.split(/\r?\n/);
  let narrative = "";
  let toKeep = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const isLast = i === lines.length - 1;
    if (isLast) {
      if (trimmed.startsWith("{")) {
        toKeep = lines.slice(i).join("\n");
      } else if (trimmed) {
        narrative += line + "\n";
      }
      break;
    }
    if (trimmed.startsWith("{")) {
      toKeep = lines.slice(i).join("\n");
      break;
    }
    if (trimmed) narrative += line + "\n";
  }
  return { narrative, toKeep };
}

interface IncomingMessage {
  type: string;
  workspaceId?: string;
  /** Full message to send (used when summarization is not requested). */
  message?: string;
  /** Latest user message when using summarization. */
  currentUserMessage?: string;
  /** Conversation history for summarizer (user + assistant messages). */
  conversationMessages?: ConversationMessage[];
  chatSessionId?: string;
  model?: string;
  /** Agent mode: Agent, Plan, Debug, Ask — affects instruction prefix. */
  agentMode?: string;
}

const running = new Map<string, Awaited<ReturnType<typeof runOpenCode>>>();
/** Map workspaceId:chatSessionId -> OpenCode session ID so we continue the same session (and the agent gets tool results). */
const opencodeSessionByChat = new Map<string, string>();

/** Map workspaceId:chatSessionId -> WebSocket for execute-tool API to push results. */
const sessionSockets = new Map<string, WebSocket>();

export function registerSessionSocket(workspaceId: string, chatSessionId: string | undefined, ws: WebSocket): void {
  const key = chatSessionId ? `${workspaceId}:${chatSessionId}` : `${workspaceId}:default`;
  sessionSockets.set(key, ws);
}

export function unregisterSessionSocket(workspaceId: string, chatSessionId: string | undefined): void {
  const key = chatSessionId ? `${workspaceId}:${chatSessionId}` : `${workspaceId}:default`;
  sessionSockets.delete(key);
}

export function getSessionSocket(workspaceId: string, chatSessionId: string | undefined): WebSocket | undefined {
  const key = chatSessionId ? `${workspaceId}:${chatSessionId}` : `${workspaceId}:default`;
  return sessionSockets.get(key);
}

export function attachAgentWebSocket(wss: WebSocketServer): void {
  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", async (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as IncomingMessage;
        const hasRunPayload =
          msg.type === RUN &&
          msg.workspaceId &&
          (typeof msg.message === "string" ||
            (typeof msg.currentUserMessage === "string" && msg.currentUserMessage.trim().length > 0));
        if (hasRunPayload) {
          const workspaceId = msg.workspaceId as WorkspaceId;
          const chatSessionId = typeof msg.chatSessionId === "string" ? msg.chatSessionId : undefined;
          const sessionMapKey = chatSessionId ? `${workspaceId}:${chatSessionId}` : undefined;
          const opencodeSessionId = sessionMapKey ? opencodeSessionByChat.get(sessionMapKey) : undefined;

          let messageToSend: string;
          const conversationMessages = Array.isArray(msg.conversationMessages) ? msg.conversationMessages : [];
          const currentUserMessage = typeof msg.currentUserMessage === "string" ? msg.currentUserMessage.trim() : "";

          if (conversationMessages.length > 0 && currentUserMessage.length > 0) {
            const summary = await summarizeConversation(conversationMessages);
            messageToSend =
              summary.length > 0
                ? `Current user message (respond to this):\n${currentUserMessage}\n\n---\nConversation context:\n${summary}`
                : currentUserMessage;
            if (summary.length > 0) {
              console.log("[agent] summarizer used, summary length:", summary.length);
            }
          } else {
            messageToSend = typeof msg.message === "string" && msg.message.trim().length > 0
              ? msg.message.trim()
              : currentUserMessage || "";
          }

          const agentMode = typeof msg.agentMode === "string" ? msg.agentMode.trim() : "Ask";
          const modePrefix =
            agentMode === "Agent"
              ? "[Mode: Agent] Full autonomous agent: resolve the user's request completely before ending your turn.\n\n"
              : agentMode === "Plan"
                ? "[Mode: Plan] The user wants you to focus on planning first: outline steps before making changes.\n\n"
                : agentMode === "Debug"
                  ? "[Mode: Debug] The user is in debug mode: focus on finding and fixing bugs, explaining root cause.\n\n"
                  : agentMode === "Ask"
                    ? "[Mode: Ask] The user is asking a question: answer concisely, optionally with code references.\n\n"
                    : "";
          if (modePrefix) messageToSend = modePrefix + messageToSend;

          const key = `${workspaceId}:${Date.now()}`;
          console.log("[agent] run requested, workspace:", workspaceId, "continuing:", !!opencodeSessionId, "message length:", messageToSend.length);
          registerSessionSocket(workspaceId, chatSessionId, ws);
          try {
            let chunkCount = 0;
            let ended = false;
            const done = () => {
              if (ended) return;
              ended = true;
              running.delete(key);
            };
                let jsonlBuffer = "";
                let toolEventIndex = 0;
                let toolCallSendCount = 0;
                let loggedWaiting = false;
                let sentIncompletePlaceholder = false;
                const useJson = config.openCodeUseJson;
                const proc = await runOpenCode(workspaceId, messageToSend, {
                  async onData(chunk) {
                    chunkCount++;
                    if (chunkCount === 1) {
                      const str = typeof chunk === "string" ? chunk : String(chunk);
                      const preview = str.slice(0, 300).replace(/\r/g, "\\r").replace(/\n/g, "\\n");
                      console.log("[agent] first chunk received", useJson ? "(JSONL mode)" : "(text mode)", "len:", str.length, "preview:", JSON.stringify(preview));
                    }
                    if (!useJson) {
                      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "chunk", data: chunk }));
                      return;
                    }
                    let str = typeof chunk === "string" ? chunk : String(chunk);
                    str = stripLeadingAnsi(str);
                    jsonlBuffer += str;
                    const lines = jsonlBuffer.split(/\r?\n/);
                    const objects: string[] = [];
                    let remainder = "";
                    for (let l = 0; l < lines.length; l++) {
                      const trimmed = lines[l]!.trim();
                      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
                        objects.push(trimmed);
                      } else {
                        remainder = lines.slice(l).join("\n");
                        break;
                      }
                    }
                    if (objects.length === 0) {
                      const extracted = extractJsonObjects(jsonlBuffer);
                      objects.push(...extracted.objects);
                      remainder = extracted.remainder;
                      if (!loggedWaiting && remainder.length > 0 && remainder.length < 500) {
                        loggedWaiting = true;
                        console.log("[agent] incomplete buffer (" + remainder.length + " bytes), waiting for more output from agent…");
                      }
                    } else if (remainder.trimStart().startsWith("{")) {
                      const extracted = extractJsonObjects(jsonlBuffer);
                      if (extracted.objects.length > objects.length) {
                        objects.length = 0;
                        objects.push(...extracted.objects);
                        remainder = extracted.remainder;
                      }
                    }
                    const { narrative, toKeep } = flushNarrativeFromRemainder(remainder);
                    const narrativeClean = narrative ? stripAnsi(narrative.replace(/\[[0-9;]+[A-Za-z]/g, "")).trim() : "";
                    if (narrativeClean && ws.readyState === ws.OPEN) {
                      ws.send(JSON.stringify({ type: "chunk", data: narrativeClean }));
                      // Detect dev server port from agent narrative (e.g. "Dev server running at http://localhost:5174/")
                      const port = detectAndRegister(workspaceId, narrativeClean);
                      if (port != null) {
                        waitForPortReachable(port, 15000).then((host) => {
                          if (host) setPreviewHost(workspaceId, host);
                          if (ws.readyState === ws.OPEN) {
                            ws.send(JSON.stringify({ type: "preview_ready", workspaceId, port, url: `http://localhost:${port}` }));
                          }
                        });
                      }
                      if (detectRebuildFromOutput(narrativeClean)) {
                        ws.send(JSON.stringify({ type: "preview_refresh", workspaceId }));
                      }
                    }
                    const noMeaningfulOutput = objects.length === 0 && !narrativeClean;
                    if (noMeaningfulOutput && !sentIncompletePlaceholder && ws.readyState === ws.OPEN && chunkCount >= 1) {
                      sentIncompletePlaceholder = true;
                      ws.send(JSON.stringify({ type: "thinking", data: "" }));
                    }
                    jsonlBuffer = toKeep;
                    for (let oi = 0; oi < objects.length; oi++) {
                      let objStr = objects[oi];
                      let trimmed = objStr.trim();
                      if (trimmed.charCodeAt(0) === 0xfeff) trimmed = trimmed.slice(1);
                      if (!trimmed || trimmed.charAt(0) !== "{") continue;
                      try {
                        const ev = parseJsonLine(trimmed) as {
                          type?: string;
                          sessionID?: string;
                          part?: {
                            id?: string;
                            callID?: string;
                            type?: string;
                            tool?: string;
                            sessionID?: string;
                            state?: {
                              status?: string;
                              input?: unknown;
                              output?: string;
                              metadata?: { output?: string };
                            };
                            text?: string;
                          };
                          properties?: { part?: { id?: string; callID?: string; type?: string; tool?: string; sessionID?: string; state?: { status?: string; input?: unknown; output?: string; metadata?: { output?: string } }; text?: string } };
                          error?: { name?: string; data?: { message?: string } };
                        };
                        const singlePart = ev.part ?? ev.properties?.part;
                        const partsArray = (ev as { parts?: unknown[] }).parts ?? (ev.properties as { parts?: unknown[] } | undefined)?.parts;
                        const partsToProcess: unknown[] = Array.isArray(partsArray) && partsArray.length > 0
                          ? partsArray
                          : Array.isArray(singlePart)
                            ? singlePart
                            : singlePart != null ? [singlePart] : [];
                        const seenSessionId =
                          (ev as { sessionID?: string }).sessionID ??
                          (ev as { sessionId?: string }).sessionId ??
                          (singlePart as { sessionID?: string })?.sessionID ??
                          (singlePart as { sessionId?: string })?.sessionId;
                        if (sessionMapKey && typeof seenSessionId === "string" && seenSessionId.length > 0) {
                          opencodeSessionByChat.set(sessionMapKey, seenSessionId);
                        }
                        const toolCallsToRun: ToolCall[] = [];
                        for (const part of partsToProcess) {
                          if (!part || typeof part !== "object") continue;
                          const p = part as { type?: string; tool?: string; text?: string; state?: unknown; callID?: string; id?: string; input?: unknown; args?: unknown };
                          if (p.text) {
                            const cleaned = stripReadToolEchoFromNarrative(p.text);
                            if (cleaned && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "chunk", data: cleaned }));
                            continue;
                          }
                          if (p.type !== "tool" && !p.tool) continue;
                          const state = p.state;
                          const status = state && typeof state === "object" ? (state as { status?: string }).status : undefined;
                          const stateInput = (state && typeof state === "object" && "input" in state ? (state as { input?: unknown }).input : undefined);
                          const partInput = (p as { input?: unknown }).input;
                          const partArgs = (p as { args?: unknown }).args;
                          const input = stateInput ?? partInput ?? partArgs ?? {};
                          const output =
                            (state && typeof state === "object" && "output" in state ? (state as { output?: string }).output : undefined) ??
                            (state && typeof state === "object" && "metadata" in state && (state as { metadata?: { output?: string } }).metadata
                              ? (state as { metadata?: { output?: string } }).metadata?.output
                              : undefined);
                          const pending = (status === "pending" || status === "running") && output === undefined;
                          const baseCallId = (p as { callID?: string }).callID ?? (p as { id?: string }).id ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
                          const rawTool = (p as { tool?: string }).tool ?? "unknown";
                          const tool =
                            rawTool === "write_file"
                              ? "write"
                              : rawTool === "edit_file"
                                ? "edit"
                                : rawTool === "search_replace"
                                  ? "edit"
                                  : rawTool === "run_terminal_cmd"
                                    ? "bash"
                                    : rawTool === "read_file"
                                      ? "read"
                                      : rawTool;
                          // Use baseCallId for custom/allowed tools so execute-tool (same callId) updates the same block
                          const callId =
                            CUSTOM_TOOL_NAMES.has(rawTool) || ALLOWED_BUILTIN_TOOLS.has(rawTool)
                              ? baseCallId
                              : tool === "bash"
                                ? baseCallId
                                : `${baseCallId}-${++toolEventIndex}`;
                          const inp = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
                          const argsObj = inp.arguments && typeof inp.arguments === "object" ? (inp.arguments as Record<string, unknown>) : inp;
                          const pathVal =
                            rawTool === "file_search"
                              ? (inp.query ?? (argsObj as Record<string, unknown>).query ?? inp.path ?? (argsObj as Record<string, unknown>).path)
                              : (rawTool === "websearch" || rawTool === "web_search")
                                ? (inp.search_term ?? (argsObj as Record<string, unknown>).search_term ?? inp.query ?? (argsObj as Record<string, unknown>).query ?? inp.path)
                                : (inp.path ?? (argsObj as Record<string, unknown>).path
                                ?? inp.relative_workspace_path ?? (argsObj as Record<string, unknown>).relative_workspace_path
                                ?? inp.target_file ?? inp.targetFile ?? inp.file_path ?? inp.filePath ?? inp.file ?? inp.filename ?? inp.dir
                                ?? inp.destination ?? inp.targetPath ?? inp.output_path ?? inp.outputPath ?? inp.relative_path
                                ?? (argsObj as Record<string, unknown>).target_file ?? (argsObj as Record<string, unknown>).file_path ?? (argsObj as Record<string, unknown>).file);
                          const listPathVal = rawTool === "list_dir" ? (inp.relative_workspace_path ?? (argsObj as Record<string, unknown>).relative_workspace_path ?? pathVal) : pathVal;
                          const globPatternVal = rawTool === "glob" ? (inp.pattern ?? pathVal) : listPathVal;
                          let pathStr =
                            typeof globPatternVal === "string" && globPatternVal.trim()
                              ? globPatternVal.replace(/^<path>\s*/i, "").trim()
                              : undefined;
                          const command = (tool === "bash" || rawTool === "run_terminal_cmd") && input && typeof input === "object"
                            ? (typeof (argsObj as Record<string, unknown>).command === "string" ? (argsObj as Record<string, unknown>).command as string : (inp as { command?: string }).command)
                            : undefined;
                          const isEditOrWrite = tool === "write" || tool === "edit" || rawTool === "write_file" || rawTool === "edit_file" || rawTool === "search_replace";
                          if (!pathStr && isEditOrWrite && state && typeof state === "object") {
                            const st = state as { title?: string; metadata?: Record<string, unknown> };
                            if (typeof st.title === "string" && st.title.trim()) {
                              const m = st.title.replace(/^write\s+/i, "").replace(/^edit\s+/i, "").trim().match(/^([^\s]+)/);
                              if (m) pathStr = m[1].trim();
                            }
                            if (!pathStr && st.metadata && typeof st.metadata.path === "string") pathStr = st.metadata.path.trim();
                          }
                          if (!pathStr && isEditOrWrite && typeof output === "string" && output.trim()) {
                            const created = output.match(/(?:created|wrote|written)\s+([^\s,\n]+?)(?:\s|$|,|\.)/i);
                            if (created) pathStr = created[1].trim();
                          }
                          const inputContent = typeof inp.content === "string" ? inp.content : typeof inp.contents === "string" ? inp.contents : typeof inp.code_edit === "string" ? inp.code_edit : typeof (inp as { codeEdit?: string }).codeEdit === "string" ? (inp as { codeEdit: string }).codeEdit : typeof inp.instructions === "string" ? inp.instructions : undefined;
                          const searchReplaceContent =
                            (rawTool === "search_replace" || rawTool === "edit_file") && (typeof inp.new_string === "string" || typeof inp.old_string === "string")
                              ? (() => {
                                  const oldS = typeof inp.old_string === "string" ? inp.old_string : "";
                                  const newS = typeof inp.new_string === "string" ? inp.new_string : "";
                                  if (!oldS && !newS) return undefined;
                                  const oldLines = oldS.split(/\r?\n/).map((l: string) => "-" + l);
                                  const newLines = newS.split(/\r?\n/).map((l: string) => "+" + l);
                                  return oldLines.join("\n") + (oldLines.length && newLines.length ? "\n" : "") + newLines.join("\n");
                                })()
                              : undefined;
                          const effectiveInputContent = inputContent ?? searchReplaceContent;
                          const outputLooksLikeSuccessOnly =
                            typeof output === "string" && (output.length < 100 || /success|wrote|written|done|ok|applied/i.test(output));
                          const resolvedContent =
                            isEditOrWrite && (!output || outputLooksLikeSuccessOnly) && effectiveInputContent != null
                              ? effectiveInputContent
                              : output;
                          const hasContent = resolvedContent !== undefined && resolvedContent !== null;
                          const pathFromOutput = tool === "read" && typeof output === "string"
                            ? (() => { const m = output.match(/<path>([\s\S]*?)<\/path>/i); return m ? (m[1] ?? "").replace(/^<path>\s*/i, "").trim() : undefined; })()
                            : undefined;
                          let pathForRead = pathStr ?? pathFromOutput;
                          let readStart = (tool === "read") && (typeof inp.start_line_one_indexed === "number" || typeof (inp as { startLine?: number }).startLine === "number")
                            ? (typeof inp.start_line_one_indexed === "number" ? inp.start_line_one_indexed : (inp as { startLine?: number }).startLine)
                            : undefined;
                          let readEnd = (tool === "read") && (typeof inp.end_line_one_indexed_inclusive === "number" || typeof (inp as { endLine?: number }).endLine === "number")
                            ? (typeof inp.end_line_one_indexed_inclusive === "number" ? inp.end_line_one_indexed_inclusive : (inp as { endLine?: number }).endLine)
                            : undefined;
                          if (tool === "read" && typeof output === "string") {
                            const extracted = extractPathAndRangeFromReadOutput(output);
                            if (extracted.path) pathForRead = pathForRead ?? extracted.path;
                            if (extracted.startLine != null) readStart = readStart ?? extracted.startLine;
                            if (extracted.endLine != null) readEnd = readEnd ?? extracted.endLine;
                          }
                          const contentForPayload =
                            hasContent
                              ? (tool === "read"
                                  ? extractReadFileContent(String(resolvedContent))
                                  : isEditOrWrite &&
                                    typeof output === "string" &&
                                    outputLooksLikeSuccessOnly &&
                                    resolvedContent === output
                                    ? undefined
                                    : (() => {
                                        const raw = String(resolvedContent);
                                        return isEditOrWrite ? stripCodeFences(raw) : raw;
                                      })())
                              : undefined;
                          const st = state && typeof state === "object" ? (state as Record<string, unknown>) : {};
                          const bashFailed =
                            tool === "bash" &&
                            (typeof st.exit_code === "number"
                              ? st.exit_code !== 0
                              : typeof st.exitCode === "number"
                                ? st.exitCode !== 0
                                : typeof st.is_error === "boolean"
                                  ? st.is_error
                                  : undefined);
                          const payload: Record<string, unknown> = {
                            type: "tool_call",
                            callId,
                            tool,
                            pending,
                            path: tool === "read" ? (pathForRead ?? pathStr) : pathStr,
                            command: command ?? undefined,
                            content: contentForPayload,
                            ...(readStart !== undefined && readEnd !== undefined && { startLine: readStart, endLine: readEnd }),
                            ...(tool === "bash" && bashFailed !== undefined && { failed: bashFailed }),
                          };
                          const editWriteOk =
                            tool === "read" ||
                            !isEditOrWrite ||
                            (pathStr && (pending || hasContent)) ||
                            (isEditOrWrite && pathStr);
                          const hasRunnableInput = input && typeof input === "object" && Object.keys(input as object).length > 0;
                          if (editWriteOk && hasRunnableInput) {
                            if (CUSTOM_TOOL_NAMES.has(rawTool)) {
                              // Custom tool: executed by OpenCode stubs which call our execute-tool API. Send pending first; when completed, send payload so UI updates even if execute-tool used a different callId.
                              if (ws.readyState === ws.OPEN) {
                                if (pending) {
                                  ws.send(JSON.stringify({
                                    type: "tool_call",
                                    callId,
                                    tool: rawTool,
                                    pending: true,
                                    path: rawTool === "list_dir" ? (pathStr ?? ".") : pathStr,
                                    command: (rawTool === "run_terminal_cmd" && typeof command === "string") ? command.trim() : undefined,
                                    content: undefined,
                                    ...(rawTool === "read_file" && readStart != null && readEnd != null && { startLine: readStart, endLine: readEnd }),
                                  }));
                                } else {
                                  ws.send(JSON.stringify({
                                    type: "tool_call",
                                    callId,
                                    tool: rawTool,
                                    pending: false,
                                    path: rawTool === "list_dir" ? (pathStr ?? ".") : pathStr,
                                    command: (rawTool === "run_terminal_cmd" && typeof command === "string") ? command.trim() : undefined,
                                    content: contentForPayload,
                                    ...(rawTool === "read_file" && readStart != null && readEnd != null && { startLine: readStart, endLine: readEnd }),
                                  }));
                                }
                                toolCallSendCount += 1;
                              }
                              continue;
                            }
                            if (ALLOWED_BUILTIN_TOOLS.has(rawTool)) {
                              // Built-in we allow: send pending first, then when completed send full payload (e.g. todowrite with todos).
                              if (ws.readyState === ws.OPEN) {
                                if (pending) {
                                  ws.send(JSON.stringify({
                                    type: "tool_call",
                                    callId,
                                    tool: rawTool,
                                    pending: true,
                                    path: pathStr,
                                    command: rawTool === "run_terminal_cmd" ? (typeof command === "string" ? command.trim() : undefined) : undefined,
                                    content: undefined,
                                  }));
                                } else {
                                  const todoPayload: Record<string, unknown> = {
                                    type: "tool_call",
                                    callId,
                                    tool: rawTool,
                                    pending: false,
                                    path: pathStr,
                                    content: contentForPayload,
                                    ...(rawTool === "todowrite" && Array.isArray(inp.todos) && { todos: inp.todos }),
                                    ...(rawTool === "todoread" && Array.isArray(inp.todos) && { todos: inp.todos }),
                                  };
                                  ws.send(JSON.stringify(todoPayload));
                                }
                                toolCallSendCount += 1;
                              }
                              continue;
                            }
                            // Built-in tool names are disabled — do not execute; only custom tools run (via OpenCode stubs + our API).
                            console.warn("[agent] Ignoring built-in tool (custom tools only):", rawTool);
                            if (ws.readyState === ws.OPEN) {
                              ws.send(JSON.stringify({
                                type: "tool_call",
                                callId,
                                tool: rawTool,
                                pending: false,
                                path: pathStr,
                                content: "Built-in tools are disabled. Use the corresponding custom tool (e.g. read_file, run_terminal_cmd, edit_file).",
                              }));
                              toolCallSendCount += 1;
                            }
                            continue;
                          }
                          if (editWriteOk && ws.readyState === ws.OPEN) {
                            ws.send(JSON.stringify(payload));
                            toolCallSendCount += 1;
                            if (isEditOrWrite && (tool === "write" || tool === "edit")) {
                              console.log("[agent] tool_call sent:", tool, pathStr ?? "(no path)");
                            }
                            if (tool === "bash" && contentForPayload) {
                              const port = detectAndRegister(workspaceId, String(contentForPayload));
                              if (port != null && ws.readyState === ws.OPEN) {
                                waitForPortReachable(port, 15000).then((host) => {
                                  if (host) setPreviewHost(workspaceId, host);
                                  if (ws.readyState === ws.OPEN) {
                                    ws.send(JSON.stringify({ type: "preview_ready", workspaceId, port, url: `http://localhost:${port}` }));
                                  }
                                });
                              }
                            }
                          } else if (isEditOrWrite) {
                            console.warn("[agent] write/edit tool not sent: rawTool=", rawTool, "path=", pathStr ?? "(missing)", "hasContent=", hasContent, "pending=", pending);
                          }
                        }
                        if (toolCallsToRun.length > 0) {
                          try {
                            const { results } = await executeToolCallsParallel(workspaceId, toolCallsToRun, {
                              onStream(callId, chunk) {
                                if (ws.readyState === ws.OPEN) {
                                  const chunkStr = String(chunk);
                                  ws.send(JSON.stringify({ type: "tool_output_stream", callId, chunk: chunkStr }));
                                  const port = detectAndRegister(workspaceId, chunkStr);
                                  if (port != null) {
                                    waitForPortReachable(port, 15000).then((host) => {
                                      if (host) setPreviewHost(workspaceId, host);
                                      if (ws.readyState === ws.OPEN) {
                                        ws.send(JSON.stringify({ type: "preview_ready", workspaceId, port, url: `http://localhost:${port}` }));
                                      }
                                    });
                                  }
                                  if (detectRebuildFromOutput(chunkStr)) {
                                    ws.send(JSON.stringify({ type: "preview_refresh", workspaceId }));
                                  }
                                }
                              },
                              onStreamEnd(callId, exitCode) {
                                if (ws.readyState === ws.OPEN) {
                                  ws.send(JSON.stringify({ type: "tool_output_end", callId, exitCode: exitCode ?? undefined }));
                                }
                              },
                            });
                            for (const r of results) {
                              const displayTool = r.tool === "run_terminal_cmd" ? "bash" : r.tool === "edit_file" || r.tool === "write_file" ? "edit" : r.tool === "read_file" ? "read" : r.tool;
                              if (displayTool === "bash") {
                                if (r.tool === "run_terminal_cmd" && r.success && r.output) {
                                  const port = detectAndRegister(workspaceId, r.output);
                                  if (port != null && ws.readyState === ws.OPEN) {
                                    waitForPortReachable(port, 15000).then((host) => {
                                      if (host) setPreviewHost(workspaceId, host);
                                      if (ws.readyState === ws.OPEN) {
                                        ws.send(JSON.stringify({ type: "preview_ready", workspaceId, port, url: `http://localhost:${port}` }));
                                      }
                                    });
                                  }
                                }
                                continue;
                              }
                              const orig = toolCallsToRun.find((t) => t.callId === r.callId);
                              const pathForPayload = orig && typeof orig.args === "object" && orig.args !== null
                                ? (orig.args as Record<string, unknown>).target_file ?? (orig.args as Record<string, unknown>).path ?? (orig.args as Record<string, unknown>).file_path ?? (orig.args as Record<string, unknown>).relative_workspace_path
                                : undefined;
                              const payloadToSend: Record<string, unknown> = {
                                type: "tool_call",
                                callId: r.callId,
                                tool: displayTool,
                                pending: false,
                                path: pathForPayload,
                                content: r.success ? r.output : r.error,
                              };
                              if (ws.readyState === ws.OPEN) {
                                ws.send(JSON.stringify(payloadToSend));
                                toolCallSendCount += 1;
                              }
                            }
                          } catch (routerErr) {
                            console.error("[agent] tool router error:", routerErr instanceof Error ? routerErr.message : String(routerErr));
                            if (ws.readyState === ws.OPEN) {
                              for (const t of toolCallsToRun) {
                                ws.send(JSON.stringify({
                                  type: "tool_call",
                                  callId: t.callId,
                                  tool: t.tool === "run_terminal_cmd" ? "bash" : t.tool,
                                  pending: false,
                                  content: "Tool execution failed.",
                                }));
                              }
                            }
                          }
                        }
                        if (ev.type === "error" && ev.error) {
                      const errMsg = ev.error.data?.message ?? ev.error.name ?? "Unknown error";
                      console.error("[agent] OpenCode error:", errMsg);
                      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "error", error: errMsg }));
                    }
                    // step_start, step_finish, etc. are ignored - not forwarded to chat
                  } catch (parseErr) {
                    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
                    const snippet = objStr.slice(0, 120).replace(/\s/g, " ");
                    if (msg.includes("Unexpected end of JSON input") || msg.includes("end of data")) {
                      const rest = objects.slice(oi + 1);
                      jsonlBuffer = trimmed + (rest.length ? "\n" + rest.join("\n") : "") + (jsonlBuffer ? "\n" + jsonlBuffer : "");
                      break;
                    }
                    const recovered = extractToolCallFromBrokenLine(trimmed);
                    if (recovered && ws.readyState === ws.OPEN) {
                      const toolDisplay = CUSTOM_TOOL_NAMES.has(recovered.rawTool)
                        ? recovered.rawTool
                        : recovered.rawTool === "write_file"
                          ? "write"
                          : recovered.rawTool === "edit_file"
                            ? "edit"
                            : recovered.rawTool === "read_file"
                              ? "read"
                              : recovered.rawTool === "search_replace"
                                ? "edit"
                                : recovered.rawTool;
                      const isEditOrWrite = toolDisplay === "write" || toolDisplay === "edit";
                      const pathStr = recovered.path?.replace(/^<path>\s*/i, "").trim();
                      const sendRecovered =
                        (toolDisplay === "read" && pathStr) ||
                        (isEditOrWrite && pathStr) ||
                        CUSTOM_TOOL_NAMES.has(recovered.rawTool);
                      if (sendRecovered) {
                        toolEventIndex += 1;
                        const callId = `${recovered.callId}-${toolEventIndex}`;
                        ws.send(JSON.stringify({
                          type: "tool_call",
                          callId,
                          tool: toolDisplay,
                          pending: CUSTOM_TOOL_NAMES.has(recovered.rawTool),
                          path: pathStr,
                          content: (isEditOrWrite && recovered.content) ? stripCodeFences(recovered.content) : (recovered.content ?? undefined),
                        }));
                        toolCallSendCount += 1;
                        console.log("[agent] tool_call recovered from broken JSON:", toolDisplay, pathStr, recovered.content ? `content ${recovered.content.length} chars` : "no content");
                      }
                    }
                    const extractedText = extractTextFromFailedJson(trimmed);
                    if (extractedText && ws.readyState === ws.OPEN) {
                      ws.send(JSON.stringify({ type: "chunk", data: extractedText }));
                    }
                    logFirstParseFailure(trimmed, fixPartArrayShape(stripAnsiFromJson(trimmed)), msg);
                    console.warn("[agent] Failed to parse JSON object, skipping. Length:", objStr.length, "Error:", msg, "Snippet:", snippet + (objStr.length > 120 ? "…" : ""));
                  }
                }
              },
              onEnd(code) {
                done();
                console.log("[agent] process ended, code:", code, "chunks sent:", chunkCount, "tool_call messages sent:", toolCallSendCount);
                if (ws.readyState === ws.OPEN) {
                  ws.send(JSON.stringify({ type: "end", code: code ?? undefined }));
                }
              },
              onError(err) {
                done();
                console.error("[agent] OpenCode error:", err.message);
                if (ws.readyState === ws.OPEN) {
                  ws.send(JSON.stringify({ type: "error", error: err.message }));
                }
              },
            }, msg.model, opencodeSessionId, chatSessionId);
            running.set(key, proc);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: "error", error: message }));
            }
          }
        } else if (msg.type === ABORT && msg.workspaceId) {
          for (const [k, proc] of running) {
            if (k.startsWith(msg.workspaceId!)) {
              abortProcess(proc);
              running.delete(k);
            }
          }
        }
      } catch (e) {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "error", error: String(e) }));
        }
      }
    });

    ws.on("close", () => {
      // Unregister so execute-tool API doesn't push to a closed socket
      // We don't have workspaceId/chatSessionId here, so we clear any entries that point to this ws
      for (const [k, socket] of sessionSockets) {
        if (socket === ws) {
          sessionSockets.delete(k);
          break;
        }
      }
    });
  });
}
