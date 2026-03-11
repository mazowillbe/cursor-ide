import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import httpProxy from "http-proxy";
import { config } from "./config.js";
import { ensureWorkspaceRoot, pruneOldWorkspaces } from "./workspace.js";
import { getPort, getPreviewTarget } from "./preview-manager.js";
import { getActiveWorkspaceIds, addSessionMessageListener } from "./websocket.js";
import filesRouter from "./routes/files.js";
import sessionsRouter from "./routes/sessions.js";
import projectsRouter from "./routes/projects.js";
import modelsRouter from "./routes/models.js";
import titleRouter from "./routes/title.js";
import projectNameRouter from "./routes/project-name.js";
import searchRouter from "./routes/search.js";
import gitRouter from "./routes/git.js";
import lintsRouter from "./routes/lints.js";
import workspaceApiRouter from "./routes/workspace-api.js";
import { attachAgentWebSocket } from "./websocket.js";
import { attachTerminalWebSocket, TERMINAL_WS_PATH } from "./terminal-ws.js";
import executeToolRouter from "./routes/execute-tool.js";
import describeImageRouter from "./routes/describe-image.js";
import { resetThinkingToolRequired } from "./thinking-tracker.js";
import { getPreviewProxyRouter } from "./routes/preview-proxy.js";

const AGENT_WS_PATH = "/api/agent";
const PREVIEW_PREFIX = "/api/preview/";

