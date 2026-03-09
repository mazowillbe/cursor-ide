import fs from "fs/promises";
import { existsSync, readdirSync } from "fs";
import path from "path";
import { execSync, spawn } from "child_process";
import { randomUUID } from "crypto";
import { config } from "./config.js";
import {
  syncSupabaseToDisk,
  syncDiskToSupabase,
  writeFileToSupabase,
  createFolderInSupabase,
  deletePathFromSupabase,
} from "./workspace-supabase.js";

export type WorkspaceId = string;

const workspaceRoot = path.resolve(process.cwd(), config.workspaceRoot);

/** Cache for project root to avoid repeated filesystem traversal */
const projectRootCache = new Map<WorkspaceId, string>();

/** Template workspace used for snapshot cloning to reduce startup time. Not pruned. */
const TEMPLATE_DIR_NAME = "_template";

/**
 * Clear the project root cache for a workspace (call when files are created/deleted).
 */
export function invalidateProjectRootCache(workspaceId: WorkspaceId): void {
  projectRootCache.delete(workspaceId);
}

export async function ensureWorkspaceRoot(): Promise<void> {
  await fs.mkdir(workspaceRoot, { recursive: true });
}

/**
 * Ensure the snapshot template directory exists (minimal skeleton so new workspaces copy from it).
 * Used by createWorkspace / createWorkspaceWithId for faster startup than empty dir + git init.
 */
async function ensureTemplateDir(): Promise<string> {
  const templatePath = path.join(workspaceRoot, TEMPLATE_DIR_NAME);
  if (!existsSync(templatePath)) {
    await fs.mkdir(templatePath, { recursive: true });
    await fs.writeFile(
      path.join(templatePath, ".gitignore"),
      "node_modules\n.env\n.env.local\n.DS_Store\n",
      "utf8"
    );
  }
  return templatePath;
}

export function getWorkspacePath(workspaceId: WorkspaceId): string {
  return path.join(workspaceRoot, workspaceId);
}

/**
 * Find the project root (directory containing package.json) within the workspace.
 * Checks workspace root first, then up to 3 levels of subdirectories.
 * Uses caching to avoid repeated filesystem calls.
 * Returns that directory path, or the workspace path if no package.json is found.
 */
export function findProjectRoot(workspaceId: WorkspaceId): string {
  // Check cache first
  const cached = projectRootCache.get(workspaceId);
  if (cached && existsSync(cached)) return cached;

  const base = getWorkspacePath(workspaceId);
  
  // Helper to check if a directory contains package.json
  const hasPackageJson = (dir: string) => existsSync(path.join(dir, "package.json"));
  
  const buildConfigFiles = [
    "vite.config.js", "vite.config.ts", "vite.config.mjs", "vite.config.mts",
    "next.config.js", "next.config.mjs", "next.config.ts",
    "nuxt.config.js", "nuxt.config.ts",
    "webpack.config.js", "webpack.config.ts",
    "rollup.config.js", "rollup.config.ts",
    "esbuild.config.js",
  ];
  
  const hasBuildConfig = (dir: string) => buildConfigFiles.some(f => existsSync(path.join(dir, f)));

  // Check workspace root
  if (hasPackageJson(base)) {
    projectRootCache.set(workspaceId, base);
    return base;
  }

  // Search up to 3 levels deep for package.json
  const maxDepth = 3;
  const found = findPackageJsonDeep(base, maxDepth, hasPackageJson, hasBuildConfig);
  if (found) {
    projectRootCache.set(workspaceId, found);
    return found;
  }

  // Fall back to workspace root
  projectRootCache.set(workspaceId, base);
  return base;
}

/**
 * Recursively search for package.json up to maxDepth levels.
 * Prioritizes directories with build config files (vite.config.*, next.config.*, etc.)
 */
function findPackageJsonDeep(
  base: string, 
  maxDepth: number, 
  checkPackageJson: (dir: string) => boolean,
  checkBuildConfig: (dir: string) => boolean
): string | null {

  interface DirEntry {
    path: string;
    depth: number;
  }

  const candidates: DirEntry[] = [];

  function searchDir(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    
    if (checkPackageJson(dir)) {
      // Score this directory: prefer those with build config files
      const score = checkBuildConfig(dir) ? 2 : 1;
      candidates.push({ path: dir, depth: score });
    }

    if (depth < maxDepth) {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
            searchDir(path.join(dir, e.name), depth + 1);
          }
        }
      } catch {
        // Ignore readdir errors
      }
    }
  }

  try {
    searchDir(base, 0);
  } catch {
    return null;
  }

  if (candidates.length === 0) return null;

  // Sort by score (depth is repurposed as score: build config = 2, just package.json = 1)
  candidates.sort((a, b) => b.depth - a.depth);
  return candidates[0]!.path;
}

