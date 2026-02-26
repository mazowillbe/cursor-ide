/**
 * OpenCode custom tool: create_diagram. Schema from tools.json. Calls backend execute-tool API.
 */
import { tool } from "@opencode-ai/plugin";
import { callBackend } from "./_backend.js";

export default tool({
  description: "Creates a Mermaid diagram that will be rendered in the chat UI. Provide the raw Mermaid DSL string via content.\nUse <br/> for line breaks, always wrap diagram texts/tags in double quotes, do not use custom colors, do not use :::, and do not use beta features.\nThe diagram will be pre-rendered to validate syntax - if there are any Mermaid syntax errors, they will be returned in the response so you can fix them.",
  args: {
    content: tool.schema.string().describe("Raw Mermaid diagram definition (e.g., 'graph TD; A-->B;')."),
  },
  async execute(args, context) {
    return callBackend("create_diagram", args, context);
  },
});
