/**
 * Preview proxy: secure proxy for dev server (e.g. Vite on :5173) per workspace.
 * GET /api/preview/:workspaceId/* -> http://127.0.0.1:port/*
 * WebSocket upgrade /api/preview/:workspaceId -> ws://127.0.0.1:port (for HMR).
 */

import { Router, type Request, type Response } from "express";
import { getPort, getPreviewTarget } from "../preview-manager.js";

export function getPreviewProxyRouter(
  proxyWeb: (req: Request, res: Response, target: { host: string; port: number }) => void
): Router {
  const router = Router();

  router.get("/status", (req: Request, res: Response) => {
    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId.trim() : "";
    const port = workspaceId ? getPort(workspaceId) : null;
    if (!port) {
      res.json({ url: null, port: null });
      return;
    }
    res.json({ url: `http://localhost:${port}`, port });
  });

  router.all("/:workspaceId", (req: Request, res: Response) => {
    const workspaceId = req.params.workspaceId;
    const target = workspaceId ? getPreviewTarget(workspaceId) : null;
    if (!target) {
      res.status(404).json({ error: "No preview for this workspace" });
      return;
    }
    proxyWeb(req, res, target);
  });

  router.all("/:workspaceId/*", (req: Request, res: Response) => {
    const workspaceId = req.params.workspaceId;
    const target = workspaceId ? getPreviewTarget(workspaceId) : null;
    if (!target) {
      res.status(404).json({ error: "No preview for this workspace" });
      return;
    }
    proxyWeb(req, res, target);
  });

  return router;
}
