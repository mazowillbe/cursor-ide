/**
 * Apply-edit agent: the "less intelligent model" that quickly applies edit_file proposals.
 * Uses OpenCode (no Gemini) - runs opencode with a text-only prompt.
 * Reads the main agent's code_edit (with "// ... existing code ..." placeholders) and
 * outputs the complete file content with edits applied.
 */

import { runOpenCodeInWorkspace, type WorkspaceId } from "./opencode-run.js";

/**
 * Strip markdown code fences and diff-artifact lines so file content has no backticks or stray headers.
 */
export function stripCodeFences(raw: string): string {
  let s = raw.trim();
  const lines = s.split(/\r?\n/);
  let start = 0;
  let end = lines.length;

  while (start < end && /^\s*`{3}[\w-]*\s*$/.test(lines[start]!)) start += 1;
  while (start < end && /^\s*[-+]{3}\s*$/.test(lines[start]!)) start += 1;
  while (end > start && /^\s*`{3}\s*$/.test(lines[end - 1]!)) end -= 1;
  while (end > start && /^\s*[-+]{3}\s*$/.test(lines[end - 1]!)) end -= 1;

  s = lines.slice(start, end).join("\n");
  s = s.replace(/\s*`{3}\s*$/, "");
  return s.trim();
}

export interface ApplyEditInput {
  target_file: string;
  instructions: string;
  code_edit: string;
}

/** Config to disable tools so the model only outputs text (no file ops). */
const APPLY_EDIT_CONFIG = JSON.stringify({
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
 * Call OpenCode to turn (current content + instructions + code_edit sketch) into full file content.
 * For new files, currentContent may be empty.
 * Returns the complete new file content, or throws.
 */
export async function applyEditWithModel(
  workspaceId: WorkspaceId,
  currentContent: string,
  input: ApplyEditInput
): Promise<string> {
  const codeEdit = stripCodeFences(input.code_edit);
  const isNewFile = !currentContent || currentContent.trim().length === 0;

  const prompt = isNewFile
    ? `You are an apply model: you take an edit sketch and produce the final file content.

FILE (new file): ${input.target_file}

INSTRUCTION: ${input.instructions}

EDIT SKETCH (this describes the full content of the new file; use it as-is or fix trivial issues):
\`\`\`
${codeEdit}
\`\`\`

TASK: Output the COMPLETE file content for this new file. Use the edit sketch as the content. If the sketch uses "// ... existing code ..." ignore those (there is no existing code). Do not add explanations—only the file content.`
    : `You are an apply model: you take an edit sketch (with "// ... existing code ..." meaning "copy the existing file content here") and produce the complete file after applying the edit.

FILE: ${input.target_file}

INSTRUCTION: ${input.instructions}

EDIT SKETCH (use "// ... existing code ..." to mean: copy the corresponding section from the CURRENT FILE CONTENT below):
\`\`\`
${codeEdit}
\`\`\`

CURRENT FILE CONTENT:
\`\`\`
${currentContent}
\`\`\`

TASK: Output the COMPLETE new file content. Replace each "// ... existing code ..." (and its language-specific variants like "# ... existing code ..." or "/* ... existing code ... */") with the actual corresponding lines from the current file. Apply all edits in sequence. Preserve formatting and style. Do not add explanations—only the file content.`;

  const model = process.env.OPENCODE_APPLY_MODEL;
  const text = await runOpenCodeInWorkspace(workspaceId, prompt, {
    configContent: APPLY_EDIT_CONFIG,
    model: model || undefined,
  });

  const result = stripCodeFences(text || "");
  if (!result) throw new Error("Apply model returned empty content.");

  const basename = input.target_file.replace(/^.*[/\\]/, "").toLowerCase();
  if (basename === "package.json") {
    try {
      const parsed = JSON.parse(result) as unknown;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return result;
    }
  }

  return result;
}
