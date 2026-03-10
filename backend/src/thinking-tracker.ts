/**
 * Enforce thinking_tool first: track per workspace whether thinking_tool has been called this run.
 * Reset when a new agent run starts (runOpenCode). Reject non-thinking tools until thinking_tool runs.
 */
const hasCalledThinkingTool = new Map<string, boolean>();

export function resetThinkingToolRequired(workspaceId: string): void {
  hasCalledThinkingTool.set(workspaceId, false);
}

export function markThinkingToolCalled(workspaceId: string): void {
  hasCalledThinkingTool.set(workspaceId, true);
}

export function isThinkingToolRequired(workspaceId: string): boolean {
  return hasCalledThinkingTool.get(workspaceId) === false;
}
