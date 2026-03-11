import { Router, type Request, type Response } from "express";
import { workspaceExists, getWorkspacePath } from "../workspace.js";
import { existsSync } from "fs";
import path from "path";

const router = Router();

router.all("/:workspaceId/*", async (req: Request, res: Response): Promise<void> => {
  try {
    const { workspaceId } = req.params;
    
    // Extract the remaining path after /:workspaceId/
    const remainingPath = req.path.replace(new RegExp(`^/${workspaceId}/`), "");
    
    if (!workspaceId || !remainingPath) {
      res.status(400).json({ error: "workspaceId and API path required" });
      return;
    }

    // Validate workspace exists
    const exists = await workspaceExists(workspaceId);
    if (!exists) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    // Build handler file path in workspace's api directory
    const workspacePath = getWorkspacePath(workspaceId);
    const apiDir = path.join(workspacePath, "api");
    
    // Normalize the path to prevent directory traversal
    const normalizedPath = path.normalize(remainingPath).replace(/^(\.\.(\/|\\|$))+/, "");
    
    // Try .ts first, then .js
    const handlerPaths = [
      path.join(apiDir, `${normalizedPath}.ts`),
      path.join(apiDir, `${normalizedPath}.js`),
    ];

    let handlerPath: string | null = null;
    for (const candidate of handlerPaths) {
      if (existsSync(candidate)) {
        handlerPath = candidate;
        break;
      }
    }

    if (!handlerPath) {
      res.status(404).json({ error: "API handler not found" });
      return;
    }

    // Dynamically import the handler module
    try {
      const handlerModule = await import(handlerPath);
      const handler = handlerModule.default;

      if (typeof handler !== "function") {
        res.status(500).json({ error: "API handler must export a default function" });
        return;
      }

      // Call the handler with req, res
      await handler(req, res);
    } catch (handlerError) {
      console.error("[workspace-api] handler execution error:", handlerError);
      const err = handlerError instanceof Error ? handlerError : new Error(String(handlerError));
      res.status(500).json({ error: err.message });
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error("[workspace-api] route error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
