/**
 * OpenCode custom tool: delete_file. Schema from tools.json. Calls backend execute-tool API.
 */
import { tool } from "@opencode-ai/plugin";
import { callBackend } from "./_backend.js";

export default tool({
  description: "Deletes a file at the specified path. The operation will fail gracefully if:\n    - The file doesn't exist\n    - The operation is rejected for security reasons\n    - The file cannot be deleted",
  args: {
    target_file: tool.schema.string().describe("The path of the file to delete, relative to the workspace root."),
    explanation: tool.schema.string().optional().describe("One sentence explanation as to why this tool is being used, and how it contributes to the goal."),
  },
  async execute(args, context) {
    return callBackend("delete_file", args, context);
  },
});
