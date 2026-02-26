/**
 * OpenCode custom tool: list_dir. Schema from tools.json. Calls backend execute-tool API.
 */
import { tool } from "@opencode-ai/plugin";
import { callBackend } from "./_backend.js";

export default tool({
  description: "List the contents of a directory. The quick tool to use for discovery, before using more targeted tools like semantic search or file reading. Useful to try to understand the file structure before diving deeper into specific files. Can be used to explore the codebase.",
  args: {
    relative_workspace_path: tool.schema.string().describe("Path to list contents of, relative to the workspace root."),
    explanation: tool.schema.string().optional().describe("One sentence explanation as to why this tool is being used, and how it contributes to the goal."),
  },
  async execute(args, context) {
    return callBackend("list_dir", args, context);
  },
});
