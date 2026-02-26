/**
 * Quick test: connect to agent WebSocket, send "list files", collect response.
 * Reports whether the agent used CUSTOM tools (list_dir, run_terminal_cmd, read_file...)
 * or OPENCODE BUILT-INS (list, bash, read...).
 *
 * Run from backend: node test-agent.mjs
 * Requires: backend server running (npm run dev), valid WORKSPACE_ID.
 */
import WebSocket from "ws";

const WS_URL = "ws://127.0.0.1:3001/api/agent";
const WORKSPACE_ID = process.env.WORKSPACE_ID || "8f0f0871-60e0-4c2f-b6ab-ee998b4b3163";
const MESSAGE = process.env.MESSAGE || "List the files in the current directory. Reply in one short sentence.";

const CUSTOM_TOOL_NAMES = new Set([
  "codebase_search", "read_file", "run_terminal_cmd", "list_dir", "grep_search",
  "edit_file", "search_replace", "file_search", "delete_file", "reapply",
  "web_search", "create_diagram", "edit_notebook",
]);
const BUILTIN_TOOL_NAMES = new Set([
  "read", "write", "edit", "bash", "grep", "glob", "list", "patch",
  "webfetch", "todowrite", "todoread", "skill", "question", "websearch",
]);

const chunks = [];
const toolCallsSeen = [];
let resolveDone;

const done = new Promise((r) => { resolveDone = r; });

const ws = new WebSocket(WS_URL);

ws.on("open", () => {
  console.log("[test] Connected, sending run...");
  ws.send(JSON.stringify({ type: "run", workspaceId: WORKSPACE_ID, message: MESSAGE }));
});

ws.on("message", (raw) => {
  try {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "chunk") {
      chunks.push(msg.data ?? "");
      process.stdout.write(msg.data ?? "");
    } else if (msg.type === "tool_call") {
      const name = msg.tool || "(unknown)";
      const cmd = msg.command ? ` command="${msg.command.slice(0, 40)}..."` : "";
      toolCallsSeen.push({ name, command: msg.command });
      console.log("\n[test] tool_call:", name + cmd);
    } else if (msg.type === "end") {
      console.log("\n[test] End, code:", msg.code);
      ws.close();
      resolveDone();
    } else if (msg.type === "error") {
      console.error("\n[test] Error:", msg.error);
      ws.close();
      resolveDone();
    } else {
      console.log("\n[test] msg.type:", msg.type, Object.keys(msg).filter((k) => k !== "type").join(", "));
    }
  } catch (e) {
    console.error("[test] Parse error:", e.message);
  }
});

ws.on("error", (err) => {
  console.error("[test] WebSocket error:", err.message);
  resolveDone();
});

ws.on("close", () => {
  if (!chunks.length && toolCallsSeen.length === 0) resolveDone();
});

await done;

const full = chunks.join("");
console.log("\n--- Full response length:", full.length);
if (full.length < 2000) console.log("--- Full response:\n", full);

console.log("\n========== TOOL USAGE CHECK ==========");
if (toolCallsSeen.length === 0) {
  console.log("No tool_call events were received. (Agent may have replied without tools, or stream uses a different format.)");
} else {
  const names = [...new Set(toolCallsSeen.map((t) => t.name))];
  const custom = names.filter((n) => CUSTOM_TOOL_NAMES.has(n));
  const builtin = names.filter((n) => BUILTIN_TOOL_NAMES.has(n) && !CUSTOM_TOOL_NAMES.has(n));
  const other = names.filter((n) => !CUSTOM_TOOL_NAMES.has(n) && !BUILTIN_TOOL_NAMES.has(n));

  console.log("Tool names seen:", names.join(", ") || "(none)");
  if (custom.length) console.log("  -> Custom (from our config):", custom.join(", "));
  if (builtin.length) console.log("  -> OpenCode built-in:", builtin.join(", "));
  if (other.length) console.log("  -> Other:", other.join(", "));

  if (custom.length && !builtin.length) {
    console.log("\nResult: Agent is using our CUSTOM tools.");
  } else if (builtin.length) {
    console.log("\nResult: Agent is using OPENCODE BUILT-INS (custom config may not be applied).");
  } else {
    console.log("\nResult: Unclear (no known tool names matched).");
  }
}
console.log("======================================\n");

process.exit(0);
