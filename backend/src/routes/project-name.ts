import { Router, type Request, type Response } from "express";
import { GoogleGenAI } from "@google/genai";

const router = Router();
const apiKey = process.env.GEMINI_API_KEY;

/** Valid project name: 2 or 3 lowercase parts separated by dashes, e.g. my-app or my-favorite-app */
const PROJECT_NAME_REGEX = /^[a-z][a-z0-9]*-[a-z0-9]+(-[a-z0-9]+)?$/;

function isValidProjectName(s: string): boolean {
  return PROJECT_NAME_REGEX.test(s) && s.length <= 50;
}

function normalizeToProjectName(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  if (isValidProjectName(cleaned)) return cleaned;
  const parts = cleaned.split("-").filter(Boolean);
  if (parts.length === 2) return parts.join("-");
  if (parts.length >= 3) return parts.slice(0, 3).join("-");
  return null;
}

router.post("/project-name", async (req: Request, res: Response): Promise<void> => {
  const { message } = req.body as { message?: string };
  try {
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message required" });
      return;
    }
    if (!apiKey) {
      res.json({ name: null });
      return;
    }
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: `You analyze if a user wants to CREATE A NEW PROJECT (a new app, website, or codebase from scratch).

Rules:
1. If the user wants to create/build/scaffold a new project, app, or website, respond with ONLY a project name.
2. The name must be 2 or 3 parts separated by dashes. Examples: todo-app, recipe-finder, my-todo-app, weather-dashboard.
3. Use lowercase only. No spaces, no special characters.
4. If the user does NOT want to create a new project (e.g. they want to fix something, edit existing code, ask a question, debug), respond with exactly: NONE

User message: ${message.slice(0, 500)}`,
      config: { maxOutputTokens: 30 },
    });
    const raw = (response.text ?? "").trim();
    if (raw.toUpperCase() === "NONE" || raw.length === 0) {
      res.json({ name: null });
      return;
    }
    const name = normalizeToProjectName(raw);
    res.json({ name: name ?? null });
  } catch {
    res.json({ name: null });
  }
});

export default router;
