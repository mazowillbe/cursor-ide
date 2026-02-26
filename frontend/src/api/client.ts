/** Backend base URL. When VITE_API_URL is set (e.g. on Render), use it; otherwise use relative /api. */
const getApiBase = (): string => {
  const url = import.meta.env.VITE_API_URL;
  if (url && typeof url === "string" && url.trim()) {
    return url.replace(/\/$/, "") + "/api";
  }
  return "/api";
};

const API = getApiBase();

export interface FileNode {
  name: string;
  path: string;
  kind: "file" | "directory";
}

export async function createSession(
  accessToken?: string,
  options?: { newProject?: boolean }
): Promise<{
  workspaceId: string;
  projectName?: string;
}> {
  const headers: HeadersInit = { "Content-Type": "application/json" };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  const body = options?.newProject ? JSON.stringify({ new: true }) : undefined;
  const res = await fetch(`${API}/session`, { method: "POST", headers, body });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const json = JSON.parse(text) as { error?: string };
      if (json?.error) message = json.error;
    } catch {
      /* use text as-is */
    }
    throw new Error(message);
  }
  return res.json();
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
}

export async function listProjects(accessToken: string): Promise<ProjectSummary[]> {
  const res = await fetch(`${API}/projects`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function openProject(
  projectId: string,
  accessToken?: string
): Promise<{ workspaceId: string; projectName: string }> {
  const headers: HeadersInit = {};
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  const res = await fetch(`${API}/session/${projectId}`, { headers });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateProjectName(
  workspaceId: string,
  name: string,
  accessToken: string
): Promise<void> {
  const res = await fetch(`${API}/${workspaceId}/project`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function updateProjectDescription(
  workspaceId: string,
  description: string,
  accessToken: string
): Promise<void> {
  const res = await fetch(`${API}/${workspaceId}/project`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ description }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function cloneRepo(workspaceId: string, url: string): Promise<void> {
  const res = await fetch(`${API}/${workspaceId}/git/clone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const json = JSON.parse(text) as { error?: string };
      if (json?.error) message = json.error;
    } catch {
      /* use text */
    }
    throw new Error(message);
  }
}

export async function listFiles(workspaceId: string, dir = "."): Promise<FileNode[]> {
  const url = `${API}/${workspaceId}/files?dir=${encodeURIComponent(dir)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function readFile(workspaceId: string, path: string): Promise<{ content: string }> {
  const res = await fetch(`${API}/${workspaceId}/file?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function writeFile(
  workspaceId: string,
  path: string,
  content: string
): Promise<void> {
  const res = await fetch(`${API}/${workspaceId}/file`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function createFolder(workspaceId: string, folderPath: string): Promise<void> {
  const res = await fetch(`${API}/${workspaceId}/folder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: folderPath }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function deleteFile(workspaceId: string, path: string): Promise<void> {
  const res = await fetch(`${API}/${workspaceId}/file?path=${encodeURIComponent(path)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await res.text());
}

export interface SearchResult {
  path: string;
  line: number;
  text: string;
}

export async function searchWorkspace(
  workspaceId: string,
  query: string
): Promise<{ results: SearchResult[] }> {
  const res = await fetch(
    `${API}/${workspaceId}/search?q=${encodeURIComponent(query)}`
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  status: string[];
}

export async function getGitStatus(workspaceId: string): Promise<GitStatus> {
  const res = await fetch(`${API}/${workspaceId}/git/status`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function initGitRepo(workspaceId: string): Promise<void> {
  const res = await fetch(`${API}/${workspaceId}/git/init`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
}

/** Ensure workspace has git inited (e.g. after New Workspace). Idempotent. */
export async function ensureGitInWorkspace(workspaceId: string): Promise<void> {
  try {
    await fetch(`${API}/${workspaceId}/git/ensure`);
  } catch {
    // ignore
  }
}

/** Get unified diff for a file (working tree vs HEAD). Returns null if not a repo or no diff. */
export async function getFileDiff(workspaceId: string, path: string): Promise<string | null> {
  const res = await fetch(
    `${API}/${workspaceId}/git/diff?path=${encodeURIComponent(path)}`
  );
  if (!res.ok) return null;
  const { diff } = await res.json();
  return diff != null && typeof diff === "string" ? diff : null;
}

export interface ModelOption {
  id: string;
  label: string;
}

export async function listModels(): Promise<ModelOption[]> {
  const res = await fetch(`${API}/models`);
  if (!res.ok) return [];
  return res.json();
}

export async function generateChatTitle(message: string): Promise<string> {
  const res = await fetch(`${API}/title`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) return message.slice(0, 30) || "New Chat";
  const { title } = await res.json();
  return title || "New Chat";
}

/** Suggest project name if user wants to create a new project. Returns null otherwise. */
export async function suggestProjectName(message: string): Promise<string | null> {
  const res = await fetch(`${API}/project-name`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) return null;
  const { name } = await res.json();
  return name && typeof name === "string" ? name : null;
}

export function getAgentWebSocketUrl(): string {
  const url = import.meta.env.VITE_API_URL;
  if (url && typeof url === "string" && url.trim()) {
    const wsBase = url.replace(/^http/, "ws").replace(/\/$/, "");
    return `${wsBase}/api/agent`;
  }
  if (import.meta.env.DEV) return "ws://127.0.0.1:3001/api/agent";
  const base = window.location.origin.replace(/^http/, "ws");
  return `${base}/api/agent`;
}

/** Request killing a running terminal command (e.g. when user clicks X on the card). */
export async function killCommand(workspaceId: string, callId: string): Promise<boolean> {
  const res = await fetch(`${API}/agent/kill-command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, callId }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  return data?.success === true;
}

/** Returns the current preview URL and port for a workspace if a dev server is registered. */
export async function getPreviewStatus(workspaceId: string): Promise<{ url: string; port: number } | null> {
  const res = await fetch(`${API}/preview/status?workspaceId=${encodeURIComponent(workspaceId)}`);
  if (!res.ok) return null;
  const data = await res.json();
  const url = data?.url && typeof data.url === "string" ? data.url : null;
  const port = typeof data?.port === "number" ? data.port : null;
  if (url && port != null) return { url, port };
  return null;
}

/** Describe one or more images using vision (Gemini). Returns brief text descriptions. */
export async function describeImages(
  images: Array<{ data: string; mimeType?: string }>
): Promise<string[]> {
  const res = await fetch(`${API}/describe-image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ images }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || "Failed to describe images");
  }
  const { descriptions } = await res.json();
  return Array.isArray(descriptions) ? descriptions : [];
}