async function main() {
  await ensureWorkspaceRoot();

  const runPrune = async () => {
    const active = getActiveWorkspaceIds();
    const n = await pruneOldWorkspaces(active);
    if (n > 0) console.log("[workspace] auto-cleanup pruned", n, "old workspace(s)");
  };
  await runPrune();
  const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
  setInterval(runPrune, PRUNE_INTERVAL_MS);

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
  app.use("/api", workspaceApiRouter);
  if (process.env.ALLOW_TEST_ROUTES === "1") {
    app.post("/api/test/reset-thinking", express.json(), (req, res) => {
      const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId.trim() : "";
      if (!workspaceId) {
        res.status(400).json({ error: "Missing workspaceId" });
        return;
      }
      resetThinkingToolRequired(workspaceId);
      res.json({ ok: true });
    });
  }

  // Live SSE streaming: same agent events as WebSocket, for clients that prefer EventSource
  app.get("/api/agent/sse", (req: express.Request, res: express.Response) => {
    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId.trim() : "";
    const chatSessionId = typeof req.query.chatSessionId === "string" ? req.query.chatSessionId.trim() : undefined;
    if (!workspaceId) {
      res.status(400).send("Missing workspaceId");
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const resWithFlush = res as express.Response & { flush?: () => void };
    const unsubscribe = addSessionMessageListener((wid, cid, data) => {
      if (wid !== workspaceId || (chatSessionId != null && cid !== chatSessionId)) return;
      try {
        res.write(`data: ${data}\n\n`);
        resWithFlush.flush?.();
      } catch (_) { /* client may have disconnected */ }
    });
    req.on("close", () => unsubscribe());
  });

  // Preview iframe may request /@react-refresh, /@vite/client etc. with origin-relative URLs; redirect to prefixed path using Referer.
  app.get("/@*", (req: express.Request, res: express.Response) => {
    const referer = (req.headers.referer ?? req.headers.origin ?? "") as string;
    const m = referer.match(/\/api\/preview\/([^/]+)/);
    const workspaceId = m ? m[1]! : null;
    if (!workspaceId) {
      res.status(404).send("Not found");
      return;
    }
    const target = getPreviewTarget(workspaceId);
    if (!target) {
      res.status(404).send("No preview for this workspace");
      return;
    }
    const path = (req.path ?? req.url ?? "").split("?")[0];
    const qs = req.url?.includes("?") ? "?" + req.url.split("?").slice(1).join("?") : "";
    const base = `${req.protocol}://${req.get("host") ?? ""}`;
    const redirectTo = `${base}/api/preview/${workspaceId}${path}${qs}`;
    res.redirect(302, redirectTo);
  });

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
        method: req.method,
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
        const upstream = await fetch(url, { headers: forwardHeaders, redirect: "manual" });

        // Handle redirects from upstream
        if (upstream.status >= 300 && upstream.status < 400) {
          const location = upstream.headers.get("location");
          if (location) {
            // Rewrite the location header to go through the proxy
            const rewrittenLocation = location.startsWith("/")
              ? `${prefix}${location}`
              : location;
            console.log("[preview] rewriting redirect", { from: location, to: rewrittenLocation });
            res.status(upstream.status);
            res.setHeader("Location", rewrittenLocation);
            res.end();
            return;
          }
        }

        if (!upstream.ok) {
          console.warn("[preview] upstream non-OK", { url, status: upstream.status, downstreamPath });
          res.status(upstream.status).end();
          return;
        }
        const ct = (upstream.headers.get("content-type") ?? "").toLowerCase();
        // Fallback to extension-based detection when content-type is missing or incorrect
        const ext = downstreamPath.toLowerCase().split("?")[0].split("#")[0];
        const isHtml = ct.includes("text/html");
        // For extension-based detection, check first - Vite sometimes serves .css with content-type:text/javascript
        const extIsJs = ext.endsWith(".js") || ext.endsWith(".jsx") || ext.endsWith(".ts") || ext.endsWith(".tsx") || ext.endsWith(".mjs") || ext.endsWith(".cjs");
        const extIsCss = ext.endsWith(".css") || ext.endsWith(".scss") || ext.endsWith(".less") || ext.endsWith(".sass");
        // Use extension-based detection when content-type is unreliable (Vite serves CSS as JS for HMR)
        const isJs = (ct.includes("javascript") || ct.includes("ecmascript")) && !extIsCss ||
          extIsJs;
        const isCss = ct.includes("text/css") || extIsCss;

        const isIndexRequest = downstreamPath === "/" || downstreamPath === "" || downstreamPath === "/index.html";
        console.log("[preview] upstream response", {
          downstreamPath,
          contentType: ct.slice(0, 50),
          isHtml,
          isJs,
          isCss,
          isIndexRequest,
          willRewriteHtml: isHtml && isIndexRequest && !!prefix,
          willRewriteJs: isJs && !!prefix,
        });

        if (isHtml && isIndexRequest && prefix) {
          const html = await upstream.text();
          if (!html || html.length === 0) {
            console.error("[preview] empty HTML response from upstream", { url, downstreamPath });
            res.status(502).send("Empty HTML response from dev server");
            return;
          }
          const matchCount = (html.match(/(src|href)\s*=\s*(["'])(\/)(?!\/)([^"']*)["']/g) ?? []).length;
          console.log("[preview] rewriting HTML", { prefix, srcHrefMatchCount: matchCount, htmlLength: html.length, preview: html.slice(0, 200) });
          // Rewrite src/href so absolute paths go through the preview proxy (allow optional whitespace around =)
          let injected = html.replace(
            /(src|href)\s*=\s*(["'])(\/)(?!\/)([^"']*)["']/g,
            (_: string, attr: string, quote: string, _slash: string, pathRest: string) =>
              `${attr}=${quote}${prefix}/${pathRest}${quote}`
          );
          // Also rewrite <base href="/"> tags to use the proxy prefix
          injected = injected.replace(
            /(<base[^>]*\s+href\s*=\s*["'])(\/)(["'])/gi,
            `$1${prefix}/$3`
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
          res.setHeader("Content-Length", Buffer.byteLength(injected, "utf8"));
          // Prevent caching of HTML to ensure fresh requests and proper proxying
          res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
          res.send(injected);
          return;
        }

        if (isJs && prefix) {
          let body = await upstream.text();
          const isViteDep = downstreamPath.startsWith("/node_modules/.vite/deps/");
          const isViteClient = downstreamPath === "/@vite/client";
          // For deps: only rewrite strings that are clearly asset paths (dynamic import URLs), not arbitrary strings (avoids breaking exports like "jsx").
          const rewritePath = (path: string) => {
            if (path.startsWith("/api/preview/")) return path;
            if (isViteClient && (path === "/" || path === "/@vite/client" || path.startsWith("/@vite/client?"))) return path;
            if (isViteDep) return path.startsWith("/node_modules/") || path.startsWith("/@") ? `${prefix}${path}` : path;
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
          // If the file starts with the React Refresh preamble, insert after it so @vitejs/plugin-react can still detect the preamble.
          const isAppEntry =
            downstreamPath === "/src/main.jsx" ||
            downstreamPath === "/src/main.js" ||
            downstreamPath === "/src/main.tsx" ||
            downstreamPath === "/src/main.ts" ||
            downstreamPath === "/src/App.jsx" ||
            downstreamPath === "/src/App.js" ||
            downstreamPath === "/src/App.tsx" ||
            downstreamPath === "/src/App.ts" ||
            downstreamPath === "/src/index.jsx" ||
            downstreamPath === "/src/index.js" ||
            downstreamPath === "/src/index.tsx" ||
            downstreamPath === "/src/index.ts";
          // Match any existing React import (including path aliases, * as React, etc.) to avoid duplicate declaration
          const hasReactImport =
            /import\s+(?:\*\s+as\s+)?React\s+from\s+["']/.test(body) ||
            /from\s*["']react["']/.test(body) ||
            /from\s*["']react\/jsx-runtime["']/.test(body) ||
            body.includes("import React from 'https://esm.sh/react'") ||
            body.includes('import React from "https://esm.sh/react"');
          if (isAppEntry && !hasReactImport) {
            const preambleMatch = body.match(/^(\s*import\s+RefreshRuntime\s+from\s+["']\/@react-refresh["'][^;]*;\s*\n?)/);
            if (preambleMatch) {
              body = preambleMatch[1] + "import React from 'https://esm.sh/react';\n" + body.slice(preambleMatch[1].length);
            } else {
              body = "import React from 'https://esm.sh/react';\n" + body;
            }
          }
          const rewritten = body;
          console.log("[preview] rewriting JS", { prefix, path: downstreamPath, length: body.length });
          res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/javascript");
          res.setHeader("Content-Length", Buffer.byteLength(rewritten, "utf8"));
          res.send(rewritten);
          return;
        }

        if (isCss && prefix) {
          const body = await upstream.text();
          console.log("[preview] rewriting CSS", { prefix, path: downstreamPath, isCss });
          const rewritten = body.replace(/url\((["']?)(\/)(?!\/)/g, `url($1${prefix}$2`);
          res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "text/css");
          res.setHeader("Content-Length", Buffer.byteLength(rewritten, "utf8"));
          res.send(rewritten);
          return;
        }

        console.log("[preview] passthrough (no rewrite)", { downstreamPath, contentType: ct.slice(0, 40), status: upstream.status });
        res.status(upstream.status);
        res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream");
        // Copy other important headers
        const contentLength = upstream.headers.get("content-length");
        if (contentLength) res.setHeader("Content-Length", contentLength);
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
