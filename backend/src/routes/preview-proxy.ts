/**
 * Preview proxy: secure proxy for dev server (e.g. Vite on :5173) per workspace.
 * GET /api/preview/:workspaceId/* -> http://127.0.0.1:port/*
 * WebSocket upgrade /api/preview/:workspaceId -> ws://127.0.0.1:port (for HMR).
 * Uses router.use("/:workspaceId") so /api/preview/xyz, /api/preview/xyz/, and /api/preview/xyz/any/path all match.
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

  // Match /:workspaceId, /:workspaceId/, and /:workspaceId/any/subpath (iframe and all assets)
  router.use("/:workspaceId", (req: Request, res: Response, next) => {
    const workspaceId = req.params.workspaceId;
    const target = workspaceId ? getPreviewTarget(workspaceId) : null;
    if (!target) {
      res.status(404).json({ error: "No preview for this workspace" });
      return;
    }
    // Strip /api/preview/:workspaceId from path so proxy requests the correct path from Vite (e.g. /src/main.jsx).
    // req.url may be full path or path-after-mount depending on Express; req.originalUrl is the full path.
    const pathOnly = (req.originalUrl ?? req.url ?? "/").split("?")[0];
    const prefix = `/api/preview/${workspaceId}`;
    const downstreamPath = pathOnly === prefix || pathOnly.startsWith(prefix + "/")
      ? pathOnly.slice(prefix.length) || "/"
      : pathOnly.replace(/^\/[^/]*/, "") || "/";
    req.url = downstreamPath;
    (req as Request & { previewWorkspaceId?: string; previewDownstreamPath?: string }).previewWorkspaceId = workspaceId;
    (req as Request & { previewWorkspaceId?: string; previewDownstreamPath?: string }).previewDownstreamPath = downstreamPath;
    proxyWeb(req, res, target);
  });

  return router;
}
