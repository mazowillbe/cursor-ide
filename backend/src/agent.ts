import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawn, type ChildProcess } from "child_process";
import { getWorkspacePath, createWorkspaceWithId } from "./workspace.js";
import { getHardcodedAgentConfig } from "./agent-config.js";

const require = createRequire(import.meta.url);
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const opencodeConfigDir = path.resolve(__dirname, "..", "opencode-config");

/** Create auth.json for OpenCode Zen when OPENCODE_ZEN_API_KEY is set. Returns env overrides (XDG_DATA_HOME) or {}. */
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
    console.warn("[agent] failed to write Zen auth.json:", err);
    return {};
  }
}

export type WorkspaceId = string;

export interface AgentStreamCallbacks {
  onData: (chunk: string) => void;
  onEnd: (code: number | null) => void;
  onError: (err: Error) => void;
}

type ProcessHandle = ChildProcess | { kill(signal?: string | number): void };

/**
 * Run OpenCode in non-interactive mode: opencode run "user message"
 * Uses node-pty when available so OpenCode gets a TTY and streams output (no buffering).
 * Falls back to spawn if node-pty fails.
 * Tools and system prompt are hardcoded via OPENCODE_CONFIG_CONTENT.
 * Pass chatSessionId so custom tools can call back to our execute-tool API.
 */
