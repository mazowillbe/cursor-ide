import { Router, type Request, type Response } from "express";
import { GoogleGenAI } from "@google/genai";

const router = Router();
const apiKey = process.env.GEMINI_API_KEY;

router.post("/title", async (req: Request, res: Response): Promise<void> => {
  const { message } = req.body as { message?: string };
  const fallback = (message && typeof message === "string" ? message.slice(0, 30) : "New Chat") || "New Chat";
  try {
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message required" });
      return;
    }
    if (!apiKey) {
      res.json({ title: message.slice(0, 40).trim() || "New Chat" });
      return;
    }
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: `Given this user message, respond with ONLY a short 2-4 word title for the chat session. No quotes, no punctuation. Be concise.

Message: ${message.slice(0, 500)}`,
      config: { maxOutputTokens: 20 },
    });
    const text = response.text?.trim() ?? "";
    const title = text.slice(0, 50) || fallback;
    res.json({ title });
  } catch {
    res.json({ title: fallback });
  }
});

export default router;
