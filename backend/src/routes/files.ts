import { Router, type Request, type Response } from "express";
import {
  listWorkspaceFiles,
  readFile,
  writeFile,
  deletePath,
  createFolder,
  workspaceExists,
  getWorkspacePath,
} from "../workspace.js";
import { syncDiskToSupabase } from "../workspace-supabase.js";
import { config } from "../config.js";

const router = Router();

router.get("/:workspaceId/files", async (req: Request, res: Response): Promise<void> => {
  try {
    const { workspaceId } = req.params;
    const dir = (req.query.dir as string) || ".";
    if (!workspaceId) {
      res.status(400).json({ error: "workspaceId required" });
      return;
    }
    const exists = await workspaceExists(workspaceId);
    if (!exists) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const nodes = await listWorkspaceFiles(workspaceId, dir);
    res.json(nodes);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    res.status(500).json({ error: err.message });
  }
});

router.get("/:workspaceId/file", async (req: Request, res: Response): Promise<void> => {
  try {
    const { workspaceId } = req.params;
    const pathParam = req.query.path as string;
    if (!workspaceId || !pathParam) {
      res.status(400).json({ error: "workspaceId and path required" });
      return;
    }
    const exists = await workspaceExists(workspaceId);
    if (!exists) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const content = await readFile(workspaceId, pathParam);
    res.json({ content });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    res.status(500).json({ error: err.message });
  }
});

router.put("/:workspaceId/file", async (req: Request, res: Response): Promise<void> => {
  try {
    const { workspaceId } = req.params;
    const { path: filePath, content } = req.body as { path?: string; content?: string };
    if (!workspaceId || !filePath) {
      res.status(400).json({ error: "workspaceId and path required" });
      return;
    }
    const exists = await workspaceExists(workspaceId);
    if (!exists) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    await writeFile(workspaceId, filePath, content ?? "");
    res.json({ ok: true });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    res.status(500).json({ error: err.message });
  }
});

router.post("/:workspaceId/folder", async (req: Request, res: Response): Promise<void> => {
  try {
    const { workspaceId } = req.params;
    const { path: folderPath } = req.body as { path?: string };
    if (!workspaceId || !folderPath) {
      res.status(400).json({ error: "workspaceId and path required" });
      return;
    }
    const exists = await workspaceExists(workspaceId);
    if (!exists) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    await createFolder(workspaceId, folderPath);
    res.json({ ok: true });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:workspaceId/file", async (req: Request, res: Response): Promise<void> => {
  try {
    const { workspaceId } = req.params;
    const pathParam = req.query.path as string;
    if (!workspaceId || !pathParam) {
      res.status(400).json({ error: "workspaceId and path required" });
      return;
    }
    const exists = await workspaceExists(workspaceId);
    if (!exists) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    await deletePath(workspaceId, pathParam);
    res.json({ ok: true });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    res.status(500).json({ error: err.message });
  }
});

/** Sync all files from disk to Supabase for this workspace (excluding dist/, node_modules, etc.). */
router.post("/:workspaceId/files/sync", async (req: Request, res: Response): Promise<void> => {
  try {
    const { workspaceId } = req.params;
    if (!workspaceId) {
      res.status(400).json({ error: "workspaceId required" });
      return;
    }
    if (!config.useSupabaseFiles) {
      res.status(400).json({ error: "Supabase file storage is disabled" });
      return;
    }
    const exists = await workspaceExists(workspaceId);
    if (!exists) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const root = getWorkspacePath(workspaceId);
    await syncDiskToSupabase(workspaceId, root);
    res.json({ ok: true });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    res.status(500).json({ error: err.message });
  }
});

export default router;
