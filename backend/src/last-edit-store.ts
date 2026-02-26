/**
 * In-memory store of the last edit_file call per workspace.
 * Used by the reapply tool to call the reapply agent with the same edit intent.
 */

import type { WorkspaceId } from "./types/tools.js";

export interface LastEditRecord {
  target_file: string;
  instructions: string;
  code_edit: string;
}

const lastEditByWorkspace = new Map<WorkspaceId, LastEditRecord>();

export function setLastEdit(workspaceId: WorkspaceId, record: LastEditRecord): void {
  lastEditByWorkspace.set(workspaceId, record);
}

export function getLastEdit(workspaceId: WorkspaceId): LastEditRecord | undefined {
  return lastEditByWorkspace.get(workspaceId);
}
