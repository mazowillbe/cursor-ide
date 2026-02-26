/**
 * Test if OpenCode accepts our custom config format.
 * Generates .opencode.custom.json and runs: opencode run "List files" --format json
 * Run from backend: node test-agent-config.mjs
 */
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, "..");
const workspaceDir = path.join(backendDir, "workspaces", "test-config-workspace");

async function main() {
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "package.json"), JSON.stringify({ name: "test", private: true }, null, 2));

  const configPath = path.join(workspaceDir, ".opencode.custom.json");
  const config = {
    $schema: "https://opencode.ai/config.json",
    agent: {
      name: "custom-agent",
      description: "Test agent",
      disableBuiltinTools: true,
      systemPrompt: "You have only run_terminal_cmd and list_dir. Use them when needed.",
      tools: [
        { name: "run_terminal_cmd", description: "Run a shell command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
        { name: "list_dir", description: "List directory.", parameters: { type: "object", properties: { relative_workspace_path: { type: "string" } }, required: ["relative_workspace_path"] } },
      ],
    },
  };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  console.log("[test-config] Wrote", configPath);

  const env = { ...process.env, OPENCODE_CONFIG: configPath, OPENCODE_CLIENT: "cursor-web-test" };
  const child = spawn("opencode", ["run", "--format", "json", "-m", "opencode/minimax-m2.5-free", "List the files in the current directory. One sentence only."], {
    cwd: workspaceDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (d) => { stdout += d; process.stdout.write(d); });
  child.stderr?.setEncoding("utf8").on("data", (d) => { stderr += d; process.stderr.write(d); });

  const code = await new Promise((resolve) => child.on("close", resolve));
  console.log("\n[test-config] Exit code:", code);
  if (stderr) console.log("[test-config] stderr:", stderr.slice(0, 500));

  const toolMatches = [...stdout.matchAll(/"tool"\s*:\s*"([^"]+)"/g)];
  const toolNames = [...new Set(toolMatches.map((m) => m[1]))];
  console.log("[test-config] Tool names in stream:", toolNames.length ? toolNames.join(", ") : "(none found)");
  if (toolNames.some((t) => t === "list_dir" || t === "run_terminal_cmd")) {
    console.log("[test-config] Result: Custom tools appear to be used.");
  } else if (toolNames.some((t) => t === "list" || t === "bash")) {
    console.log("[test-config] Result: OpenCode built-ins used (config may be ignored).");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
