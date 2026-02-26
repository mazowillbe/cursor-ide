import { Router, type Request, type Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createWorkspaceWithId } from "../workspace.js";
import { createServerClient } from "../lib/supabase/server.js";
import { requireAuth } from "../lib/auth.js";

const router = Router();

/**
 * Ensure a row exists in public.profiles for this auth user.
 * If the DB trigger didn't run (e.g. migrations not applied or user created before trigger),
 * we create the profile here so workspace insert (owner_id -> profiles.id) succeeds.
 */
async function ensureProfileForUser(supabase: SupabaseClient, userId: string): Promise<void> {
  const { data: existing } = await supabase.from("profiles").select("id").eq("id", userId).single();
  if (existing) return;

  const { data: authUser, error: authErr } = await supabase.auth.admin.getUserById(userId);
  if (authErr || !authUser?.user) {
    throw new Error(authUser?.user ? "Could not load user" : authErr?.message ?? "User not found");
  }
  const u = authUser.user;
  const email = u.email ?? "";
  const fullName = (u.user_metadata?.full_name as string) ?? "";

  await supabase.from("profiles").upsert(
    { id: userId, email, full_name: fullName },
    { onConflict: "id" }
  );
}

/**
 * Get or create current session for the user.
 * - If body.new === true: always create a new project and set as current (for "New Project" button).
 * - Otherwise: return existing project (from last_project_id) if valid; else create one.
 * This prevents creating a new project on every page refresh.
 */
router.post("/session", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as Request & { userId: string }).userId;
    const forceNew = (req as Request & { body?: { new?: boolean } }).body?.new === true;
    let supabase;
    try {
      supabase = createServerClient();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(503).json({
        error: msg.includes("must be set")
          ? "Backend Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend .env"
          : msg,
      });
      return;
    }

    await ensureProfileForUser(supabase, userId);

    let projectId: string;
    let projectName: string;

    if (!forceNew) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("id, last_project_id")
        .eq("id", userId)
        .single();

      if (profile?.last_project_id) {
        const { data: project, error: projErr } = await supabase
          .from("projects")
          .select("id, name, workspace_id")
          .eq("id", profile.last_project_id)
          .single();

        if (!projErr && project) {
          const { data: ws } = await supabase
            .from("workspaces")
            .select("id")
            .eq("id", project.workspace_id)
            .eq("owner_id", userId)
            .single();

          if (ws) {
            projectId = project.id;
            projectName = project.name ?? "Project";
            await createWorkspaceWithId(projectId);
            res.status(200).json({ workspaceId: projectId, projectName });
            return;
          }
        }
      }
    }

    const { data: workspaces } = await supabase
      .from("workspaces")
      .select("id")
      .eq("owner_id", userId)
      .limit(1);

    let workspaceId: string;
    if (workspaces && workspaces.length > 0) {
      workspaceId = workspaces[0].id;
    } else {
      const slug = `workspace-${userId.slice(0, 8)}`;
      const { data: newWs, error: wsErr } = await supabase
        .from("workspaces")
        .insert({ name: "My Workspace", slug, owner_id: userId })
        .select("id")
        .single();
      if (wsErr || !newWs) {
        res.status(500).json({ error: wsErr?.message ?? "Failed to create workspace" });
        return;
      }
      workspaceId = newWs.id;
    }

    const { data: project, error: projErr } = await supabase
      .from("projects")
      .insert({
        workspace_id: workspaceId,
        name: "New Project",
        description: "Created from Cursor Web",
      })
      .select("id, name")
      .single();

    if (projErr || !project) {
      res.status(500).json({ error: projErr?.message ?? "Failed to create project" });
      return;
    }

    projectId = project.id;
    projectName = project.name ?? "New Project";

    await supabase.from("profiles").update({ last_project_id: projectId }).eq("id", userId);
    await createWorkspaceWithId(projectId);
    res.status(201).json({ workspaceId: projectId, projectName });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    res.status(500).json({ error: err.message });
  }
});

/**
 * Open a project by id: ensure folder exists, set as current, return project.
 */
router.get("/session/:projectId", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as Request & { userId: string }).userId;
    const { projectId } = req.params;
    let supabase;
    try {
      supabase = createServerClient();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(503).json({
        error: msg.includes("must be set")
          ? "Backend Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend .env"
          : msg,
      });
      return;
    }

    await ensureProfileForUser(supabase, userId);

    const { data: project, error: projErr } = await supabase
      .from("projects")
      .select("id, name, workspace_id")
      .eq("id", projectId)
      .single();

    if (projErr || !project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const { data: ws } = await supabase
      .from("workspaces")
      .select("id")
      .eq("id", project.workspace_id)
      .eq("owner_id", userId)
      .single();

    if (!ws) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    await createWorkspaceWithId(projectId);
    await supabase.from("profiles").update({ last_project_id: projectId }).eq("id", userId);

    res.json({ workspaceId: projectId, projectName: project.name ?? "Project" });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    res.status(500).json({ error: err.message });
  }
});

export default router;
