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
import lintsRouter from "./routes/lints.js";
import { attachAgentWebSocket } from "./websocket.js";
import { attachTerminalWebSocket, TERMINAL_WS_PATH } from "./terminal-ws.js";
import executeToolRouter from "./routes/execute-tool.js";
import describeImageRouter from "./routes/describe-image.js";
import { getPreviewProxyRouter } from "./routes/preview-proxy.js";

const AGENT_WS_PATH = "/api/agent";
const PREVIEW_PREFIX = "/api/preview/";

async function main() {
  await ensureWorkspaceRoot();

  const app = express();
  app.set("trust proxy", 1);
  const corsOpts = config.corsOrigin
    ? { origin: config.corsOrigin.split(",").map((o) => o.trim()).filter(Boolean) }
    : { origin: true };
  app.use(cors(corsOpts));
  app.use(express.json({ limit: "10mb" }));

  app.use("/api", sessionsRouter);
  app.use("/api", projectsRouter);
  app.use("/api", filesRouter);
  app.use("/api", modelsRouter);
  app.use("/api", titleRouter);
  app.use("/api", projectNameRouter);
  app.use("/api", searchRouter);
  app.use("/api", gitRouter);
  app.use("/api", lintsRouter);
  app.use("/api", executeToolRouter);
  app.use("/api", describeImageRouter);

  const httpProxyServer = httpProxy.createProxyServer({ ws: true });

  app.use(
    "/api/preview",
    getPreviewProxyRouter(async (req: express.Request, res: express.Response, target: { host: string; port: number }) => {
      const host = (target.host && target.host.trim()) || "127.0.0.1";
      const targetUrl = host.includes(":") ? `http://[${host}]:${target.port}` : `http://${host}:${target.port}`;

      // Resolve workspaceId: from router-set property, Express params, or parse from URL.
      // req.params.workspaceId is set by the preview router; originalUrl can differ behind proxies (e.g. Railway).
      const origUrl = (req.originalUrl ?? req.url ?? "/").split("#")[0]!;
      let workspaceId =
        (req as express.Request & { previewWorkspaceId?: string }).previewWorkspaceId ??
        (req.params && typeof req.params.workspaceId === "string" ? req.params.workspaceId : null) ??
        (() => {
          const m = origUrl.match(/^\/api\/preview\/([^/]+)(\/.*)?$/);
          return m ? m[1]! : null;
        })();
      let downstreamPath = (req as express.Request & { previewDownstreamPath?: string }).previewDownstreamPath ?? req.url ?? "/";
      const prefix = workspaceId ? `/api/preview/${workspaceId}` : "";
      const query = origUrl.includes("?") ? "?" + origUrl.split("?")[1] : "";
      const url = `${targetUrl.replace(/\/$/, "")}${downstreamPath.toString().startsWith("/") ? downstreamPath : `/${downstreamPath}`}${query}`;

      console.log("[preview] request", {
        origUrl,
        workspaceId: workspaceId ?? "(none)",
        prefix: prefix || "(empty)",
        downstreamPath,
        fetchUrl: url,
      });
      if (!prefix) {
        console.warn("[preview] no prefix — HTML/JS/CSS will not be rewritten; assets may 404");
      }

      try {
        const targetHost = new URL(targetUrl).host;
        const forwardHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (v === undefined || k.toLowerCase() === "host") continue;
          forwardHeaders[k] = Array.isArray(v) ? v[0]! : v;
        }
        forwardHeaders.host = targetHost;
        const upstream = await fetch(url, { headers: forwardHeaders });
        if (!upstream.ok) {
          console.warn("[preview] upstream non-OK", { url, status: upstream.status });
          res.status(upstream.status).end();
          return;
        }
        const ct = (upstream.headers.get("content-type") ?? "").toLowerCase();
        const isHtml = ct.includes("text/html");
        const isJs = ct.includes("javascript") || ct.includes("ecmascript");

        const isIndexRequest = downstreamPath === "/" || downstreamPath === "" || downstreamPath === "/index.html";
        console.log("[preview] upstream response", {
          downstreamPath,
          contentType: ct.slice(0, 50),
          isHtml,
          isJs,
          isIndexRequest,
          willRewriteHtml: isHtml && isIndexRequest && !!prefix,
          willRewriteJs: isJs && !!prefix,
        });

        if (isHtml && isIndexRequest && prefix) {
          const html = await upstream.text();
          const matchCount = (html.match(/(src|href)\s*=\s*(["'])(\/)(?!\/)([^"']*)["']/g) ?? []).length;
          console.log("[preview] rewriting HTML", { prefix, srcHrefMatchCount: matchCount });
          // Rewrite src/href so absolute paths go through the preview proxy (allow optional whitespace around =)
          let injected = html.replace(
            /(src|href)\s*=\s*(["'])(\/)(?!\/)([^"']*)["']/g,
            (_: string, attr: string, quote: string, _slash: string, pathRest: string) =>
              `${attr}=${quote}${prefix}/${pathRest}${quote}`
          );
          // Inject WebSocket interceptor so Vite HMR connects to /api/preview/:id/ instead of /
          const wsInterceptor = `<script>(function(){var b=location.pathname.replace(/\\/@vite\\/client.*$/,"").replace(/\\/?$/,"/");window.__VITE_HMR_BASE__=b;var O=WebSocket;window.WebSocket=function(u,a){if(typeof u==="string"&&(u.startsWith("ws://")||u.startsWith("wss://"))&&!u.includes("/api/preview/")){try{var url=new URL(u,location.href);url.pathname=b||"/";u=url.toString()}catch(e){}}return new O(u,a)};})();</script>`;
          if (injected.includes("<head>")) {
            injected = injected.replace("<head>", "<head>" + wsInterceptor);
          } else if (injected.includes("<html>")) {
            injected = injected.replace("<html>", "<html>" + wsInterceptor);
          } else {
            injected = wsInterceptor + injected;
          }
          res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "text/html; charset=utf-8");
          res.send(injected);
          return;
        }

        if (isJs && prefix) {
          let body = await upstream.text();
          // Don't rewrite Vite pre-bundled deps (e.g. react/jsx-runtime) — rewriting can break exports and cause "does not provide an export named 'jsx'".
          const isViteDep = downstreamPath.startsWith("/node_modules/.vite/deps/");
          if (isViteDep) {
            res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/javascript");
            res.setHeader("Content-Length", Buffer.byteLength(body, "utf8"));
            res.send(body);
            return;
          }
          // Rewrite absolute path strings that look like URLs (contain @ or .). Skip regex-looking and bare "/" in @vite/client.
          const isViteClient = downstreamPath === "/@vite/client";
          const rewritePath = (path: string) => {
            if (isViteClient && (path === "/" || path === "/@vite/client" || path.startsWith("/@vite/client?"))) return path;
            return /@|\.[a-zA-Z0-9]+$|\.[a-zA-Z0-9]+\?/.test(path) ? `${prefix}${path}` : path;
          };
          body = body
            .replace(/"(\/(?!\/)(?!api\/preview\/)[^"]*)"/g, (_, path) => `"${rewritePath(path)}"`)
            .replace(/'(\/(?!\/)(?!api\/preview\/)[^']*)'/g, (_, path) => `'${rewritePath(path)}'`)
            .replace(/`(\/(?!\/)(?!api\/preview\/)[^`]*)`/g, (_, path) => `\`${rewritePath(path)}\``);
          // Force HMR WebSocket base in @vite/client so it connects to /api/preview/:id/ not /.
          if (isViteClient) {
            const basePath = `${prefix}/`;
            body = body.replace(/\b(base|path)\s*=\s*["']\/["']/g, `$1 = "${basePath}"`);
            body = body.replace(/\b(base|path)\s*=\s*`\/`/g, `$1 = \`${basePath}\``);
            body = body.replace(/(\w+)\s*\+\s*["']\/["']/g, (m, v) => (v === "host" || v === "origin" ? `${v} + "${basePath}"` : m));
            body = body.replace(/(\w+)\s*\+\s*'\/'/g, (m, v) => (v === "host" || v === "origin" ? `${v} + '${basePath}'` : m));
            body = body.replace(/\$\{host\}\//g, `\${host}${basePath}`);
          }
          // Inject React import for app entry files that lack it. Use full URL so the browser can resolve it (bare "react" fails in proxied modules).
          const isAppEntry =
            downstreamPath === "/src/main.jsx" ||
            downstreamPath === "/src/main.js" ||
            downstreamPath === "/src/App.jsx" ||
            downstreamPath === "/src/App.js" ||
            downstreamPath === "/src/index.jsx" ||
            downstreamPath === "/src/index.js";
          const hasReactImport = /from\s*["']react["']|from\s*["']react\/jsx-runtime["']/.test(body);
          if (isAppEntry && !hasReactImport) {
            body = "import React from 'https://esm.sh/react';\n" + body;
          }
          const rewritten = body;
          console.log("[preview] rewriting JS", { prefix, path: downstreamPath, length: body.length });
          res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/javascript");
          res.setHeader("Content-Length", Buffer.byteLength(rewritten, "utf8"));
          res.send(rewritten);
          return;
        }

        if (ct.includes("text/css") && prefix) {
          const body = await upstream.text();
          console.log("[preview] rewriting CSS", { prefix, path: downstreamPath });
          const rewritten = body.replace(/url\((["']?)(\/)(?!\/)/g, `url($1${prefix}$2`);
          res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "text/css");
          res.setHeader("Content-Length", Buffer.byteLength(rewritten, "utf8"));
          res.send(rewritten);
          return;
        }

        console.log("[preview] passthrough (no rewrite)", { downstreamPath, contentType: ct.slice(0, 40) });
        res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream");
        const buf = await upstream.arrayBuffer();
        res.end(Buffer.from(buf));
      } catch (e) {
        console.error("[preview] fetch error:", (e as Error)?.message, "url:", url);
        if (!res.headersSent) res.status(502).json({ error: "Preview proxy error", detail: (e as Error)?.message });
      }
    })
  );

  app.get("/api/health", (_req, res) => {
    res.json({ healthy: true, service: "cursor-web-backend" });
  });

  const server = createServer(app);

  const agentWss = new WebSocketServer({ noServer: true });
  const terminalWss = new WebSocketServer({ noServer: true });
  attachAgentWebSocket(agentWss);
  attachTerminalWebSocket(terminalWss);

  server.on("upgrade", (request, socket, head) => {
    const url = request.url ?? "";
    if (url.startsWith(TERMINAL_WS_PATH)) {
      terminalWss.handleUpgrade(request, socket, head, (ws) => {
        terminalWss.emit("connection", ws, request);
      });
      return;
    }
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
        console.log("[preview] WS upgrade", { workspaceId, target, newPath });
        httpProxyServer.ws(request, socket, head, { target }, (err: Error | null) => {
          request.url = origUrl;
          if (err) console.error("[preview] proxy ws error:", err?.message);
          socket.destroy();
        });
      } else {
        console.warn("[preview] WS upgrade rejected", { url: url.slice(0, 80), workspaceId, hasTarget: !!previewTarget });
        socket.destroy();
      }
      return;
    }
    if (url === AGENT_WS_PATH || url.startsWith(AGENT_WS_PATH + "?")) {
      agentWss.handleUpgrade(request, socket, head, (ws) => {
        agentWss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  const listenHost = process.env.PORT ? "0.0.0.0" : (config.host || "127.0.0.1");
  server.listen(config.port, listenHost, () => {
    console.log(`Backend listening on http://${listenHost}:${config.port}`);
    console.log(`WebSocket agent at ws://${listenHost}:${config.port}/api/agent`);
    console.log(`Terminal WebSocket at ws://${listenHost}:${config.port}/api/terminal`);
    console.log(`Preview proxy at http://${listenHost}:${config.port}/api/preview/:workspaceId/`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
