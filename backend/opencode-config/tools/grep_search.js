/**
 * OpenCode custom tool: grep_search. Schema from tools.json. Calls backend execute-tool API.
 */
import { tool } from "@opencode-ai/plugin";
import { callBackend } from "./_backend.js";

const GREP_DESCRIPTION = `### Instructions:
This is best for finding exact text matches or regex patterns.
This is preferred over semantic search when we know the exact symbol/function name/etc. to search in some set of directories/file types.

Use this tool to run fast, exact regex searches over text files using the ripgrep engine.
To avoid overwhelming output, the results are capped at 50 matches.
Use the include or exclude patterns to filter the search scope by file type or specific paths.

- Always escape special regex characters: ( ) [ ] { } + * ? ^ $ | . \\
- Use backslash to escape any of these characters when they appear in your search string.
- Do NOT perform fuzzy or semantic matches.
- Return only a valid regex pattern string.`;

export default tool({
  description: GREP_DESCRIPTION,
  args: {
    query: tool.schema.string().describe("The regex pattern to search for"),
    include_pattern: tool.schema.string().optional().describe("Glob pattern for files to include (e.g. '*.ts' for TypeScript files)"),
    exclude_pattern: tool.schema.string().optional().describe("Glob pattern for files to exclude"),
    case_sensitive: tool.schema.boolean().optional().describe("Whether the search should be case sensitive"),
    explanation: tool.schema.string().optional().describe("One sentence explanation as to why this tool is being used, and how it contributes to the goal."),
  },
  async execute(args, context) {
    return callBackend("grep_search", args, context);
  },
});