/** Run git init in the workspace so we can track diffs. Skips if .git already exists to avoid re-init warning. */
export function initGitInWorkspace(workspaceId: WorkspaceId): void {
  const dir = getWorkspacePath(workspaceId);
  if (!existsSync(dir)) return;
  if (existsSync(path.join(dir, ".git"))) return;
  try {
    execSync("git init -b main", { cwd: dir, encoding: "utf-8" });
  } catch (err) {
    console.warn("[workspace] git init failed for", workspaceId, err instanceof Error ? err.message : err);
  }
}

export async function createWorkspace(): Promise<WorkspaceId> {
  await ensureWorkspaceRoot();
  const id = randomUUID();
  const dir = getWorkspacePath(id);
  const templatePath = await ensureTemplateDir();
  await fs.cp(templatePath, dir, { recursive: true });
  const gitDir = path.join(dir, ".git");
  if (existsSync(gitDir)) await fs.rm(gitDir, { recursive: true, force: true });
  initGitInWorkspace(id);
  return id;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Create workspace folder with a specific ID (e.g. Supabase project ID). */
export async function createWorkspaceWithId(id: WorkspaceId): Promise<void> {
  await ensureWorkspaceRoot();
  const dir = getWorkspacePath(id);
  const templatePath = await ensureTemplateDir();
  await fs.cp(templatePath, dir, { recursive: true });
  const gitDir = path.join(dir, ".git");
  if (existsSync(gitDir)) await fs.rm(gitDir, { recursive: true, force: true });
  if (config.useSupabaseFiles && UUID_REGEX.test(id)) {
    await syncSupabaseToDisk(id, dir);
  }
  initGitInWorkspace(id);
}

export async function listWorkspaceFiles(workspaceId: WorkspaceId, dir = "."): Promise<FileNode[]> {
  const base = getWorkspacePath(workspaceId);
  const target = path.join(base, dir);
  const normalized = path.normalize(dir);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error("Invalid path");
  }
  const HIDDEN_FILES = new Set(["system-prompt.txt", "tools.json", "opencode.json"]);
  const entries = await fs.readdir(target, { withFileTypes: true });
  const nodes: FileNode[] = [];
  for (const e of entries) {
    if (dir === "." && HIDDEN_FILES.has(e.name)) continue;
    const rel = path.join(dir, e.name);
    const full = path.join(base, rel);
    const stat = await fs.stat(full);
    nodes.push({
      name: e.name,
      path: rel.replace(/\\/g, "/"),
      kind: stat.isDirectory() ? "directory" : "file",
    });
  }
  return nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export interface FileNode {
  name: string;
  path: string;
  kind: "file" | "directory";
}

export async function readFile(workspaceId: WorkspaceId, filePath: string): Promise<string> {
  const base = getWorkspacePath(workspaceId);
  const full = path.join(base, path.normalize(filePath));
  if (!full.startsWith(base)) throw new Error("Invalid path");
  const content = await fs.readFile(full, "utf-8");
  return content;
}

export async function writeFile(
  workspaceId: WorkspaceId,
  filePath: string,
  content: string
): Promise<void> {
  const base = getWorkspacePath(workspaceId);
  const full = path.join(base, path.normalize(filePath));
  if (!full.startsWith(base)) throw new Error("Invalid path");
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
  if (config.useSupabaseFiles) {
    await writeFileToSupabase(workspaceId, filePath, content).catch((e) =>
      console.warn("[workspace] Supabase write failed:", (e as Error).message)
    );
  }
}

export async function createFolder(
  workspaceId: WorkspaceId,
  folderPath: string
): Promise<void> {
  const base = getWorkspacePath(workspaceId);
  const full = path.join(base, path.normalize(folderPath));
  if (!full.startsWith(base)) throw new Error("Invalid path");
  await fs.mkdir(full, { recursive: true });
  if (config.useSupabaseFiles) {
    await createFolderInSupabase(workspaceId, folderPath).catch((e) =>
      console.warn("[workspace] Supabase createFolder failed:", (e as Error).message)
    );
  }
}

export async function deletePath(workspaceId: WorkspaceId, filePath: string): Promise<void> {
  const base = getWorkspacePath(workspaceId);
  const full = path.join(base, path.normalize(filePath));
  if (!full.startsWith(base)) throw new Error("Invalid path");
  await fs.rm(full, { recursive: true });
  if (config.useSupabaseFiles) {
    await deletePathFromSupabase(workspaceId, filePath).catch((e) =>
      console.warn("[workspace] Supabase delete failed:", (e as Error).message)
    );
  }
}

export async function workspaceExists(workspaceId: WorkspaceId): Promise<boolean> {
  const p = getWorkspacePath(workspaceId);
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prune workspace directories older than config.maxWorkspaceAgeMs (resource limits and auto-cleanup).
 * Skips workspace IDs in activeWorkspaceIds (e.g. sessions with open WebSockets).
 * Returns the number of workspaces removed.
 */
export async function pruneOldWorkspaces(activeWorkspaceIds: Set<string>): Promise<number> {
  const maxAge = config.maxWorkspaceAgeMs ?? 24 * 60 * 60 * 1000;
  const deadline = Date.now() - maxAge;
  let removed = 0;
  try {
    const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const id = e.name;
      if (id === TEMPLATE_DIR_NAME || activeWorkspaceIds.has(id)) continue;
      const dirPath = path.join(workspaceRoot, id);
      try {
        const stat = await fs.stat(dirPath);
        if (stat.mtimeMs < deadline) {
          await fs.rm(dirPath, { recursive: true, force: true });
          removed++;
          console.log("[workspace] pruned old workspace", id);
        }
      } catch (err) {
        console.warn("[workspace] prune stat/rm failed for", id, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.warn("[workspace] prune readdir failed", err instanceof Error ? err.message : err);
  }
  return removed;
}

export interface RunCommandStreamCallbacks {
  onChunk: (chunk: string) => void;
  onEnd: (exitCode: number | null) => void;
}

export interface RunCommandStreamOptions {
  /** Max run time (ms). Process is killed after this. Omit for no limit. */
  timeoutMs?: number;
}

/**
 * If the command is "cd <path> [&&|;] <rest>" and path equals workspacePath (normalized),
 * return <rest> so we don't run a redundant cd that can break on Windows (quoting).
 * If the command is only "cd <path>", return a no-op (echo.) so we don't fail.
 */
function stripRedundantCd(command: string, workspacePath: string): string {
  const trimmed = command.trim();
  const normalizedWorkspace = path.normalize(workspacePath);
  const win = process.platform === "win32";

  // Match: cd "path" or cd 'path' or cd path, optionally followed by && or ; and rest
  const cdDouble = /^cd\s+"([^"]+)"\s*(&&|;)?\s*/;
  const cdSingle = /^cd\s+'([^']+)'\s*(&&|;)?\s*/;
  const cdUnquoted = /^cd\s+(\S+)\s*(&&|;)?\s*/;

  for (const re of [cdDouble, cdSingle, cdUnquoted]) {
    const m = trimmed.match(re);
    if (!m) continue;
    const targetPath = path.normalize(m[1]!.trim());
    const rest = trimmed.slice(m[0].length).trim();
    const same = win
      ? targetPath.toLowerCase() === normalizedWorkspace.toLowerCase()
      : targetPath === normalizedWorkspace;
    if (!same) continue;
    // Strip redundant cd: run the rest, or no-op if nothing after
    return rest.length > 0 ? rest : (win ? "echo." : "true");
  }

  return trimmed;
}

