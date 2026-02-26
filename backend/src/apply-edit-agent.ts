/**
 * Apply-edit agent: the "less intelligent model" that quickly applies edit_file proposals.
 * Reads the main agent's code_edit (with "// ... existing code ..." placeholders) and
 * the instructions, then outputs the complete file content with edits applied.
 * See tools.json edit_file: "This will be read by a less intelligent model, which will quickly apply the edit."
 */

import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;

/**
 * Strip markdown code fences and diff-artifact lines so file content has no backticks or stray headers.
 * - Removes leading/trailing lines that are only ``` or ```lang (e.g. ```js, ```diff).
 * - Removes leading lines that are only --- or +++ (unified diff headers the AI sometimes leaves in).
 * - Trims trailing ``` from the last line if the closing fence was on the same line as content.
 */
export function stripCodeFences(raw: string): string {
  let s = raw.trim();
  const lines = s.split(/\r?\n/);
  let start = 0;
  let end = lines.length;

  // Strip leading code fence lines (``` or ```lang)
  while (start < end && /^\s*`{3}[\w-]*\s*$/.test(lines[start]!)) start += 1;
  // Strip leading diff-artifact lines (--- or +++ only)
  while (start < end && /^\s*[-+]{3}\s*$/.test(lines[start]!)) start += 1;
  // Strip trailing code fence lines
  while (end > start && /^\s*`{3}\s*$/.test(lines[end - 1]!)) end -= 1;
  // Strip trailing diff-artifact lines
  while (end > start && /^\s*[-+]{3}\s*$/.test(lines[end - 1]!)) end -= 1;

  s = lines.slice(start, end).join("\n");
  // Remove closing ``` from end of last line if the AI put it on the same line as content
  s = s.replace(/\s*`{3}\s*$/, "");
  return s.trim();
}

export interface ApplyEditInput {
  target_file: string;
  instructions: string;
  code_edit: string;
}

/**
 * Call the apply model to turn (current content + instructions + code_edit sketch) into full file content.
 * For new files, currentContent may be empty.
 * Returns the complete new file content, or throws.
 */
export async function applyEditWithModel(
  currentContent: string,
  input: ApplyEditInput
): Promise<string> {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required for edit_file apply model. Set it in the environment.");
  }

  const codeEdit = stripCodeFences(input.code_edit);
  const isNewFile = !currentContent || currentContent.trim().length === 0;

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: isNewFile
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

TASK: Output the COMPLETE new file content. Replace each "// ... existing code ..." (and its language-specific variants like "# ... existing code ..." or "/* ... existing code ... */") with the actual corresponding lines from the current file. Apply all edits in sequence. Preserve formatting and style. Do not add explanations—only the file content.`,
    config: { maxOutputTokens: 16384, temperature: 0.1 },
  });

  const text = response.text?.trim() ?? "";
  if (!text) throw new Error("Apply model returned empty content.");

  let result = stripCodeFences(text);

  const basename = input.target_file.replace(/^.*[/\\]/, "").toLowerCase();
  if (basename === "package.json") {
    try {
      const parsed = JSON.parse(result) as unknown;
      result = JSON.stringify(parsed, null, 2);
    } catch {
      // leave as-is if not valid JSON
    }
  }

  return result;
}
