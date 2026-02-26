/**
 * Supabase-backed file storage for persistent workspaces.
 * Files are stored in public.files (project_id, path, content, type).
 * We sync to/from disk so run_terminal_cmd (npm, git) can work.
 */

import { createServerClient } from "./lib/supabase/server.js";
import fs from "fs/promises";
import path from "path";

export type ProjectId = string;

export interface FileNode {
  name: string;
  path: string;
  kind: "file" | "directory";
}

/** Sync all files from Supabase to disk. Creates dirs and writes file contents. */
export async function syncSupabaseToDisk(
  projectId: ProjectId,
  diskRoot: string
): Promise<void> {
  const supabase = createServerClient();
  const { data: rows, error } = await supabase
    .from("files")
    .select("path, content, type")
    .eq("project_id", projectId)
    .order("path", { ascending: true });

  if (error) {
    console.warn("[workspace-supabase] sync failed:", error.message);
    return;
  }
  if (!rows || rows.length === 0) return;

  // Create dirs first, then files
  for (const row of rows) {
    const p = path.normalize(row.path).replace(/\\/g, "/");
    const full = path.join(diskRoot, p);
    if (row.type === "directory") {
      await fs.mkdir(full, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, row.content ?? "", "utf-8");
    }
  }
}

/** List direct children of dir. dir="." for root. */
export async function listFilesFromSupabase(
  projectId: ProjectId,
  dir: string
): Promise<FileNode[]> {
  const supabase = createServerClient();
  const { data: rows, error } = await supabase
    .from("files")
    .select("path, type")
    .eq("project_id", projectId);

  if (error) {
    throw new Error(error.message);
  }
  if (!rows || rows.length === 0) return [];

  const dirNorm = path.normalize(dir).replace(/\\/g, "/");
  const isRoot = dirNorm === "." || dirNorm === "";

  const seen = new Set<string>();
  const nodes: FileNode[] = [];

  for (const row of rows) {
    const p = path.normalize(row.path).replace(/\\/g, "/");
    let childName: string | null = null;
    if (isRoot) {
      if (!p.includes("/")) childName = p;
    } else {
      const prefix = dirNorm.endsWith("/") ? dirNorm : dirNorm + "/";
      if (p === dirNorm) continue; // skip the dir itself
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length);
        const firstSegment = rest.split("/")[0];
        if (firstSegment) childName = firstSegment;
      }
    }
    if (childName && !seen.has(childName)) {
      seen.add(childName);
      const childPath = isRoot ? childName : `${dirNorm}/${childName}`;
      nodes.push({
        name: childName,
        path: childPath,
        kind: "file",
      });
    }
  }

  // Fix kind: a path is a dir if it has type directory or any row has path starting with it/
  for (const n of nodes) {
    const exact = rows.find((r) => r.path === n.path);
    const hasChildren = rows.some((r) => r.path.startsWith(n.path + "/"));
    const isDir = exact?.type === "directory" || hasChildren;
    n.kind = isDir ? "directory" : "file";
  }

  return nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** Read file content from Supabase. */
export async function readFileFromSupabase(
  projectId: ProjectId,
  filePath: string
): Promise<string> {
  const supabase = createServerClient();
  const p = path.normalize(filePath).replace(/\\/g, "/");
  const { data, error } = await supabase
    .from("files")
    .select("content")
    .eq("project_id", projectId)
    .eq("path", p)
    .eq("type", "file")
    .single();

  if (error || !data) throw new Error("File not found");
  return data.content ?? "";
}

/** Upsert file to Supabase. */
export async function writeFileToSupabase(
  projectId: ProjectId,
  filePath: string,
  content: string
): Promise<void> {
  const supabase = createServerClient();
  const p = path.normalize(filePath).replace(/\\/g, "/");
  const dirs = getParentPaths(p);
  for (const d of dirs) {
    await supabase.from("files").upsert(
      {
        project_id: projectId,
        path: d,
        content: null,
        type: "directory",
      },
      { onConflict: "project_id,path" }
    );
  }
  const { error } = await supabase.from("files").upsert(
    {
      project_id: projectId,
      path: p,
      content,
      type: "file",
    },
    { onConflict: "project_id,path" }
  );
  if (error) throw new Error(error.message);
}

