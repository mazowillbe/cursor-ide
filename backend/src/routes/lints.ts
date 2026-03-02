/**
 * GET /:workspaceId/lints - Run tsc/eslint and return per-file error/warning counts.
 * Used by the file tree to show error badges.
 */
import { Router, type Request, type Response } from "express";
import { execSync } from "child_process";
import path from "path";
import { existsSync } from "fs";
import { workspaceExists, getWorkspacePath, findProjectRoot } from "../workspace.js";

const router = Router();

/** Parse tsc/eslint output into per-file counts. Paths normalized to forward slashes. */
function parseLintOutput(output: string, projectRoot: string): Record<string, { errors: number; warnings: number }> {
  const result: Record<string, { errors: number; warnings: number }> = {};
  const lines = output.split("\n");
  let currentFile = "";

  for (const line of lines) {
    // tsc: "src/App.tsx(10,5): error TS2345: ..." or "src/App.tsx(10,5): warning TS..."
    const tscMatch = line.match(/^([^(]+)\(\d+,\d+\):\s*(error|warning)\s+/i);
    if (tscMatch) {
      const filePath = path.normalize(tscMatch[1]!.trim()).replace(/\\/g, "/");
      const type = tscMatch[2]!.toLowerCase();
      if (!result[filePath]) result[filePath] = { errors: 0, warnings: 0 };
      if (type === "error") result[filePath]!.errors++;
      else result[filePath]!.warnings++;
      continue;
    }

    // eslint: path on own line, then "  line:col  error/warning  ..."
    const pathOnly = line.trim();
    if (pathOnly && !line.startsWith(" ") && !line.startsWith("\t") && (pathOnly.endsWith(".ts") || pathOnly.endsWith(".tsx") || pathOnly.endsWith(".js") || pathOnly.endsWith(".jsx"))) {
      const rel = path.relative(projectRoot, path.resolve(projectRoot, pathOnly)).replace(/\\/g, "/");
      currentFile = rel || pathOnly;
      continue;
    }
    const eslintMatch = line.match(/^\s*\d+:\d+\s+(error|warning)\s+/i);
    if (eslintMatch && currentFile) {
      if (!result[currentFile]) result[currentFile] = { errors: 0, warnings: 0 };
      const type = eslintMatch[1]!.toLowerCase();
      if (type === "error") result[currentFile]!.errors++;
      else result[currentFile]!.warnings++;
    }
  }
  return result;
}

router.get("/:workspaceId/lints", async (req: Request, res: Response): Promise<void> => {
  try {
    const { workspaceId } = req.params;
    if (!workspaceId) {
      res.status(400).json({ error: "workspaceId required" });
      return;
    }
    const exists = await workspaceExists(workspaceId);
    if (!exists) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const workspacePath = getWorkspacePath(workspaceId);
    const projectRoot = findProjectRoot(workspaceId);
    let relProject = path.relative(workspacePath, projectRoot).replace(/\\/g, "/");
    if (relProject.startsWith("./")) relProject = relProject.slice(2);
    // Use tsconfig.app.json when present (Vite projects with references); else default tsconfig
    const appConfig = path.join(projectRoot, "tsconfig.app.json");
    const tscProject = existsSync(appConfig) ? "-p tsconfig.app.json" : "";
    let output = "";
    try {
      output = execSync(`npx tsc ${tscProject} --noEmit 2>&1`.trim(), {
        cwd: projectRoot,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
        stdio: "pipe",
      });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      output = (err.stdout || err.stderr || "").toString();
    }
    const raw = parseLintOutput(output, projectRoot);
    const files: Record<string, { errors: number; warnings: number }> = {};
    for (const [p, counts] of Object.entries(raw)) {
      const fullPath = relProject === "." || !relProject ? p : `${relProject}/${p}`.replace(/\\/g, "/");
      files[fullPath] = counts;
      if (relProject && fullPath !== p) files[p] = counts;
    }
    res.json({ files });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    res.status(500).json({ error: err.message });
  }
});

export default router;
