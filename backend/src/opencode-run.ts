/**
 * Run OpenCode in non-interactive mode and collect text output.
 * Used for: chat title, project name, apply-edit (replacing Gemini).
 * Parses --format json output and returns combined text from "text" events.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { config } from "./config.js";
import { getWorkspacePath, createWorkspaceWithId } from "./workspace.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const opencodeConfigDir = path.resolve(__dirname, "..", "opencode-config");

export type WorkspaceId = string;

/** Create auth.json for OpenCode Zen when OPENCODE_ZEN_API_KEY is set. */
function setupZenAuth(): NodeJS.ProcessEnv {
  const zenKey = process.env.OPENCODE_ZEN_API_KEY?.trim();
  if (!zenKey) return {};
  const dataDir = path.join(os.tmpdir(), "opencode-cursor-web-auth");
  const opencodeDir = path.join(dataDir, "opencode");
  const authPath = path.join(opencodeDir, "auth.json");
  try {
    fs.mkdirSync(opencodeDir, { recursive: true });
    const auth = { opencode: { type: "api" as const, key: zenKey } };
    fs.writeFileSync(authPath, JSON.stringify(auth), "utf8");
    return { XDG_DATA_HOME: dataDir };
  } catch (err) {
    console.warn("[opencode-run] failed to write Zen auth.json:", err);
    return {};
  }
}

export interface OpenCodeRunOptions {
  /** Working directory (default: process.cwd() or workspace path) */
  cwd?: string;
  /** Agent to use (e.g. "title", "apply-edit") */
  agent?: string;
  /** Model override (default: config.openCodeDefaultModel) */
  model?: string;
  /** Inline JSON config to merge (e.g. for apply-edit agent) */
  configContent?: string;
}

/**
 * Run opencode run with a prompt and return the combined text output.
 * Parses JSONL from stdout and collects part.text from type "text" events.
 */
export async function runOpenCodeAndGetText(
  prompt: string,
  options: OpenCodeRunOptions = {}
): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const opencode = config.openCodePath;
  const modelId = options.model ?? config.openCodeDefaultModel;
  const zenAuthEnv = setupZenAuth();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...zenAuthEnv,
    OPENCODE_CLIENT: "cursor-web",
    OPENCODE_CONFIG_DIR: opencodeConfigDir,
    TERM: "dumb",
    ...(options.configContent && { OPENCODE_CONFIG_CONTENT: options.configContent }),
  };

  const useNpx = opencode === "opencode" || opencode === "opencode.cmd";
  const opencodeCmd = useNpx ? "npx -y opencode-ai" : opencode;

  const isWin = process.platform === "win32";
  const messageForShell = isWin
    ? prompt.replace(/\r?\n/g, " ").replace(/\s{2,}/g, " ").trim()
    : prompt;
  const quotedMessage = isWin
    ? messageForShell.replace(/"/g, '""')
    : messageForShell.replace(/"/g, '\\"');

  const agentFlag = options.agent ? ` --agent ${options.agent}` : "";
  const cmd = isWin
    ? `${opencodeCmd} run --format json${agentFlag} -m ${modelId} "${quotedMessage}"`
    : undefined;

  const runArgs = [
    "run",
    "--format",
    "json",
    ...(options.agent ? ["--agent", options.agent] : []),
    "-m",
    modelId,
    prompt,
  ];

  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    let child;

    if (isWin && cmd) {
      child = spawn(cmd, [], { cwd, env, shell: true });
    } else if (useNpx) {
      child = spawn("npx", ["-y", "opencode-ai", ...runArgs], { cwd, env });
    } else {
      child = spawn(opencodeCmd, runArgs, { cwd, env });
    }

    child.stdin?.end();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (data: string) => chunks.push(data));
    child.stderr?.on("data", (data: string) => chunks.push(data));

    child.on("error", (err: NodeJS.ErrnoException) => {
      const msg =
        err.code === "ENOENT"
          ? "OpenCode not found. Install: npm install -g opencode-ai"
          : err.message;
      reject(new Error(msg));
    });

    child.on("close", (code) => {
      const raw = chunks.join("");
      const text = parseJsonlText(raw);
      if (code !== 0 && !text) {
        const tail = raw.length > 500 ? raw.slice(-500) : raw;
        reject(new Error(`OpenCode exited with code ${code}. Output: ${tail}`));
        return;
      }
      resolve(text || "");
    });
  });
}

/** Parse JSONL output and concatenate part.text from type "text" events. */
function parseJsonlText(raw: string): string {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const parts: string[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as { type?: string; part?: { text?: string } };
      if (obj.type === "text" && obj.part?.text) {
        parts.push(obj.part.text);
      }
    } catch {
      // skip malformed lines
    }
  }
  return parts.join("").trim();
}

/**
 * Run OpenCode in a workspace (ensures workspace exists).
 * Use for apply-edit where we pass full context in the prompt.
 */
export async function runOpenCodeInWorkspace(
  workspaceId: WorkspaceId,
  prompt: string,
  options: Omit<OpenCodeRunOptions, "cwd"> = {}
): Promise<string> {
  await createWorkspaceWithId(workspaceId);
  const cwd = getWorkspacePath(workspaceId);
  return runOpenCodeAndGetText(prompt, { ...options, cwd });
}
