import path from "path";
import fs from "fs/promises";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import type { Plugin } from "@opencode-ai/plugin";
import { GoogleGenAI } from "@google/genai";

const GEMINI_MODEL = "gemini-2.0-flash";

async function applyEditWithGemini(
  currentContent: string,
  codeEdit: string,
  instructions: string,
  targetFile: string
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set. Set it to use the AI-powered edit_file tool.");
  }

  const ai = new GoogleGenAI({ apiKey });
  const prompt = `You are an expert at applying code edits. Apply the following edit to the file.

TARGET FILE: ${targetFile}

INSTRUCTION: ${instructions}

CURRENT FILE CONTENT:
\`\`\`
${currentContent}
\`\`\`

EDIT TO APPLY (use "// ... existing code ..." as placeholder for unchanged sections):
\`\`\`
${codeEdit}
\`\`\`

Return ONLY the complete new file content. No explanations, no markdown fences, no preamble. Just the exact file content that should be written.`;

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
  });

  const text = response.text?.trim() ?? "";
  if (!text) {
    throw new Error("Gemini did not return valid content");
  }

  return text;
}

export const ApplyWithGemini: Plugin = async () => {
  const { tool } = await import("@opencode-ai/plugin");

  return {
    tool: {
      edit_file: tool({
        description:
          "Propose an edit to a file. Use // ... existing code ... for unchanged sections. An AI (Gemini 2.0 Flash) applies the edit.",
        args: {
          target_file: tool.schema.string().describe("Path to the file"),
          instructions: tool.schema.string().describe("Single sentence for the apply model"),
          code_edit: tool.schema.string().describe("The edit. Use // ... existing code ... for unchanged parts."),
        },
        async execute(args, context) {
          const fullPath = path.join(context.directory, args.target_file);
          let currentContent = "";
          try {
            currentContent = await fs.readFile(fullPath, "utf-8");
          } catch {
            currentContent = "";
          }

          const newContent = await applyEditWithGemini(
            currentContent,
            args.code_edit,
            args.instructions,
            args.target_file
          );

          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, newContent, "utf-8");

          const patch = createTwoFilesPatch(
            `a/${args.target_file}`,
            `b/${args.target_file}`,
            currentContent,
            newContent,
            "",
            "",
            { context: 3, headerOptions: FILE_HEADERS_ONLY }
          );
          return patch;
        },
      }),
    },
  };
};
