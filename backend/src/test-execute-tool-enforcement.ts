/**
 * Unit test: execute-tool rejects non-thinking tools until thinking_tool is called.
 * Run from backend: npx tsx src/test-execute-tool-enforcement.ts
 * Spawns backend with ALLOW_TEST_ROUTES=1, runs tests, then exits.
 */
import "dotenv/config";
import { spawn } from "child_process";
import { createWorkspaceWithId } from "./workspace.js";

async function main() {
  const workspaceId = crypto.randomUUID();
  console.log("[test] Creating workspace:", workspaceId);
  await createWorkspaceWithId(workspaceId);

  console.log("[test] Starting backend with ALLOW_TEST_ROUTES=1 (port 3099)...");
  const testPort = 3099;
  const child = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ALLOW_TEST_ROUTES: "1", PORT: String(testPort) },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  child.stderr?.on("data", (d) => process.stderr.write(d));
  child.stdout?.on("data", (d) => process.stdout.write(d));
  const base = `http://127.0.0.1:${testPort}`;
  const postLocal = async (path: string, body: Record<string, unknown>) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  };
  try {
    const start = Date.now();
    let ready = false;
    while (Date.now() - start < 15000) {
      try {
        const r = await fetch(`${base}/api/projects`);
        if (r.ok || r.status === 401) {
          ready = true;
          break;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (!ready) {
      child.kill("SIGTERM");
      throw new Error("Backend did not become ready on port 3099");
    }
    await postLocal("/api/test/reset-thinking", { workspaceId });

    // 1. Call run_terminal_cmd BEFORE thinking_tool -> must be rejected
  const r1 = await postLocal("/api/agent/execute-tool", {
    workspaceId,
    tool: "run_terminal_cmd",
    arguments: { command: "echo test" },
  });
  if (r1.status !== 400) {
    console.error("FAIL: Expected 400 when calling run_terminal_cmd before thinking_tool, got:", r1.status, r1.body);
    process.exit(1);
  }
  const errMsg = (r1.body as { error?: string })?.error ?? "";
  if (!errMsg.toLowerCase().includes("thinking_tool")) {
    console.error("FAIL: Error message should mention thinking_tool:", errMsg);
    process.exit(1);
  }
  console.log("PASS: run_terminal_cmd rejected before thinking_tool");

  // 2. Call thinking_tool -> must be accepted (may succeed or fail for other reasons)
  const r2 = await postLocal("/api/agent/execute-tool", {
    workspaceId,
    tool: "thinking_tool",
    arguments: { thought: "Planning the approach for the task." },
  });
  if (r2.status !== 200) {
    console.error("FAIL: thinking_tool should return 200, got:", r2.status, r2.body);
    process.exit(1);
  }
  console.log("PASS: thinking_tool accepted");

    // 3. Call run_terminal_cmd AFTER thinking_tool -> must be accepted (not rejected by our check)
  const r3 = await postLocal("/api/agent/execute-tool", {
    workspaceId,
    tool: "run_terminal_cmd",
    arguments: { command: "echo ok" },
  });
  if (r3.status !== 200) {
    const err = (r3.body as { error?: string })?.error;
    if (err?.toLowerCase().includes("thinking_tool")) {
      console.error("FAIL: run_terminal_cmd after thinking_tool should NOT be rejected:", err);
      process.exit(1);
    }
    console.log("Note: run_terminal_cmd returned", r3.status, "- may be tool failure, but not thinking_tool rejection");
  } else {
    console.log("PASS: run_terminal_cmd accepted after thinking_tool");
  }

    console.log("\n=== All enforcement tests PASSED ===");
  } finally {
    child.kill("SIGTERM");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
