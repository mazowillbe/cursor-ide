/**
 * WebSocket handler for interactive user terminal.
 * Spawns a PTY in the workspace so the user can run commands.
 * Nothing is written to the terminal from the app — it's purely user-driven.
 * Falls back to spawn when node-pty fails (e.g. on some Windows setups).
 */
import { spawn } from "child_process";
import fs from "fs/promises";
import type { WebSocket } from "ws";
import { getWorkspacePath } from "./workspace.js";

export const TERMINAL_WS_PATH = "/api/terminal";

type ProcHandle = { kill: () => void; write: (s: string) => void; resize?: (cols: number, rows: number) => void };

function spawnWithPty(ws: WebSocket, cwd: string): ProcHandle | null {
  try {
    const ptyModule = require("node-pty");
    const shell = process.platform === "win32" ? "cmd.exe" : process.env.SHELL || "bash";
    const args = process.platform === "win32" ? ["/K"] : ["-l"];
    const ptyOpts: Record<string, unknown> = {
      cwd,
      env: { ...process.env, TERM: "xterm-256color", NODE_ENV: "development" },
      cols: 80,
      rows: 24,
    };
    if (process.platform === "win32") {
      (ptyOpts as Record<string, unknown>).useConpty = false;
    }
    const ptyProcess = ptyModule.spawn(shell, args, ptyOpts);
    ptyProcess.onData((data: string) => {
      if (ws.readyState === 1) ws.send(data);
    });
    ptyProcess.onExit(() => ws.close());
    return {
      kill: () => ptyProcess.kill(),
      write: (s: string) => ptyProcess.write(s),
      resize: (cols: number, rows: number) => ptyProcess.resize(cols, rows),
    };
  } catch {
    return null;
  }
}

/**
 * Spawn a shell with a real PTY using `script` (Linux), so when node-pty
 * fails (e.g. in Docker) we still get TTY behavior (colors, interactive programs).
 */
function spawnWithChildProcess(ws: WebSocket, cwd: string): ProcHandle {
  const shell = process.platform === "win32" ? "cmd.exe" : process.env.SHELL || "bash";
  const env = { ...process.env, TERM: "xterm-256color", NODE_ENV: "development" };

  if (process.platform !== "win32") {
    try {
      const scriptShell = `${shell} -l`;
      const child = spawn("script", ["-q", "-c", `exec ${scriptShell}`, "/dev/null"], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => {
        if (ws.readyState === 1) ws.send(d);
      });
      child.stderr?.on("data", (d: string) => {
        if (ws.readyState === 1) ws.send(d);
      });
      child.on("exit", () => ws.close());
      return {
        kill: () => child.kill(),
        write: (s: string) => child.stdin?.write(s),
      };
    } catch {
      /* script not available, fall through to plain spawn */
    }
  }

  const args = process.platform === "win32" ? ["/K"] : ["-l"];
  const child = spawn(shell, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => {
    if (ws.readyState === 1) ws.send(d);
  });
  child.stderr?.on("data", (d: string) => {
    if (ws.readyState === 1) ws.send(d);
  });
  child.on("exit", () => ws.close());
  return {
    kill: () => child.kill(),
    write: (s: string) => child.stdin?.write(s),
  };
}

export function attachTerminalWebSocket(
  wss: import("ws").WebSocketServer
): void {
  wss.on("connection", async (ws: WebSocket, req: import("http").IncomingMessage) => {
    const url = req.url ?? "";
    const match = url.match(/[?&]workspaceId=([^&\s]+)/);
    const workspaceId = match?.[1]?.trim();
    if (!workspaceId) {
      ws.close(4000, "Missing workspaceId");
      return;
    }

    let proc: ProcHandle | null = null;
    try {
      const cwd = getWorkspacePath(workspaceId);
      await fs.mkdir(cwd, { recursive: true });
      console.log("[terminal-ws] Connecting workspace:", workspaceId, "cwd:", cwd);

      proc = spawnWithPty(ws, cwd);
      if (!proc) {
        console.warn("[terminal-ws] node-pty failed, using spawn fallback");
        proc = spawnWithChildProcess(ws, cwd);
      }

      const procRef = proc;

      ws.on("message", (raw: Buffer | string) => {
        const str = raw.toString();
        try {
          if (str.startsWith("{")) {
            const msg = JSON.parse(str) as { cols?: number; rows?: number };
            if (typeof msg.cols === "number" && typeof msg.rows === "number" && procRef.resize) {
              procRef.resize(msg.cols, msg.rows);
              return;
            }
          }
        } catch {
          /* not JSON */
        }
        procRef.write(str);
      });

      ws.on("close", () => procRef.kill());
      ws.on("error", () => procRef.kill());
    } catch (err) {
      console.error("[terminal-ws] Error:", err);
      ws.close(4500, "Failed to start terminal");
    }
  });
}
