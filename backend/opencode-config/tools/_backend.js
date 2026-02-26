/**
 * Shared helper for OpenCode custom tools. They call our backend execute-tool API.
 * This file is loaded by tool files; we disable "_backend" in the agent config so it is not exposed as a tool.
 */

/**
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @param {{ callID?: string; callId?: string; id?: string } | undefined} context
 * @returns {Promise<string>}
 */
export async function callBackend(toolName, args, context) {
  const workspaceId = process.env.OPENCODE_WORKSPACE_ID;
  const chatSessionId = process.env.OPENCODE_CHAT_SESSION_ID || undefined;
  const baseUrl = process.env.OPENCODE_BACKEND_URL || "http://127.0.0.1:3001";
  const callId = context?.callID ?? context?.callId ?? context?.id ?? `opencode-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  if (!workspaceId) {
    return JSON.stringify({ success: false, error: "OPENCODE_WORKSPACE_ID not set" });
  }

  const url = `${baseUrl.replace(/\/$/, "")}/api/agent/execute-tool`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId,
      chatSessionId: chatSessionId || undefined,
      callId,
      tool: toolName,
      arguments: args,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (data.success) {
    return typeof data.output === "string" ? data.output : JSON.stringify(data.output ?? "");
  }
  // On failure, return the command/output so the AI sees the actual error (e.g. npm error output)
  const err = data.error || res.statusText || "Tool failed";
  const output = data.output && typeof data.output === "string" ? data.output.trim() : "";
  if (output) return output + (err ? "\n\nError: " + err : "");
  return "Error: " + err;
}
