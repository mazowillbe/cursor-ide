/**
 * Test the agent by asking it to create a React Vite todo app.
 * Creates a fresh workspace, sends the message, and streams output.
 *
 * Prerequisites:
 * - Backend running: cd backend && npm run dev (in another terminal)
 * - OpenCode CLI installed: npm install -g opencode-ai (or set OPENCODE_PATH)
 * - Optional: GEMINI_API_KEY for edit_file apply model and reapply
 *
 * Run from backend: node test-todo-app.mjs
 */
import WebSocket from "ws";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const WS_URL = "ws://127.0.0.1:3001/api/agent";
const WORKSPACE_ROOT = path.resolve(process.cwd(), process.env.WORKSPACE_ROOT || "workspaces");
const MESSAGE = process.env.MESSAGE || "Create a React Vite todo app. Use npm create vite@latest to scaffold, then add a simple todo list (add, toggle complete, delete). Reply briefly when done.";

function ensureWorkspaceDir(workspaceId) {
  const dir = path.join(WORKSPACE_ROOT, workspaceId);
  if (!fs.existsSync(WORKSPACE_ROOT)) fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const workspaceId = randomUUID();
ensureWorkspaceDir(workspaceId);
console.log("[test-todo] Workspace:", workspaceId, "Dir:", path.join(WORKSPACE_ROOT, workspaceId));
console.log("[test-todo] Message:", MESSAGE.slice(0, 80) + "...");
console.log("[test-todo] Connecting to", WS_URL, "\n");

const chunks = [];
const toolCallsSeen = [];
let resolveDone;
const done = new Promise((r) => { resolveDone = r; });

const ws = new WebSocket(WS_URL);

ws.on("open", () => {
  ws.send(JSON.stringify({
    type: "run",
    workspaceId,
    message: MESSAGE,
  }));
});

ws.on("message", (raw) => {
  try {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "chunk") {
      chunks.push(msg.data ?? "");
      process.stdout.write(msg.data ?? "");
    } else if (msg.type === "tool_call") {
      const name = msg.tool || "(unknown)";
      const cmd = msg.command ? ` command="${String(msg.command).slice(0, 50)}..."` : "";
      const pathInfo = msg.path ? ` path=${msg.path}` : "";
      toolCallsSeen.push({ name, command: msg.command, path: msg.path });
      console.log("\n[tool_call]", name + cmd + pathInfo);
    } else if (msg.type === "tool_output_stream") {
      process.stdout.write(msg.chunk ?? "");
    } else if (msg.type === "tool_output_end") {
      console.log("\n[output_end] exitCode:", msg.exitCode);
    } else if (msg.type === "end") {
      console.log("\n[end] code:", msg.code);
      ws.close();
      resolveDone();
    } else if (msg.type === "error") {
      console.error("\n[error]", msg.error);
      ws.close();
      resolveDone();
    }
  } catch (e) {
    console.error("[test-todo] Parse error:", e.message);
  }
});

ws.on("error", (err) => {
  console.error("[test-todo] WebSocket error:", err.message);
  console.error("[test-todo] Is the backend running on 127.0.0.1:3001?");
  resolveDone();
});

ws.on("close", () => {
  resolveDone();
});

// Timeout after 5 minutes
setTimeout(() => {
  if (!ws.CLOSED && ws.readyState !== WebSocket.CLOSED) {
    console.log("\n[test-todo] Timeout 5m, closing.");
    ws.close();
  }
  resolveDone();
}, 5 * 60 * 1000);

await done;

console.log("\n\n========== SUMMARY ==========");
console.log("Workspace:", workspaceId);
console.log("Workspace path:", path.join(WORKSPACE_ROOT, workspaceId));
console.log("Tool calls:", toolCallsSeen.length);
toolCallsSeen.forEach((t, i) => console.log(`  ${i + 1}. ${t.name}${t.command ? " " + String(t.command).slice(0, 60) : ""}${t.path ? " " + t.path : ""}`));
console.log("Response length:", chunks.join("").length);
if (toolCallsSeen.length === 0 && chunks.join("").length === 0) {
  console.log("\nNo output or tool calls. Check: 1) OpenCode installed (npm i -g opencode-ai), 2) GEMINI_API_KEY set for apply/reapply.");
}
console.log("================================\n");

process.exit(0);
