/**
 * One-off test: create a workspace, send "build me an app" to the agent, print reply.
 * Run from backend: npx tsx src/test-agent.ts
 */
import { createWorkspace } from "./workspace.js";
import { runOpenCode, abortProcess } from "./agent.js";

const TEST_MESSAGE = "build me an app";
const RUN_TIMEOUT_MS = 90_000;

async function main() {
  console.log("[test-agent] Creating workspace...");
  const workspaceId = await createWorkspace();
  console.log("[test-agent] Workspace ID:", workspaceId);
  console.log("[test-agent] Sending to agent:", JSON.stringify(TEST_MESSAGE));
  console.log("[test-agent] Waiting up to", RUN_TIMEOUT_MS / 1000, "seconds for reply...\n");

  const chunks: string[] = [];
  const proc = await runOpenCode(workspaceId, TEST_MESSAGE, {
    onData(chunk) {
      const s = typeof chunk === "string" ? chunk : String(chunk);
      chunks.push(s);
      process.stdout.write(s);
    },
    onEnd(code) {
      console.log("\n[test-agent] Process ended, code:", code);
    },
    onError(err) {
      console.error("\n[test-agent] Error:", err.message);
    },
  });

  const timeout = setTimeout(() => {
    console.log("\n[test-agent] Timeout reached, stopping agent.");
    abortProcess(proc);
  }, RUN_TIMEOUT_MS);

  const exitPromise = new Promise<void>((resolve) => {
    const check = () => {
      if (chunks.length > 0 || process.env.TEST_AGENT_QUICK === "1") {
        clearTimeout(timeout);
        resolve();
      } else {
        setTimeout(check, 2000);
      }
    };
    setTimeout(check, 5000);
  });

  await Promise.race([
    exitPromise,
    new Promise((r) => setTimeout(r, RUN_TIMEOUT_MS + 2000)),
  ]);
  clearTimeout(timeout);
  abortProcess(proc);

  const fullReply = chunks.join("");
  console.log("\n--- Full reply (first 3000 chars) ---");
  console.log(fullReply.slice(0, 3000));
  if (fullReply.length > 3000) console.log("\n...(truncated)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
