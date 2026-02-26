/**
 * OpenCode custom tool: reapply. Schema from tools.json. Calls backend execute-tool API.
 */
import { tool } from "@opencode-ai/plugin";
import { callBackend } from "./_backend.js";

export default tool({
  description: "Calls a smarter model to apply the last edit to the specified file.\nUse this tool immediately after the result of an edit_file tool call ONLY IF the diff is not what you expected, indicating the model applying the changes was not smart enough to follow your instructions.",
  args: {
    target_file: tool.schema.string().describe("The relative path to the file to reapply the last edit to. You can use either a relative path in the workspace or an absolute path. If an absolute path is provided, it will be preserved as is."),
  },
  async execute(args, context) {
    return callBackend("reapply", args, context);
  },
});
