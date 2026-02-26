import { Router, type Request, type Response } from "express";
import { getWorkspacePath, workspaceExists } from "../workspace.js";
import fs from "fs/promises";
import path from "path";

const router = Router();
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".txt", ".css", ".scss",
  ".html", ".htm", ".xml", ".yaml", ".yml", ".env", ".sql", ".sh", ".bat",
]);

async function searchInFile(
  filePath: string,
  pattern: string | RegExp,
  results: { path: string; line: number; text: string }[]
): Promise<void> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split(/\r?\n/);
    const regex = typeof pattern === "string"
      ? new RegExp(escapeRegex(pattern), "gi")
      : pattern;
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (regex.test(lines[i])) {
        results.push({ path: filePath, line: i + 1, text: lines[i].trim() });
        if (results.length >= 50) return;
      }
    }
  } catch {
    /* skip binary or unreadable */
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function walkDir(
  dir: string,
  base: string,
  pattern: string | RegExp,
  results: { path: string; line: number; text: string }[]
): Promise<void> {
  if (results.length >= 50) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).replace(/\\/g, "/");
    if (e.isDirectory()) {
      await walkDir(full, base, pattern, results);
    } else if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
      await searchInFile(rel, pattern, results);
    }
  }
}

router.get("/:workspaceId/search", async (req: Request, res: Response): Promise<void> => {
  try {
    const { workspaceId } = req.params;
    const q = (req.query.q as string) || "";
    if (!workspaceId || !q.trim()) {
      res.status(400).json({ error: "workspaceId and q required" });
      return;
    }
    const exists = await workspaceExists(workspaceId);
    if (!exists) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const base = getWorkspacePath(workspaceId);
    const results: { path: string; line: number; text: string }[] = [];
    await walkDir(base, base, q.trim(), results);
    res.json({ results });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    res.status(500).json({ error: err.message });
  }
});

export default router;
