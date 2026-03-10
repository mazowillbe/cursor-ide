/**
 * Command sandbox: workspace isolation, directory restrictions, allowlist, and resource limits
 * for run_terminal_cmd so the agent cannot escape the workspace or run arbitrary system commands.
 */

import path from "path";

/** Allowed executables (first word of each command segment). Case-insensitive. */
const ALLOWED = new Set([
  "npm",
  "npx",
  "node",
  "yarn",
  "pnpm",
  "git",
  "supabase",
  "cmd",
  "echo",
  "true",
  "false",
]);
/** 'cd' is allowed only when the target path is workspace-relative (validated separately). */
const CD_ALLOWED = "cd";

/** Dangerous substrings that must not appear in commands (defense in depth). */
const BLOCKED_PATTERNS = [
  /\bsudo\b/i,
  /\bsu\s+/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\brm\s+-[rf]+/i, // rm -rf, rm -fr, rm -r -f, etc.
  /\bcurl\s+\S+\s*\|/i,
  /\bwget\s+\S+\s*\|/i,
  /\|\s*bash\b/i,
  /\|\s*sh\b/i,
  /\beval\s+/i,
];

/** Max time a command can run (ms). 30 min for Docker/Render resource limits. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Split a shell command into segments (by && and ;).
 * Each segment is trimmed; we only care about the first token (executable).
 */
function getSegments(command: string): string[] {
  return command
    .split(/\s*[;&]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Get the first "executable" token of a segment (handles "cd path" -> cd, "npm run dev" -> npm).
 * Strips .cmd / .exe on Windows for comparison.
 */
function firstToken(segment: string): string {
  const m = segment.match(/^\s*(\S+)/);
  if (!m) return "";
  let token = m[1]!.toLowerCase();
  if (token.endsWith(".cmd") || token.endsWith(".exe")) token = token.replace(/\.(cmd|exe)$/, "");
  return token;
}

/**
 * Check if command contains any blocked dangerous patterns.
 */
function hasBlockedPattern(command: string): boolean {
  return BLOCKED_PATTERNS.some((p) => p.test(command));
}

/** Common dir/file names the AI sometimes wrongly passes as commands. */
const BARE_PATH_PATTERN = /^[\w./\\-]+\.(jsx?|tsx?|css|html|json|md|txt)$|^(src|public|components|app|lib|pages)$/i;

/**
 * Detect commands that look like bare file/dir paths (e.g. "src", "Landing.jsx", "main.jsx").
 * The AI sometimes confuses these with shell commands. Use list_dir/read_file instead.
 */
export function looksLikeBarePath(command: string): boolean {
  const t = command.trim();
  if (!t || t.includes(" ")) return false;
  return BARE_PATH_PATTERN.test(t);
}

/**
 * Command allowlist: only these executables may be run.
 * Returns true if every segment's first token is allowed (including "cd" when path is safe).
 */
export function isCommandAllowed(command: string): boolean {
  if (hasBlockedPattern(command)) return false;
  const segments = getSegments(command);
  for (const seg of segments) {
    const token = firstToken(seg);
    if (!token) continue;
    if (ALLOWED.has(token)) continue;
    if (token === CD_ALLOWED) {
      const cdMatch = seg.match(/^cd\s+(.+)$/s);
      const target = cdMatch ? cdMatch[1].trim().replace(/^["']|["']$/g, "").trim() : "";
      if (!target || target === ".") continue;
      if (target.startsWith("..") || target.includes("/..") || target.includes("\\..")) return false;
      if (/^[a-z]:[\\/]/i.test(target) || target.startsWith("/") || target.startsWith("\\")) return false;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Workspace isolation / directory restrictions: reject commands that try to leave the project root.
 * projectRoot should be the absolute path to the workspace project (e.g. findProjectRoot result).
 */
export function isCommandAttemptingEscape(command: string, projectRoot: string): boolean {
  const normalizedRoot = path.normalize(projectRoot);
  const segments = getSegments(command);

  for (const seg of segments) {
    const t = seg.trim();
    if (!t.toLowerCase().startsWith("cd ")) continue;
    const rest = t.slice(3).trim();
    const pathPart = rest.replace(/^["']|["']$/g, "").trim().split(/\s/)[0] ?? "";
    if (!pathPart || pathPart === ".") continue;
    if (pathPart.startsWith("..") || pathPart.includes("..")) return true;
    if (path.isAbsolute(pathPart)) return true;
    if (/^[a-z]:/i.test(pathPart)) return true;
    const resolved = path.normalize(path.join(normalizedRoot, pathPart));
    if (!resolved.startsWith(normalizedRoot)) return true;
  }

  return false;
}
