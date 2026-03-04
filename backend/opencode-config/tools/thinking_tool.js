/**
 * OpenCode custom tool: thinking_tool. Same role as Cursor IDE's Thinking block — show reasoning first, then answer/act.
 */
import { tool } from "@opencode-ai/plugin";
import { callBackend } from "./_backend.js";

export default tool({
  description: "Call this before EVERY action — before read_file, edit_file, run_terminal_cmd, and before your final reply — exactly as Cursor IDE does. Pattern: thinking_tool → read_file → thinking_tool → edit_file → thinking_tool → reply. Never batch two actions without a thinking_tool between them. In the thought argument write 1–3 sentences of real reasoning: what you're deciding, why, and what you're about to do. The user sees this in the Thinking section.",
  args: {
    thought: tool.schema.string().describe("1–3 sentences of real reasoning: what you understand or are deciding right now, why, and what you are about to do next."),
  },
  async execute(args, context) {
    return callBackend("thinking_tool", args, context);
  },
});
