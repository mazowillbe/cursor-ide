/**
 * Reapply agent: uses a smarter model (Gemini) to re-apply the last edit_file
 * to the specified file when the initial apply was wrong or ambiguous.
 * Use immediately after edit_file if the diff was not what you expected.
 */

import { GoogleGenAI } from "@google/genai";
import { stripCodeFences } from "./apply-edit-agent.js";

const apiKey = process.env.GEMINI_API_KEY;

export interface LastEdit {
  target_file: string;
  instructions: string;
  code_edit: string;
}

/**
 * Call Gemini to produce the correct file content by re-applying the described edit.
 * Returns the full new file content, or throws.
 */
export async function reapplyEditWithModel(
  currentContent: string,
  lastEdit: LastEdit
): Promise<string> {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required for reapply. Set it in the environment.");
  }

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: `You are a precise code editor. The user attempted an edit that was applied incorrectly (e.g. by a simpler model). Your job is to apply the SAME intended edit correctly to the file.

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

TASK: Output the COMPLETE new file content after correctly applying the intended edit. Preserve formatting and style. Do not add explanations—only the file content.`,
    config: { maxOutputTokens: 16384, temperature: 0.1 },
  });

  const text = response.text?.trim() ?? "";
  if (!text) throw new Error("Reapply model returned empty content.");
  return stripCodeFences(text);
}
