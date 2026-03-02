/**
 * In-memory lock to serialize edit_file/search_replace with read_file on the same path.
 * When edit_file or search_replace is running for a path, read_file for that path waits.
 * Prevents the AI from reading stale content when tools run in parallel.
 */

function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, "/");
}

function key(workspaceId: string, filePath: string): string {
  return `${workspaceId}:${normalizePath(filePath)}`;
}

const pendingEdits = new Set<string>();
const waiters = new Map<string, Array<() => void>>();

/** Call when edit_file or search_replace starts. Holds the lock until endEdit. */
export function startEdit(workspaceId: string, filePath: string): void {
  const k = key(workspaceId, filePath);
  pendingEdits.add(k);
}

/** Call when edit_file or search_replace completes. Releases the lock and unblocks waiters. */
export function endEdit(workspaceId: string, filePath: string): void {
  const k = key(workspaceId, filePath);
  pendingEdits.delete(k);
  const resolvers = waiters.get(k);
  if (resolvers) {
    resolvers.forEach((r) => r());
    waiters.delete(k);
  }
}

/** Wait until no edit is in progress for this path. Call before read_file. */
export function waitForEditComplete(workspaceId: string, filePath: string): Promise<void> {
  const k = key(workspaceId, filePath);
  if (!pendingEdits.has(k)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let list = waiters.get(k);
    if (!list) {
      list = [];
      waiters.set(k, list);
    }
    list.push(resolve);
  });
}
