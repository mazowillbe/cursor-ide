/**
 * OpenCode custom tool: read_lints. Runs the project linter (e.g. npm run lint) and returns a summary.
 * Calls backend execute-tool API.
 */
import { tool } from "@opencode-ai/plugin";
import { callBackend } from "./_backend.js";

export default tool({
  description: `Run the project's linter (e.g. npm run lint) and get a summary. Use this after making significant code changes. The output will say either "No linting errors found." or "N linting errors found." plus details. If there are errors, fix them before finishing your turn.`,
  args: {},
  async execute(args, context) {
    return callBackend("read_lints", args || {}, context);
  },
});
