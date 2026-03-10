import { Router, type Request, type Response } from "express";
import { createServerClient } from "../lib/supabase/server.js";
import { requireAuth } from "../lib/auth.js";
import { ensureProjectFolder, toSafeProjectFolderName } from "../workspace.js";
const router = Router();

/** List user's projects (auth required). */
router.get("/projects", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as Request & { userId: string }).userId;
    const supabase = createServerClient();

    const { data: workspaces, error: wsErr } = await supabase
      .from("workspaces")
      .select("id")
      .eq("owner_id", userId);

    if (wsErr || !workspaces?.length) {
      res.json([]);
      return;
    }

    const workspaceIds = workspaces.map((w) => w.id);
    const { data: projects, error } = await supabase
      .from("projects")
      .select("id, name, description, created_at")
      .eq("status", "active")
      .in("workspace_id", workspaceIds)
      .order("updated_at", { ascending: false })
      .limit(50);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json(
      (projects ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        createdAt: p.created_at,
      }))
    );
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    res.status(500).json({ error: err.message });
  }
});

/** Update project name and/or description (workspaceId = projectId). Body: { name?: string, description?: string }. */
router.patch("/:workspaceId/project", requireAuth, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const userId = (req as Request & { userId: string }).userId;
    const { name, description } = req.body as { name?: string; description?: string };

    if (!name && description === undefined) {
      res.status(400).json({ error: "name or description required" });
      return;
    }

    const supabase = createServerClient();
    const { data: project, error: fetchErr } = await supabase
      .from("projects")
      .select("id, workspace_id")
      .eq("id", workspaceId)
      .single();

    if (fetchErr || !project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const { data: workspace } = await supabase
      .from("workspaces")
      .select("owner_id")
      .eq("id", project.workspace_id)
      .single();

    if (!workspace || workspace.owner_id !== userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const updates: { name?: string; description?: string | null; updated_at: string } = {
      updated_at: new Date().toISOString(),
    };
    if (name !== undefined && typeof name === "string" && name.trim().length > 0) {
      updates.name = name.trim();
    }
    if (description !== undefined) {
      updates.description = typeof description === "string" ? description.trim() || null : null;
    }

    const { error: updateErr } = await supabase
      .from("projects")
      .update(updates)
      .eq("id", workspaceId);

    if (updateErr) {
      res.status(500).json({ error: updateErr.message });
      return;
    }

    if (updates.name && toSafeProjectFolderName(updates.name)) {
      try {
        await ensureProjectFolder(workspaceId, updates.name);
      } catch (e) {
        console.warn("[projects] ensureProjectFolder failed:", (e as Error)?.message);
      }
    }

    res.json({
      ...(updates.name !== undefined && { name: updates.name }),
      ...(updates.description !== undefined && { description: updates.description }),
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    res.status(500).json({ error: err.message });
  }
});

/** Delete a project and all its data (files, chat_sessions, chat_messages) in Supabase. projectId = workspaceId. */
router.delete("/:projectId/project", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const projectId = req.params.projectId as string;
    const userId = (req as Request & { userId: string }).userId;
    if (!projectId?.trim()) {
      res.status(400).json({ error: "projectId required" });
      return;
    }

    const supabase = createServerClient();
    const { data: project, error: fetchErr } = await supabase
      .from("projects")
      .select("id, workspace_id")
      .eq("id", projectId)
      .single();

    if (fetchErr || !project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const { data: workspace } = await supabase
      .from("workspaces")
      .select("owner_id")
      .eq("id", project.workspace_id)
      .single();

    if (!workspace || workspace.owner_id !== userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const { error: deleteErr } = await supabase.from("projects").delete().eq("id", projectId);

    if (deleteErr) {
      res.status(500).json({ error: deleteErr.message });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    res.status(500).json({ error: err.message });
  }
});

export default router;
