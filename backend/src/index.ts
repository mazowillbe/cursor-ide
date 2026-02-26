import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import httpProxy from "http-proxy";
import { config } from "./config.js";
import { ensureWorkspaceRoot } from "./workspace.js";
import { getPort, getPreviewTarget } from "./preview-manager.js";
import filesRouter from "./routes/files.js";
import sessionsRouter from "./routes/sessions.js";
import projectsRouter from "./routes/projects.js";
import modelsRouter from "./routes/models.js";
import titleRouter from "./routes/title.js";
import projectNameRouter from "./routes/project-name.js";
import searchRouter from "./routes/search.js";
import gitRouter from "./routes/git.js";
import { attachAgentWebSocket } from "./websocket.js";
import executeToolRouter from "./routes/execute-tool.js";
import describeImageRouter from "./routes/describe-image.js";
import { getPreviewProxyRouter } from "./routes/preview-proxy.js";

const AGENT_WS_PATH = "/api/agent";
const PREVIEW_PREFIX = "/api/preview/";

async function main() {
  await ensureWorkspaceRoot();

  const app = express();
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: "10mb" }));

  app.use("/api", sessionsRouter);
  app.use("/api", projectsRouter);
  app.use("/api", filesRouter);
  app.use("/api", modelsRouter);
  app.use("/api", titleRouter);
  app.use("/api", projectNameRouter);
  app.use("/api", searchRouter);
  app.use("/api", gitRouter);
  app.use("/api", executeToolRouter);
  app.use("/api", describeImageRouter);

  const httpProxyServer = httpProxy.createProxyServer({ ws: true });

  app.use(
    "/api/preview",
    getPreviewProxyRouter((req: express.Request, res: express.Response, target: { host: string; port: number }) => {
      const host = (target.host && target.host.trim()) || "127.0.0.1";
      const targetUrl = host.includes(":") ? `http://[${host}]:${target.port}` : `http://${host}:${target.port}`;
      // req.url is relative to mount, e.g. /workspaceId/ or /workspaceId/path -> strip first segment
      const origUrl = req.url ?? "/";
      req.url = origUrl.replace(/^\/[^/]+/, "") || "/";
      httpProxyServer.web(req, res, { target: targetUrl, changeOrigin: true }, (err: Error | null) => {
        if (err) {
          console.error("[preview] proxy web error:", err?.message, "target:", targetUrl);
          if (!res.headersSent) {
            res.status(502).json({ error: "Preview proxy error", detail: err?.message });
          }
        }
      });
    })
  );

  app.get("/api/health", (_req, res) => {
    res.json({ healthy: true, service: "cursor-web-backend" });
  });

  const server = createServer(app);

  const wss = new WebSocketServer({ noServer: true });
  attachAgentWebSocket(wss);

  server.on("upgrade", (request, socket, head) => {
    const url = request.url ?? "";
    if (url.startsWith(PREVIEW_PREFIX)) {
      const match = url.match(/^\/api\/preview\/([^/]+)(\/.*)?$/);
      const workspaceId = match?.[1];
      const previewTarget = workspaceId ? getPreviewTarget(workspaceId) : null;
      if (previewTarget && match) {
        const host = (previewTarget.host && previewTarget.host.trim()) || "127.0.0.1";
        const target = host.includes(":") ? `ws://[${host}]:${previewTarget.port}` : `ws://${host}:${previewTarget.port}`;
        const newPath = (match[2] ?? "") || "/";
        const origUrl = request.url;
        request.url = newPath;
        httpProxyServer.ws(request, socket, head, { target }, (err: Error | null) => {
          request.url = origUrl;
          if (err) console.error("[preview] proxy ws error:", err?.message);
          socket.destroy();
        });
      } else {
        socket.destroy();
      }
      return;
    }
    if (url === AGENT_WS_PATH || url.startsWith(AGENT_WS_PATH + "?")) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  server.listen(config.port, config.host, () => {
    console.log(`Backend listening on http://${config.host}:${config.port}`);
    console.log(`WebSocket agent at ws://${config.host}:${config.port}/api/agent`);
    console.log(`Preview proxy at http://${config.host}:${config.port}/api/preview/:workspaceId/`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
