import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;

/** Max characters per message to send to the summarizer (avoid token limits). */
const MAX_CHARS_PER_MESSAGE = 600;
/** Max total characters for the conversation transcript. */
const MAX_TOTAL_CHARS = 6000;
/** Max messages to include (user + assistant pairs). */
const MAX_MESSAGES = 24;

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Summarize a conversation using Gemini so the main agent can use summary + latest message.
 * Returns a short summary (2-5 sentences) or empty string if summarization is skipped/fails.
 */
export async function summarizeConversation(
  messages: ConversationMessage[]
): Promise<string> {
  if (!apiKey || messages.length === 0) return "";

  const trimmed = messages.slice(-MAX_MESSAGES).map((m) => ({
    role: m.role,
    content: (m.content || "").trim().slice(0, MAX_CHARS_PER_MESSAGE),
  }));

  let total = 0;
  const lines: string[] = [];
  for (let i = trimmed.length - 1; i >= 0 && total < MAX_TOTAL_CHARS; i--) {
    const m = trimmed[i]!;
    const line = `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`;
    if (total + line.length > MAX_TOTAL_CHARS) {
      lines.unshift(line.slice(0, MAX_TOTAL_CHARS - total));
      break;
    }
    lines.unshift(line);
    total += line.length;
  }

  if (lines.length === 0) return "";

  const transcript = lines.join("\n\n");

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: `You are a conversation summarizer. Given the following chat transcript between User and Assistant, write a short summary (2-5 sentences) that captures:
- What the user asked for or wanted to do (list each request)
- What actions the assistant actually took with tools (e.g. ran a command, read a file, ran a search, made an edit) — be specific
- The current topic or project (e.g. "calculator app", "Todo app")

Rules:
- Write in third person. Be factual and concise. No code or long quotes.
- Do NOT state that the assistant "completed", "fulfilled", "wrote", "created" or "responded to" a user request unless the transcript clearly shows a tool call that did that (e.g. write_file, edit_file). If the user asked for a file to be created and the assistant only sent a chat message (no write/edit tool), say only "The user asked for X" and "The assistant replied in chat" — do not say the assistant wrote or created the file.
- Do not imply that any user request has been satisfied. Only describe what was asked and what actions were taken.

Transcript:
---
${transcript}
---

Summary:`,
      config: { maxOutputTokens: 256, temperature: 0.2 },
    });

    const text = response.text?.trim() ?? "";
    return text.slice(0, 1500) || "";
  } catch (err) {
    console.warn("[summarizer] Failed to summarize conversation:", err instanceof Error ? err.message : err);
    return "";
  }
}
