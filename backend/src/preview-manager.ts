/**
 * Preview manager: per-workspace dev server port registry and detection from terminal output.
 * When the agent runs `npm run dev` (e.g. Vite on :5173), we detect the port and expose it
 * via a secure proxy so the frontend can show the app in an iframe.
 */

import * as net from "node:net";

const DEV_SERVER_PATTERNS = [
  // Vite
  /Local:\s*(?:https?:\/\/[^\s]+)?localhost:(\d+)/i,
  /localhost:(\d+)/i,
  /:\/\/127\.0\.0\.1:(\d+)/i,
  // "Dev server running at http://localhost:5174/"
  /(?:dev server|server)\s+(?:running|started|listening)\s+at\s+(?:https?:\/\/)?[^\s]*:(\d+)/i,
  // Common dev servers
  /(?:listen|listening|started|running).*[:\s](\d{4,5})\b/i,
  /(?:port|PORT)\s*[=:]\s*(\d+)/i,
];

/** Max age for a registered port (ms). After this we clear so a new dev server can be detected. */
const PORT_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Ports used by the main cursor-web app (frontend + backend). Never use these for workspace preview. */
const RESERVED_PORTS = new Set([3001, 5173]);

interface PortEntry {
  port: number;
  updatedAt: number;
  /** Resolved host that accepted (127.0.0.1 or ::1) so proxy can use it. */
  host?: string;
}

const portByWorkspace = new Map<string, PortEntry>();

/**
 * Detect a dev server port from terminal/output text (e.g. "Local: http://localhost:5173/").
 * Returns the first port found from known patterns, or null.
 */
export function detectPortFromOutput(text: string): number | null {
  if (!text || typeof text !== "string") return null;
  for (const re of DEV_SERVER_PATTERNS) {
    const m = text.match(re);
    if (m && m[1]) {
      const port = parseInt(m[1], 10);
      if (port >= 1024 && port <= 65535) return port;
    }
  }
  return null;
}

/**
 * Register a port for a workspace (e.g. after detecting from bash output).
 * Never registers reserved ports (main app's frontend/backend) so preview never shows the main app.
 * Returns true if this is a new or updated registration.
 */
export function registerPort(workspaceId: string, port: number): boolean {
  if (RESERVED_PORTS.has(port)) return false;
  const prev = portByWorkspace.get(workspaceId);
  const now = Date.now();
  if (prev && prev.port === port) {
    prev.updatedAt = now;
    return false;
  }
  portByWorkspace.set(workspaceId, { port, updatedAt: now });
  return true;
}

/**
 * Get the current dev server port for a workspace, or null.
 * Returns null if the entry has expired (past PORT_TTL_MS) or is a reserved (main app) port.
 */
export function getPort(workspaceId: string): number | null {
  const entry = portByWorkspace.get(workspaceId);
  if (!entry) return null;
  if (RESERVED_PORTS.has(entry.port)) {
    portByWorkspace.delete(workspaceId);
    return null;
  }
  if (Date.now() - entry.updatedAt > PORT_TTL_MS) {
    portByWorkspace.delete(workspaceId);
    return null;
  }
  return entry.port;
}

/**
 * Get the target host and port for the preview proxy. Uses the resolved host (IPv4/IPv6) if set.
 */
export function getPreviewTarget(workspaceId: string): { host: string; port: number } | null {
  const entry = portByWorkspace.get(workspaceId);
  if (!entry) return null;
  if (RESERVED_PORTS.has(entry.port)) {
    portByWorkspace.delete(workspaceId);
    return null;
  }
  if (Date.now() - entry.updatedAt > PORT_TTL_MS) {
    portByWorkspace.delete(workspaceId);
    return null;
  }
  const host = (entry.host && entry.host.trim()) ? entry.host.trim() : "127.0.0.1";
  return {
    host,
    port: entry.port,
  };
}

/**
 * Set the resolved host for a workspace (after waitForPortReachable). Ensures proxy uses the working address.
 */
export function setPreviewHost(workspaceId: string, host: string): void {
  const entry = portByWorkspace.get(workspaceId);
  if (entry) entry.host = host;
}

/**
 * Clear the preview port for a workspace (e.g. when workspace is closed).
 */
export function clearPort(workspaceId: string): void {
  portByWorkspace.delete(workspaceId);
}

/**
 * Detect port from terminal output and register it for the workspace.
 * Returns the port if newly registered, null otherwise.
 */
export function detectAndRegister(workspaceId: string, output: string): number | null {
  const port = detectPortFromOutput(output);
  if (port == null) return null;
  return registerPort(workspaceId, port) ? port : null;
}

/**
 * Wait until the dev server on the given port is accepting connections (try IPv4 then IPv6).
 * Resolves when one succeeds or after timeoutMs. Returns the host that worked ("127.0.0.1" or "::1") or null.
 */
export function waitForPortReachable(port: number, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const tryConnect = (host: string): Promise<boolean> =>
      new Promise((done) => {
        const socket = new net.Socket();
        const onDone = (ok: boolean) => {
          socket.destroy();
          done(ok);
        };
        socket.setTimeout(2000); // per-attempt timeout so we can retry quickly
        socket.on("connect", () => onDone(true));
        socket.on("error", () => onDone(false));
        socket.on("timeout", () => onDone(false));
        socket.connect(port, host);
      });

    const deadline = Date.now() + timeoutMs;
    const poll = async () => {
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      if (await tryConnect("127.0.0.1")) {
        resolve("127.0.0.1");
        return;
      }
      if (await tryConnect("::1")) {
        resolve("::1");
        return;
      }
      setTimeout(poll, 400);
    };
    poll();
  });
}
