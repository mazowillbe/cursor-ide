import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT_PATH = path.resolve(__dirname, "..", "opencode-config", "system-prompt.txt");

/** Names of custom OpenCode tools available to the agent.
 * These correspond to the stubs under backend/opencode-config/tools/*.js
 * and are used by the websocket to distinguish custom tools from built-ins.
 */
export function getCustomToolNamesSync(): string[] {
  return [
    "read_file",
    "list_dir",
    "edit_file",
    "search_replace",
    "run_terminal_cmd",
    "file_search",
    "grep_search",
    "web_search",
    "codebase_search",
    "create_diagram",
    "delete_file",
    "read_lints",
    "reapply",
    "edit_notebook",
    "todowrite",
    "todoread",
    "thinking_tool",
  ];
}

/**
 * Build OpenCode config with system prompt inlined from backend/opencode-config/system-prompt.txt.
 * We read and inline the content because {file:...} references resolve relative to the agent's
 * cwd (workspace), not OPENCODE_CONFIG_DIR, causing "file does not exist" errors.
 * We do NOT pass tools.json - our
 * instructions referenced Cursor-style tools (read_file, list_dir, etc.) that don't
 * exist in OpenCode, causing "Invalid Tool" errors. OpenCode has: read, grep, glob,
 * bash, edit, write, webfetch (no "list" tool - use glob or bash ls).
 * @param workingDir - Current working directory for the agent (project path); injected into <env> so the AI knows where it is.
 * @param projectName - Optional project name (from DB) to include in the cwd section.
 */
export async function getHardcodedAgentConfig(workingDir: string, projectName?: string): Promise<string | null> {
  let systemPrompt: string;
  try {
    systemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8");
  } catch (err) {
    console.warn("[agent-config] Failed to read system-prompt.txt:", (err as Error)?.message);
    return null;
  }
  const opencodeConfig = {
    $schema: "https://opencode.ai/config.json",
    instructions: [systemPrompt],
    permission: {
      edit: "deny",
      bash: "deny",
      read: "deny",
      write: "deny",
      grep: "deny",
      glob: "deny",
      list: "deny",
      patch: "deny",
      webfetch: "deny",
    },
    // Disable built-ins so the model uses our custom tools (read_file, list_dir, etc.) from OPENCODE_CONFIG_DIR.
    // Custom tools are loaded from opencode-config/tools/ and are available by default.
    tools: {
      read: false,
      write: false,
      edit: false,
      bash: false,
      list: false,
      grep: false,
      glob: false,
      patch: false,
      webfetch: false,
    },
  };
  return JSON.stringify(opencodeConfig);
}
