import { Router, type Request, type Response } from "express";
import { runOpenCodeAndGetText } from "../opencode-run.js";

const router = Router();

router.post("/title", async (req: Request, res: Response): Promise<void> => {
  const { message } = req.body as { message?: string };
  const fallback = (message && typeof message === "string" ? message.slice(0, 30) : "New Chat") || "New Chat";
  try {
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message required" });
      return;
    }
    const prompt = `Given this user message, respond with ONLY a short 2-4 word title for the chat session. No quotes, no punctuation. Be concise.

Message: ${message.slice(0, 500)}`;
    const text = await runOpenCodeAndGetText(prompt, { model: process.env.OPENCODE_TITLE_MODEL });
    const title = (text || fallback).slice(0, 50).trim() || fallback;
    res.json({ title });
  } catch (err) {
    console.warn("[title] OpenCode failed, using fallback:", err);
    res.json({ title: fallback });
  }
});

export default router;
