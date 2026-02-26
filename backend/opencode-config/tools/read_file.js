/**
 * OpenCode custom tool: read_file. Schema from tools.json. Calls backend execute-tool API.
 */
import { tool } from "@opencode-ai/plugin";
import { callBackend } from "./_backend.js";

export default tool({
  description: `Read the contents of a file. the output of this tool call will be the 1-indexed file contents from start_line_one_indexed to end_line_one_indexed_inclusive, together with a summary of the lines outside start_line_one_indexed and end_line_one_indexed_inclusive.
Note that this call can view at most 250 lines at a time and 200 lines minimum.

When using this tool to gather information, it's your responsibility to ensure you have the COMPLETE context. Specifically, each time you call this command you should:
1) Assess if the contents you viewed are sufficient to proceed with your task.
2) Take note of where there are lines not shown.
3) If the file contents you have viewed are insufficient, and you suspect they may be in lines not shown, proactively call the tool again to view those lines.
4) When in doubt, call this tool again to gather more information. Remember that partial file views may miss critical dependencies, imports, or functionality.

In some cases, if reading a range of lines is not enough, you may choose to read the entire file.
Reading entire files is often wasteful and slow, especially for large files (i.e. more than a few hundred lines). So you should use this option sparingly.
Reading the entire file is not allowed in most cases. You are only allowed to read the entire file if it has been edited or manually attached to the conversation by the user.`,
  args: {
    target_file: tool.schema.string().describe("The path of the file to read. Must include the full filename with extension (e.g. src/App.tsx, not App or src/App). You can use either a relative path in the workspace or an absolute path."),
    should_read_entire_file: tool.schema.boolean().describe("Whether to read the entire file. Defaults to false."),
    start_line_one_indexed: tool.schema.number().describe("The one-indexed line number to start reading from (inclusive)."),
    end_line_one_indexed_inclusive: tool.schema.number().describe("The one-indexed line number to end reading at (inclusive)."),
    explanation: tool.schema.string().optional().describe("One sentence explanation as to why this tool is being used, and how it contributes to the goal."),
  },
  async execute(args, context) {
    return callBackend("read_file", args, context);
  },
});