/** Create directory in Supabase. */
export async function createFolderInSupabase(
  projectId: ProjectId,
  folderPath: string
): Promise<void> {
  const supabase = createServerClient();
  const p = path.normalize(folderPath).replace(/\\/g, "/");
  const dirs = getParentPaths(p);
  dirs.push(p);
  for (const d of dirs) {
    const { error } = await supabase.from("files").upsert(
      {
        project_id: projectId,
        path: d,
        content: null,
        type: "directory",
      },
      { onConflict: "project_id,path" }
    );
    if (error) throw new Error(error.message);
  }
}

/** Delete path from Supabase (and all descendants). */
export async function deletePathFromSupabase(
  projectId: ProjectId,
  filePath: string
): Promise<void> {
  const supabase = createServerClient();
  const p = path.normalize(filePath).replace(/\\/g, "/");
  const prefix = p.endsWith("/") ? p : p + "/";
  const { data: all } = await supabase
    .from("files")
    .select("id, path")
    .eq("project_id", projectId);
  const toDelete = (all ?? []).filter(
    (r) => r.path === p || r.path.startsWith(prefix)
  );
  if (toDelete.length > 0) {
    const ids = toDelete.map((r) => r.id);
    await supabase.from("files").delete().in("id", ids);
  }
}

/** Sync all files from disk to Supabase (e.g. after git clone). */
export async function syncDiskToSupabase(
  projectId: ProjectId,
  diskRoot: string
): Promise<void> {
  const supabase = createServerClient();
  const entries = await walkDisk(diskRoot, "");
  for (const { path: p, content, isDir } of entries) {
    for (const parent of getParentPaths(p)) {
      await supabase.from("files").upsert(
        { project_id: projectId, path: parent, content: null, type: "directory" },
        { onConflict: "project_id,path" }
      );
    }
    if (isDir) {
      await supabase.from("files").upsert(
        { project_id: projectId, path: p, content: null, type: "directory" },
        { onConflict: "project_id,path" }
      );
    } else {
      await supabase.from("files").upsert(
        { project_id: projectId, path: p, content: content ?? "", type: "file" },
        { onConflict: "project_id,path" }
      );
    }
  }
}

async function walkDisk(
  diskRoot: string,
  relDir: string
): Promise<Array<{ path: string; content: string | null; isDir: boolean }>> {
  const HIDDEN = new Set(["node_modules", ".git", "system-prompt.txt", "tools.json", "opencode.json"]);
  const fullDir = path.join(diskRoot, relDir);
  const entries = await fs.readdir(fullDir, { withFileTypes: true }).catch(() => []);
  const out: Array<{ path: string; content: string | null; isDir: boolean }> = [];
  for (const e of entries) {
    if ((e.name.startsWith(".") && e.name !== ".env") || HIDDEN.has(e.name)) continue;
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push({ path: rel, content: null, isDir: true });
      out.push(...(await walkDisk(diskRoot, rel)));
    } else {
      const full = path.join(diskRoot, rel);
      const content = await fs.readFile(full, "utf-8").catch(() => "");
      out.push({ path: rel, content, isDir: false });
    }
  }
  return out;
}

/** Check if project has any files in Supabase. */
export async function projectHasFilesInSupabase(projectId: ProjectId): Promise<boolean> {
  const supabase = createServerClient();
  const { count, error } = await supabase
    .from("files")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .limit(1);
  if (error) return false;
  return (count ?? 0) > 0;
}

/** Get all parent directory paths for a file path. */
function getParentPaths(filePath: string): string[] {
  const parts = filePath.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    out.push(parts.slice(0, i).join("/"));
  }
  return out;
}
