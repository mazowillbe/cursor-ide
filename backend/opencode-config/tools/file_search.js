/**
 * OpenCode custom tool: file_search. Schema from tools.json. Calls backend execute-tool API.
 */
import { tool } from "@opencode-ai/plugin";
import { callBackend } from "./_backend.js";

export default tool({
  description: "Fast file search based on fuzzy matching against file path. Use if you know part of the file path but don't know where it's located exactly. Response will be capped to 10 results. Make your query more specific if need to filter results further.",
  args: {
    query: tool.schema.string().describe("Fuzzy filename to search for"),
    explanation: tool.schema.string().describe("One sentence explanation as to why this tool is being used, and how it contributes to the goal."),
  },
  async execute(args, context) {
    return callBackend("file_search", args, context);
  },
});