export async function runOpenCode(
  workspaceId: WorkspaceId,
  message: string,
  callbacks: AgentStreamCallbacks,
  model?: string,
  opencodeSessionId?: string,
  chatSessionId?: string
): Promise<ProcessHandle> {
  await createWorkspaceWithId(workspaceId);
  const cwd = getWorkspacePath(workspaceId);
  const opencode = config.openCodePath;
  const modelId = model || config.openCodeDefaultModel;
  const configPath = await getHardcodedAgentConfig(cwd);
  const backendUrl = `http://127.0.0.1:${config.port}`;
  const zenAuthEnv = setupZenAuth();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...zenAuthEnv,
    OPENCODE_CLIENT: "cursor-web",
    OPENCODE_CONFIG_DIR: opencodeConfigDir,
    OPENCODE_WORKSPACE_ID: workspaceId,
    OPENCODE_CHAT_SESSION_ID: chatSessionId ?? "",
    OPENCODE_BACKEND_URL: backendUrl,
    // OPENCODE_CONFIG_CONTENT is inline config (highest precedence); OPENCODE_CONFIG is a file path.
    ...(configPath && { OPENCODE_CONFIG_CONTENT: configPath }),
    ...(process.env.GEMINI_API_KEY && { GEMINI_API_KEY: process.env.GEMINI_API_KEY }),
  };
  if (zenAuthEnv.XDG_DATA_HOME) {
    console.log("[agent] Zen API key configured via OPENCODE_ZEN_API_KEY (bearer token)");
  }
  if (configPath) {
    console.log("[agent] system prompt and config loaded from", configPath);
  } else {
    console.warn("[agent] getHardcodedAgentConfig returned null; OpenCode may use default config");
  }
  const isWin = process.platform === "win32";
  // Use npx when OPENCODE_PATH is default so it works on Render (no global install)
  const useNpx = opencode === "opencode" || opencode === "opencode.cmd";
  const opencodeCmd = useNpx ? "npx -y opencode-ai" : opencode;
  if (useNpx) {
    console.log("[agent] using npx opencode-ai (no global opencode)");
  }
  const messageForShell = isWin
    ? message.replace(/\r?\n/g, " ").replace(/\s{2,}/g, " ").trim()
    : message;
  // On Windows cmd.exe, escape double quotes by doubling them (""). Backslash does not escape inside "..." in cmd.
  const quotedMessage = isWin
    ? messageForShell.replace(/"/g, '""')
    : messageForShell.replace(/"/g, '\\"');
  const jsonFlag = config.openCodeUseJson ? " --format json" : "";
  const sessionFlag = opencodeSessionId ? ` -s ${opencodeSessionId}` : "";
  if (opencodeSessionId) console.log("[agent] continuing OpenCode session", opencodeSessionId);

  // Prefer PTY so the child sees a TTY and streams output (no buffering). On Windows we default to spawn (no PTY) for clean stderr.
  const usePty = config.openCodeUsePty;

  // Buffer last output to log when OpenCode exits with error (no PTY path has stdout+stderr merged)
  let lastOutput = "";
  const MAX_BUFFER = 4000;
  const pushOutput = (data: string) => {
    lastOutput += data;
    if (lastOutput.length > MAX_BUFFER) lastOutput = lastOutput.slice(-MAX_BUFFER);
  };
  const wrappedOnData = (chunk: string) => {
    pushOutput(chunk);
    callbacks.onData(chunk);
  };
  const wrappedOnEnd = (code: number | null) => {
    console.log("[agent] OpenCode process ended, code:", code);
    if (code != null && code !== 0) {
      const tail = lastOutput.length > 3000 ? "\n... (truncated)\n" + lastOutput.slice(-3000) : lastOutput;
      console.error("[agent] OpenCode exited with code", code, ". Last output:", tail);
    }
    callbacks.onEnd(code);
  };

  if (usePty) {
    try {
      const pty = require("node-pty");
      const shell = process.platform === "win32" ? "cmd.exe" : "sh";
      const args =
        process.platform === "win32"
          ? ["/c", `${opencodeCmd} run${jsonFlag}${sessionFlag} -m ${modelId} "${quotedMessage}"`]
          : ["-c", `${opencodeCmd} run${jsonFlag}${sessionFlag} -m ${modelId} "${quotedMessage}"`];

      const ptyOpts: Record<string, unknown> = {
        cwd,
        env: { ...env, TERM: "dumb" },
        cols: 120,
        rows: 30,
      };
      // On Windows, ConPTY often delivers only the initial TTY setup (escape codes) then no more data.
      // Use winpty instead so we get full streamed output from the child.
      if (process.platform === "win32") {
        ptyOpts.useConpty = false;
      }
      const ptyProcess = pty.spawn(shell, args, ptyOpts);

      ptyProcess.onData((data: string) => wrappedOnData(data));
      ptyProcess.onExit(({ exitCode }: { exitCode: number }) => wrappedOnEnd(exitCode));

      return {
        kill(signal?: string | number) {
          ptyProcess.kill(signal as string);
        },
      };
    } catch (err) {
      // Fall through to spawn
    }
  }

  {
    // Spawn (no PTY): used on Windows with JSON to avoid TTY escape codes, or when node-pty fails
    if (!usePty && config.openCodeUseJson) {
      console.log("[agent] using spawn (no PTY) for JSON on Windows");
    }
    const useShell = process.platform === "win32";
    const sessionArgs = opencodeSessionId ? ["-s", opencodeSessionId] : [];
    const runArgs = ["run", ...(config.openCodeUseJson ? ["--format", "json"] : []), ...sessionArgs, "-m", modelId, message];
    const spawnEnv = { ...env, TERM: "dumb" };

    let child: ChildProcess;
    if (useShell) {
      const cmd = `${opencodeCmd} run${jsonFlag}${sessionFlag} -m ${modelId} "${quotedMessage}"`;
      child = spawn(cmd, [], { cwd, env: spawnEnv, shell: true });
    } else if (useNpx) {
      child = spawn("npx", ["-y", "opencode-ai", ...runArgs], { cwd, env: spawnEnv });
    } else {
      child = spawn(opencodeCmd, runArgs, { cwd, env: spawnEnv });
    }

    // Close stdin so the child gets EOF and doesn't hang waiting for input (e.g. npx or opencode prompts)
    child.stdin?.end();

    console.log("[agent] OpenCode process started (spawn), cwd:", cwd);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => wrappedOnData(data));
    child.stderr?.on("data", (data: string) => wrappedOnData(data));
    child.on("error", (err: NodeJS.ErrnoException) => {
      const msg =
        err.code === "ENOENT"
          ? `OpenCode not found. Install: npm install -g opencode-ai`
          : err.message;
      callbacks.onError(new Error(msg));
    });
    child.on("close", (code) => wrappedOnEnd(code));

    return child;
  }
}

export function abortProcess(proc: ProcessHandle): void {
  try {
    proc.kill?.("SIGTERM");
  } catch {
    try {
      proc.kill?.("SIGKILL");
    } catch {
      // ignore
    }
  }
}
