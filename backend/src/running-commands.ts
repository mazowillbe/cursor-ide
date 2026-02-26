/**
 * Registry of running terminal commands (workspaceId + callId -> kill function).
 * Used so the frontend can request killing a running command when the user clicks X.
 */

const running = new Map<string, () => void>();

function key(workspaceId: string, callId: string): string {
  return `${workspaceId}:${callId}`;
}

export function registerRunningCommand(workspaceId: string, callId: string, kill: () => void): void {
  running.set(key(workspaceId, callId), kill);
}

export function unregisterRunningCommand(workspaceId: string, callId: string): void {
  running.delete(key(workspaceId, callId));
}

/** Kill the process for this workspace+callId if registered. Returns true if killed. */
export function killRunningCommand(workspaceId: string, callId: string): boolean {
  const k = key(workspaceId, callId);
  const kill = running.get(k);
  if (!kill) return false;
  try {
    kill();
  } catch (e) {
    console.warn("[running-commands] kill failed:", (e as Error)?.message);
  }
  running.delete(k);
  return true;
}
