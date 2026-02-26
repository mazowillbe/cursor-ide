import { Router, type Request, type Response } from "express";
import { GoogleGenAI } from "@google/genai";

const router = Router();
const apiKey = process.env.GEMINI_API_KEY;

const VISION_MODEL = "gemini-2.5-flash";
const DESCRIPTION_PROMPT = `You are describing this image for a coding assistant that will use your description to help the user. Be precise and complete.

If the image shows a code editor or IDE:
- State the file path, tab name, or filename if visible.
- State the programming language.
- Transcribe the actual code that is visible (or the key lines that matter). Preserve indentation and structure so the assistant can see the real code.
- Note any underlined, highlighted, or squiggled lines and what the UI says (e.g. error message, warning text).
- Mention line numbers if visible and relevant.
- If there are panels (problems, terminal, etc.), briefly say what they show (e.g. "Error on line 12: unexpected token").

If the image shows something else (screenshot, diagram, UI):
- Describe all visible text, labels, and content exactly.
- Note layout, errors, or anything that looks wrong or noteworthy.

Do not give a vague summary like "This image displays a code editor." Give enough detail that another AI could reproduce the code or diagnose the issue.`;

router.post("/describe-image", async (req: Request, res: Response): Promise<void> => {
  const { images } = req.body as { images?: Array<{ data?: string; mimeType?: string }> };
  try {
    if (!Array.isArray(images) || images.length === 0) {
      res.status(400).json({ error: "images array required and must not be empty" });
      return;
    }
    if (!apiKey) {
      res.status(503).json({ error: "Vision (Gemini) not configured. Set GEMINI_API_KEY." });
      return;
    }
    const ai = new GoogleGenAI({ apiKey });
    const descriptions: string[] = [];

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const data = img?.data && typeof img.data === "string" ? img.data : "";
      const mimeType = (img?.mimeType && typeof img.mimeType === "string" ? img.mimeType : "image/png") as string;
      if (!data) {
        descriptions.push("(No image data)");
        continue;
      }
      try {
        const response = await ai.models.generateContent({
          model: VISION_MODEL,
          contents: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType, data } },
                { text: DESCRIPTION_PROMPT },
              ],
            },
          ],
          config: { maxOutputTokens: 2048 },
        });
        const text = (response.text ?? "").trim();
        descriptions.push(text || "(Could not describe)");
      } catch (err) {
        console.error("[describe-image] Gemini error for image", i + 1, err);
        descriptions.push("(Description unavailable)");
      }
    }

    res.json({ descriptions });
  } catch (err) {
    console.error("[describe-image]", err);
    res.status(500).json({ error: "Failed to describe images" });
  }
});

export default router;
