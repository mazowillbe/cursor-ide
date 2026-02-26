/**
 * OpenCode custom tool: edit_notebook. Schema from tools.json. Calls backend execute-tool API.
 */
import { tool } from "@opencode-ai/plugin";
import { callBackend } from "./_backend.js";

const EDIT_NOTEBOOK_DESCRIPTION = `Use this tool to edit a jupyter notebook cell. Use ONLY this tool to edit notebooks.

This tool supports editing existing cells and creating new cells:
- If you need to edit an existing cell, set 'is_new_cell' to false and provide the 'old_string' and 'new_string'.
  -- The tool will replace ONE occurrence of 'old_string' with 'new_string' in the specified cell.
- If you need to create a new cell, set 'is_new_cell' to true and provide the 'new_string' (and keep 'old_string' empty).
- It's critical that you set the 'is_new_cell' flag correctly!
- This tool does NOT support cell deletion, but you can delete the content of a cell by passing an empty string as the 'new_string'.

Other requirements:
- Cell indices are 0-based.
- 'old_string' and 'new_string' should be a valid cell content, i.e. WITHOUT any JSON syntax that notebook files use under the hood.
- The old_string MUST uniquely identify the specific instance you want to change. This means:
  -- Include AT LEAST 3-5 lines of context BEFORE the change point
  -- Include AT LEAST 3-5 lines of context AFTER the change point
- This tool can only change ONE instance at a time. If you need to change multiple instances:
  -- Make separate calls to this tool for each instance
  -- Each call must uniquely identify its specific instance using extensive context
- This tool might save markdown cells as "raw" cells. Don't try to change it, it's fine. We need it to properly display the diff.
- If you need to create a new notebook, just set 'is_new_cell' to true and cell_idx to 0.
- ALWAYS generate arguments in the following order: target_notebook, cell_idx, is_new_cell, cell_language, old_string, new_string.
- Prefer editing existing cells over creating new ones!`;

export default tool({
  description: EDIT_NOTEBOOK_DESCRIPTION,
  args: {
    target_notebook: tool.schema.string().describe("The path to the notebook file you want to edit. You can use either a relative path in the workspace or an absolute path. If an absolute path is provided, it will be preserved as is."),
    cell_idx: tool.schema.number().describe("The index of the cell to edit (0-based)"),
    is_new_cell: tool.schema.boolean().describe("If true, a new cell will be created at the specified cell index. If false, the cell at the specified cell index will be edited."),
    cell_language: tool.schema.string().describe("The language of the cell to edit. Should be STRICTLY one of these: 'python', 'markdown', 'javascript', 'typescript', 'r', 'sql', 'shell', 'raw' or 'other'."),
    old_string: tool.schema.string().describe("The text to replace (must be unique within the cell, and must match the cell contents exactly, including all whitespace and indentation)."),
    new_string: tool.schema.string().describe("The edited text to replace the old_string or the content for the new cell."),
  },
  async execute(args, context) {
    return callBackend("edit_notebook", args, context);
  },
});