/**
 * Run a shell command in the workspace and stream stdout/stderr to callbacks.
 * Uses the project root (directory containing package.json) as cwd when present,
 * e.g. /workspace/<workspaceId>/todo-app, so npm run dev etc. run in the right folder.
 * Strips redundant "cd <path>" prefix when path equals cwd (fixes Windows quoting).
 */
export function runCommandStream(
  workspaceId: WorkspaceId,
  command: string,
  callbacks: RunCommandStreamCallbacks,
  options?: RunCommandStreamOptions
): { kill: () => void } {
  const cwd = findProjectRoot(workspaceId);
  const commandToRun = stripRedundantCd(command, cwd);
  const isWin = process.platform === "win32";
  const shell = isWin ? "cmd.exe" : "/bin/sh";
  const args = isWin ? ["/c", commandToRun] : ["-c", commandToRun];
  const child = spawn(shell, args, {
    cwd,
    env: { ...process.env, TERM: "dumb" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ended = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (options?.timeoutMs != null && options.timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      if (ended) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // already dead
      }
      callbacks.onChunk("\n[Command timed out and was terminated.]\n");
      finish(-1);
    }, options.timeoutMs);
  }
  const finish = (code: number | null) => {
    if (ended) return;
    ended = true;
    if (timeoutId != null) clearTimeout(timeoutId);
    callbacks.onEnd(code);
  };
  const enc = "utf8";
  child.stdout?.setEncoding(enc);
  child.stderr?.setEncoding(enc);
  child.stdout?.on("data", (data: string | Buffer) => callbacks.onChunk(String(data)));
  child.stderr?.on("data", (data: string | Buffer) => callbacks.onChunk(String(data)));
  child.on("error", (err) => {
    callbacks.onChunk(`Error: ${err.message}\n`);
    finish(1);
  });
  child.on("close", (code, signal) => finish(signal != null ? 130 : code));
  return {
    kill() {
      child.kill("SIGTERM");
    },
  };
}
