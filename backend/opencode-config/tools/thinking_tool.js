/**
 * OpenCode custom tool: thinking_tool. Same role as Cursor IDE's Thinking block — show reasoning first, then answer/act.
 */
import { tool } from "@opencode-ai/plugin";
import { callBackend } from "./_backend.js";

export default tool({
  description: "MANDATORY: Call this FIRST at the start of every turn, and before every other action (read_file, edit_file, run_terminal_cmd, etc.) and before your final reply. Your first tool call must always be thinking_tool. Pattern: thinking_tool → act → thinking_tool → act → thinking_tool → reply. Write 1–3 sentences of real reasoning in the thought: what you understand, what you're deciding, what you're about to do next. The user sees this in the Thinking section.",
  args: {
    thought: tool.schema.string().describe("1–3 sentences of real reasoning: what you understand or are deciding right now, why, and what you are about to do next."),
  },
  async execute(args, context) {
    return callBackend("thinking_tool", args, context);
  },
});
