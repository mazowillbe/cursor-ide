/**
 * OpenCode custom tool: codebase_search. Schema from tools.json. Calls backend execute-tool API.
 */
import { tool } from "@opencode-ai/plugin";
import { callBackend } from "./_backend.js";

export default tool({
  description: `Find snippets of code from the codebase most relevant to the search query.
This is a semantic search tool, so the query should ask for something semantically matching what is needed.
If it makes sense to only search in particular directories, please specify them in the target_directories field.
Unless there is a clear reason to use your own search query, please just reuse the user's exact query with their wording.
Their exact wording/phrasing can often be helpful for the semantic search query. Keeping the same exact question format can also be helpful.`,
  args: {
    query: tool.schema.string().describe("The search query to find relevant code. You should reuse the user's exact query/most recent message with their wording unless there is a clear reason not to."),
    target_directories: tool.schema.array(tool.schema.string()).optional().describe("Glob patterns for directories to search over"),
    explanation: tool.schema.string().optional().describe("One sentence explanation as to why this tool is being used, and how it contributes to the goal."),
  },
  async execute(args, context) {
    return callBackend("codebase_search", args, context);
  },
});
