/**
 * Reapply agent: uses OpenCode to re-apply the last edit_file when the initial apply was wrong.
 * Use immediately after edit_file if the diff was not what you expected.
 */

import { runOpenCodeInWorkspace, type WorkspaceId } from "./opencode-run.js";
import { stripCodeFences } from "./apply-edit-agent.js";

export interface LastEdit {
  target_file: string;
  instructions: string;
  code_edit: string;
}

const REAPPLY_CONFIG = JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  tools: {
    write: false,
    edit: false,
    bash: false,
    read: false,
    grep: false,
    glob: false,
    list: false,
    patch: false,
    webfetch: false,
    websearch: false,
    task: false,
  },
});

/**
 * Call OpenCode to produce the correct file content by re-applying the described edit.
 * Returns the full new file content, or throws.
 */
export async function reapplyEditWithModel(
  workspaceId: WorkspaceId,
  currentContent: string,
  lastEdit: LastEdit
): Promise<string> {
  const prompt = `You are a precise code editor. The user attempted an edit that was applied incorrectly (e.g. by a simpler model). Your job is to apply the SAME intended edit correctly to the file.

FILE: ${lastEdit.target_file}

INSTRUCTIONS FROM THE ORIGINAL EDIT:
${lastEdit.instructions}

ORIGINAL EDIT SPEC (with "// ... existing code ..." meaning unchanged code):
\`\`\`
${lastEdit.code_edit}
\`\`\`

CURRENT FILE CONTENT (exactly as it is now):
\`\`\`
${currentContent}
\`\`\`

TASK: Output the COMPLETE new file content after correctly applying the intended edit. Preserve formatting and style. Do not add explanations—only the file content.`;

  const model = process.env.OPENCODE_REAPPLY_MODEL;
  const text = await runOpenCodeInWorkspace(workspaceId, prompt, {
    configContent: REAPPLY_CONFIG,
    model: model || undefined,
  });

  if (!text) throw new Error("Reapply model returned empty content.");
  return stripCodeFences(text);
}
