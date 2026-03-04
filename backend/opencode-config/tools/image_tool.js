/**
 * OpenCode custom tool: image_tool.
 * Uses the backend's image_tool handler to search the Openverse API for images.
 */
import { tool } from "@opencode-ai/plugin";
import { callBackend } from "./_backend.js";

export default tool({
  description:
    "Search the Openverse image API for photos or illustrations to use in the generated app. " +
    "Call this whenever you need a real image URL (e.g. hero background, icon, illustration). " +
    "The backend will return a list of candidate images and a 'best' image to use.",
  args: {
    query: tool.schema
      .string()
      .describe("Short description of the desired image (e.g. 'minimalist blue finance dashboard illustration')."),
    per_page: tool.schema
      .number()
      .int()
      .min(1)
      .max(12)
      .optional()
      .describe("How many images to fetch (default 6, max 12)."),
    color: tool.schema
      .string()
      .optional()
      .describe("Optional color hint (e.g. 'blue', 'black', 'white')."),
    license: tool.schema
      .string()
      .optional()
      .describe("Optional Openverse license_type filter (e.g. 'commercial', 'noncommercial')."),
    orientation: tool.schema
      .string()
      .optional()
      .describe("Optional aspect ratio/orientation hint, e.g. 'tall', 'wide', or 'square'."),
  },
  async execute(args, context) {
    return callBackend("image_tool", args, context);
  },
});

