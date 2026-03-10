/**
 * OpenCode custom tool: run_terminal_cmd. Schema from tools.json. Calls backend execute-tool API.
 */
import { tool } from "@opencode-ai/plugin";
import { callBackend } from "./_backend.js";

export default tool({
  description: `PROPOSE a command to run on behalf of the user.
If you have this tool, note that you DO have the ability to run commands directly on the USER's system.
Note that the user will have to approve the command before it is executed.
The user may reject it if it is not to their liking, or may modify the command before approving it.  If they do change it, take those changes into account.
The actual command will NOT execute until the user approves it. The user may not approve it immediately. Do NOT assume the command has started running.
If the step is WAITING for user approval, it has NOT started running.
In using these tools, adhere to the following guidelines:
1. Based on the contents of the conversation, you will be told if you are in the same shell as a previous step or a different shell.
2. If in a new shell, you should \`cd\` to the appropriate directory and do necessary setup in addition to running the command.
3. If in the same shell, LOOK IN CHAT HISTORY for your current working directory.
4. For ANY commands that would require user interaction, ASSUME THE USER IS NOT AVAILABLE TO INTERACT and PASS THE NON-INTERACTIVE FLAGS (e.g. --yes for npx).
5. If the command would use a pager, append \` | cat\` to the command.
6. For commands that are long running/expected to run indefinitely until interruption, please run them in the background. To run jobs in the background, set \`is_background\` to true rather than changing the details of the command.
7. Dont include any newlines in the command.
8. CRITICAL: Commands run from the PROJECT ROOT (the directory containing package.json), not the workspace root. If list_dir shows a subfolder like \`todo-app\` with the app, that subfolder IS the project root. Use \`npm run dev\` directly—do NOT use \`npm run dev --prefix todo-app\` or similar, or the command will fail (npm would look for a nested path that does not exist). Only use \`--prefix\` in a true monorepo when the project root contains multiple packages.
9. SUPABASE CLI: You have access to the Supabase CLI for full-stack apps. Use \`npx supabase\` (e.g. \`npx supabase init\`, \`npx supabase link --project-ref $SUPABASE_PROJECT_REF\`, \`npx supabase db push\`, \`npx supabase migration new <name>\`, \`npx supabase functions new <name>\`, \`npx supabase gen types typescript\`). For auth, migrations, edge functions, and database schema—use the CLI. After \`supabase init\`, create migrations in \`supabase/migrations/\`, add edge functions in \`supabase/functions/\`, and run \`supabase db push\` to apply. Use \`supabase link\` with the project ref when connecting to a cloud project.`,
  args: {
    command: tool.schema.string().describe("The terminal command to execute"),
    is_background: tool.schema.boolean().describe("Whether the command should be run in the background"),
    explanation: tool.schema.string().optional().describe("One sentence explanation as to why this command needs to be run and how it contributes to the goal."),
  },
  async execute(args, context) {
    return callBackend("run_terminal_cmd", args, context);
  },
});
