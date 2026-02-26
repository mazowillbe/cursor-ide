import { Router, type Request, type Response } from "express";
import { execSync, execFileSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import { getWorkspacePath, workspaceExists, initGitInWorkspace } from "../workspace.js";
import { syncDiskToSupabase } from "../workspace-supabase.js";
import { config } from "../config.js";

const router = Router();

function runGit(workspaceId: string, args: string[]): string {
  const cwd = getWorkspacePath(workspaceId);
  try {
    return execSync(`git ${args.join(" ")}`, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      stdio: "pipe",
    }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(err.stderr || err.message || "Git command failed");
  }
}

router.get("/:workspaceId/git/status", async (req: Request, res: Response): Promise<void> => {
  try {
    const { workspaceId } = req.params;
    if (!workspaceId) {
      res.status(400).json({ error: "workspaceId required" });
      return;
    }
    const exists = await workspaceExists(workspaceId);
    if (!exists) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    initGitInWorkspace(workspaceId);
    let branch: string | null = null;
    let statusLines: string[] = [];
    let isRepo = false;
    try {
      const statusOut = runGit(workspaceId, ["status", "--short"]);
      isRepo = true;
      statusLines = statusOut ? statusOut.split("\n").filter((l) => l.trim()) : [];
    } catch {
      /* not a git repo or git not available */
    }
    if (isRepo) {
      try {
        const b = runGit(workspaceId, ["rev-parse", "--abbrev-ref", "HEAD"]);
        branch = b || null;
      } catch {
        /* no commits yet */
      }
    }
    res.json({ isRepo, branch, status: statusLines });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    res.status(500).json({ error: err.message });
  }
});

/** Ensure workspace has git inited (idempotent). Call when loading a workspace so diffs work. */
router.get("/:workspaceId/git/ensure", async (req: Request, res: Response): Promise<void> => {
  try {
    const { workspaceId } = req.params;
    if (!workspaceId) {
      res.status(400).json({ error: "workspaceId required" });
      return;
    }
    const exists = await workspaceExists(workspaceId);
    if (!exists) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    initGitInWorkspace(workspaceId);
    res.json({ ok: true });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    res.status(500).json({ error: err.message });
  }
});

router.post("/:workspaceId/git/init", async (req: Request, res: Response): Promise<void> => {
  try {
    const { workspaceId } = req.params;
    if (!workspaceId) {
      res.status(400).json({ error: "workspaceId required" });
      return;
    }
    const exists = await workspaceExists(workspaceId);
    if (!exists) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    initGitInWorkspace(workspaceId);
    res.json({ ok: true });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    res.status(500).json({ error: err.message });
  }
});

/** Clone a repo into the workspace (workspace must be empty). Body: { url: string }. */
router.post("/:workspaceId/git/clone", async (req: Request, res: Response): Promise<void> => {
  try {
    const { workspaceId } = req.params;
    const url = typeof (req.body as { url?: string }).url === "string" ? (req.body as { url: string }).url.trim() : "";
    if (!workspaceId) {
      res.status(400).json({ error: "workspaceId required" });
      return;
    }
    if (!url) {
      res.status(400).json({ error: "url required" });
      return;
    }
    const exists = await workspaceExists(workspaceId);
    if (!exists) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const cwd = getWorkspacePath(workspaceId);
    const gitDir = path.join(cwd, ".git");
    try {
      await fs.rm(gitDir, { recursive: true, force: true });
    } catch {
      /* .git may not exist; ignore */
    }
    try {
      execFileSync("git", ["clone", "--", url, "."], {
        cwd,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024 * 16,
        stdio: "pipe",
      });
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      res.status(400).json({ error: err.stderr || err.message || "Clone failed" });
      return;
    }
    if (config.useSupabaseFiles) {
      await syncDiskToSupabase(workspaceId, cwd).catch((e) =>
        console.warn("[git] syncDiskToSupabase failed:", (e as Error).message)
      );
    }
    res.json({ ok: true });
  } catch (e) {
    const err = e as Error;
    res.status(500).json({ error: err.message ?? "Clone failed" });
  }
});

/** Get unified diff for a file (working tree vs HEAD). Returns null if not a git repo, no commits yet, or path invalid. */
function getFileDiff(workspaceId: string, filePath: string): string | null {
  const cwd = getWorkspacePath(workspaceId);
  const execOpts = { cwd, encoding: "utf-8" as const, maxBuffer: 1024 * 1024, stdio: "pipe" as const };
  try {
    execSync("git rev-parse -q HEAD", execOpts);
  } catch {
    return null;
  }
  try {
    const out = execSync(`git diff HEAD -- ${filePath}`, execOpts);
    return out.trim() || null;
  } catch {
    return null;
  }
}

router.get("/:workspaceId/git/diff", async (req: Request, res: Response): Promise<void> => {
  try {
    const { workspaceId } = req.params;
    const pathParam = typeof req.query.path === "string" ? req.query.path.trim() : "";
    if (!workspaceId || !pathParam) {
      res.status(400).json({ error: "workspaceId and path required" });
      return;
    }
    const exists = await workspaceExists(workspaceId);
    if (!exists) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    initGitInWorkspace(workspaceId);
    const diff = getFileDiff(workspaceId, pathParam);
    res.json({ diff });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    res.status(500).json({ error: err.message });
  }
});

export default router;
