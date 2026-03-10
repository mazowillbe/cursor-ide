/**
 * Test: (a) AI uses thinking_tool first, (b) AI uses Supabase for backend.
 * Run from backend: npx tsx src/test-thinking-supabase.ts
 */
import "dotenv/config";
import { createWorkspaceWithId } from "./workspace.js";
import { runOpenCode, abortProcess } from "./agent.js";

const TEST_MESSAGE = "Create a simple todo app with a backend and database. Use Supabase.";
const RUN_TIMEOUT_MS = 120_000;

interface ToolUse {
  tool: string;
  order: number;
  input?: { command?: string; thought?: string };
}

async function main() {
  const workspaceId = crypto.randomUUID();
  console.log("[test] Creating workspace:", workspaceId);
  await createWorkspaceWithId(workspaceId);

  const toolUses: ToolUse[] = [];
  let order = 0;

  const proc = await runOpenCode(workspaceId, TEST_MESSAGE, {
    onData(chunk) {
      const s = typeof chunk === "string" ? chunk : String(chunk);
      for (const line of s.split(/\r?\n/)) {
        try {
          const obj = JSON.parse(line) as { type?: string; part?: { type?: string; tool?: string; input?: unknown } };
          if (obj.type === "tool_use" && obj.part?.tool) {
            toolUses.push({
              tool: obj.part.tool,
              order: order++,
              input: obj.part.input as { command?: string; thought?: string } | undefined,
            });
            console.log("[test] Tool:", obj.part.tool, obj.part.input ? "(has input)" : "");
          }
        } catch {
          /* skip non-JSON lines */
        }
      }
    },
    onEnd(code) {
      console.log("[test] Agent ended, code:", code);
    },
    onError(err) {
      console.error("[test] Error:", err.message);
    },
  });

  const timeout = setTimeout(() => {
    console.log("[test] Timeout, stopping...");
    abortProcess(proc);
  }, RUN_TIMEOUT_MS);

  await new Promise((r) => setTimeout(r, 90_000)); // Let it run 90s to get supabase init etc
  clearTimeout(timeout);
  abortProcess(proc);

  // Results
  console.log("\n=== RESULTS ===\n");
  console.log("Tool call order:", toolUses.map((t) => t.tool).join(" → "));
  console.log("Total tool calls:", toolUses.length);

  const firstTool = toolUses[0]?.tool;
  const usedThinkingTool = toolUses.some((t) => t.tool === "thinking_tool");
  const firstWasThinking = firstTool === "thinking_tool";
  const usedSupabase = toolUses.some(
    (t) =>
      t.tool === "run_terminal_cmd" &&
      (t.input?.command?.includes("supabase") ?? false)
  );

  console.log("\n(a) thinking_tool:");
  console.log("  - First tool was thinking_tool:", firstWasThinking ? "PASS" : "FAIL", firstTool || "(none)");
  console.log("  - Used thinking_tool at all:", usedThinkingTool ? "PASS" : "FAIL");

  console.log("\n(b) Supabase:");
  console.log("  - Ran supabase command:", usedSupabase ? "PASS" : "FAIL");
  if (!usedSupabase && toolUses.length > 0) {
    const commands = toolUses.filter((t) => t.tool === "run_terminal_cmd").map((t) => t.input?.command);
    console.log("  - Commands run:", commands.slice(0, 5));
  }

  const passed = firstWasThinking && usedSupabase;
  console.log("\nOverall:", passed ? "PASS" : "FAIL");
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
