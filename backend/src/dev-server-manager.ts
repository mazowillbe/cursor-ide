/**
 * Dev server process manager: kill previous dev server before starting a new one per workspace,
 * and detect rebuild output so the preview iframe can auto-reload.
 */

const DEV_SERVER_COMMAND_PATTERNS = [
  /npm\s+run\s+dev\b/i,
  /\bnpm\s+run\s+start\b/i,
  /\byarn\s+(dev|start)\b/i,
  /\bpnpm\s+(dev|run\s+dev|start)\b/i,
  /\bnpx\s+vite\b/i,
  /\bvite\b/i,
  /\bnext\s+dev\b/i,
  /\bng\s+serve\b/i,
  /\bnuxt\s+(dev|run)\b/i,
  /\bwebpack\s+(serve|dev-server)\b/i,
];

const REBUILD_OUTPUT_PATTERNS = [
  /built\s+in\s+/i,
  /hmr\s+update/i,
  /page\s+reload/i,
  /reloading/i,
  /\[vite\]\s+hmr/i,
  /\[vite\]\s+page\s+reload/i,
  /compiled\s+successfully/i,
  /compiled\s+in\s+/i,
  /webpack\s+compiled/i,
  /done\s+in\s+\d+\s*ms/i,
];

const killByWorkspace = new Map<string, () => void>();

/** After this many ms we send initial dev server output to the agent (so it can see and fix console errors). Process keeps running. */
export const DEV_SERVER_INITIAL_OUTPUT_MS = 20_000;

/**
 * Returns true if the command is typically a long-running dev server (npm run dev, vite, etc.).
 */
export function isDevServerCommand(command: string): boolean {
  const c = (command || "").trim();
  if (!c) return false;
  return DEV_SERVER_COMMAND_PATTERNS.some((re) => re.test(c));
}

/**
 * Kill any existing dev server process for this workspace (if we started one).
 * Call before starting a new dev server so only one runs per workspace.
 */
export function killExistingDevServer(workspaceId: string): void {
  const kill = killByWorkspace.get(workspaceId);
  if (kill) {
    try {
      kill();
    } catch (e) {
      console.warn("[dev-server-manager] killExistingDevServer", workspaceId, (e as Error)?.message);
    }
    killByWorkspace.delete(workspaceId);
  }
}

/**
 * Register the kill function for the current dev server process for this workspace.
 * Call after spawning a dev server so we can kill it before the next run.
 */
export function registerDevServerProcess(workspaceId: string, kill: () => void): void {
  killByWorkspace.set(workspaceId, kill);
}

/**
 * Unregister the dev server process when it exits (so we don't hold a stale kill).
 */
export function unregisterDevServerProcess(workspaceId: string): void {
  killByWorkspace.delete(workspaceId);
}

/** Returns true if the command is a build command (e.g. npm run build) that produces dist/. */
export function isBuildCommand(command: string): boolean {
  const c = (command || "").trim().toLowerCase();
  return (
    /npm\s+run\s+build\b/.test(c) ||
    /\b(?:yarn|pnpm)\s+(?:run\s+)?build\b/.test(c) ||
    /\bnpx\s+vite\s+build\b/.test(c) ||
    /\b(?:ng\s+build|next\s+build)\b/.test(c)
  );
}

/**
 * Returns true if the terminal output indicates a rebuild/HMR so the preview can auto-reload.
 */
export function detectRebuildFromOutput(output: string): boolean {
  if (!output || typeof output !== "string") return false;
  return REBUILD_OUTPUT_PATTERNS.some((re) => re.test(output));
}
