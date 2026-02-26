/**
 * Backend configuration. Use env vars in production.
 */
export const config = {
  port: Number(process.env.PORT) || 3001,
  host: process.env.HOST || "127.0.0.1",
  workspaceRoot: process.env.WORKSPACE_ROOT || "./workspaces",
  openCodePath: process.env.OPENCODE_PATH || "opencode",
  /** Default model for opencode run. Use Gemini (google/...) if you added Gemini API key in opencode auth. */
  openCodeDefaultModel: process.env.OPENCODE_DEFAULT_MODEL || "opencode/minimax-m2.5-free",
  /** Use opencode run --format json for structured tool extraction. Set to false for legacy text mode. */
  openCodeUseJson: true,
  /** Use PTY for opencode (streaming). Set to "0" on Windows if PTY only gives one chunk then hangs; then output will arrive when the run finishes. On Windows we default to no PTY to avoid TTY escape codes and get clean stderr. */
  openCodeUsePty: process.env.OPENCODE_USE_PTY !== "0" && process.platform !== "win32",
  maxWorkspaceAgeMs: Number(process.env.MAX_WORKSPACE_AGE_MS) || 24 * 60 * 60 * 1000,
  /** Allowed CORS origin(s). Comma-separated for multiple. If unset, allows all (origin: true). */
  corsOrigin: process.env.CORS_ORIGIN?.trim() || undefined,
} as const;
