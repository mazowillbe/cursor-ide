import { Router, type Response } from "express";

/** All OpenCode Zen models. MiniMax M2.5 Free is default (first). See opencode.ai/docs/zen */
const MODELS = [
  { id: "opencode/minimax-m2.5-free", label: "MiniMax M2.5 Free (Zen)" },
  { id: "opencode/glm-5-free", label: "GLM 5 Free (Zen)" },
  { id: "opencode/kimi-k2.5-free", label: "Kimi K2.5 Free (Zen)" },
  { id: "opencode/gpt-5-nano", label: "GPT 5 Nano (Zen)" },
  { id: "opencode/big-pickle", label: "Big Pickle (Zen)" },
  { id: "opencode/minimax-m2.5", label: "MiniMax M2.5 (Zen)" },
  { id: "opencode/minimax-m2.1", label: "MiniMax M2.1 (Zen)" },
  { id: "opencode/glm-5", label: "GLM 5 (Zen)" },
  { id: "opencode/glm-4.7", label: "GLM 4.7 (Zen)" },
  { id: "opencode/glm-4.6", label: "GLM 4.6 (Zen)" },
  { id: "opencode/kimi-k2.5", label: "Kimi K2.5 (Zen)" },
  { id: "opencode/kimi-k2-thinking", label: "Kimi K2 Thinking (Zen)" },
  { id: "opencode/kimi-k2", label: "Kimi K2 (Zen)" },
  { id: "opencode/qwen3-coder", label: "Qwen3 Coder 480B (Zen)" },
  { id: "opencode/gpt-5.2", label: "GPT 5.2 (Zen)" },
  { id: "opencode/gpt-5.2-codex", label: "GPT 5.2 Codex (Zen)" },
  { id: "opencode/gpt-5.1", label: "GPT 5.1 (Zen)" },
  { id: "opencode/gpt-5.1-codex", label: "GPT 5.1 Codex (Zen)" },
  { id: "opencode/gpt-5.1-codex-max", label: "GPT 5.1 Codex Max (Zen)" },
  { id: "opencode/gpt-5.1-codex-mini", label: "GPT 5.1 Codex Mini (Zen)" },
  { id: "opencode/gpt-5", label: "GPT 5 (Zen)" },
  { id: "opencode/gpt-5-codex", label: "GPT 5 Codex (Zen)" },
  { id: "opencode/claude-opus-4-6", label: "Claude Opus 4.6 (Zen)" },
  { id: "opencode/claude-opus-4-5", label: "Claude Opus 4.5 (Zen)" },
  { id: "opencode/claude-opus-4-1", label: "Claude Opus 4.1 (Zen)" },
  { id: "opencode/claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Zen)" },
  { id: "opencode/claude-sonnet-4-5", label: "Claude Sonnet 4.5 (Zen)" },
  { id: "opencode/claude-sonnet-4", label: "Claude Sonnet 4 (Zen)" },
  { id: "opencode/claude-haiku-4-5", label: "Claude Haiku 4.5 (Zen)" },
  { id: "opencode/claude-3-5-haiku", label: "Claude Haiku 3.5 (Zen)" },
  { id: "opencode/gemini-3.1-pro", label: "Gemini 3.1 Pro (Zen)" },
  { id: "opencode/gemini-3-pro", label: "Gemini 3 Pro (Zen)" },
  { id: "opencode/gemini-3-flash", label: "Gemini 3 Flash (Zen)" },
];

const router = Router();

router.get("/models", (_req, res: Response): void => {
  res.json(MODELS);
});

export default router;
