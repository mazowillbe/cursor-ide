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

export async function ensureWorkspaceRoot(): Promise<void> {
  await fs.mkdir(workspaceRoot, { recursive: true });
}

export function getWorkspacePath(workspaceId: WorkspaceId): string {
  return path.join(workspaceRoot, workspaceId);
}

/**
 * Find the project root (directory containing package.json) within the workspace.
 * Checks workspace root first, then one level of subdirectories (e.g. /workspace/<id>/todo-app).
 * Returns that directory path, or the workspace path if no package.json is found.
 */
export function findProjectRoot(workspaceId: WorkspaceId): string {
  const base = getWorkspacePath(workspaceId);
  if (existsSync(path.join(base, "package.json"))) return base;
  try {
    const entries = readdirSync(base, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        const candidate = path.join(base, e.name);
        if (existsSync(path.join(candidate, "package.json"))) return candidate;
      }
    }
  } catch {
    // ignore readdir errors, fall back to workspace root
  }
  return base;
}

/** Run git init in the workspace so we can track diffs. Safe to call if already a repo. */
export function initGitInWorkspace(workspaceId: WorkspaceId): void {
  const dir = getWorkspacePath(workspaceId);
  if (!existsSync(dir)) return;
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
  await fs.mkdir(dir, { recursive: true });
  initGitInWorkspace(id);
  return id;
}

/** Create workspace folder with a specific ID (e.g. Supabase project ID). */
export async function createWorkspaceWithId(id: WorkspaceId): Promise<void> {
  await ensureWorkspaceRoot();
  const dir = getWorkspacePath(id);
  await fs.mkdir(dir, { recursive: true });
  if (config.useSupabaseFiles) {
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
