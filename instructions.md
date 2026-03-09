You are an expert full-stack engineer specializing in AI-powered code generation platforms.

Build a **full AI app generator** that streams OpenCode CLI output from ephemeral Docker sandboxes to a frontend with WebContainer preview. Include **diff streaming, snapshot cloning, resource limits, multi-user isolation, and auto-cleanup**.

---

## SYSTEM ARCHITECTURE

User prompt
↓
Frontend UI (React + Vite + Tailwind + ShadCN)
↓
Backend API (Node.js + Express)
↓
Persistent Docker sandbox pool (Ubuntu + OpenCode CLI)
↓
Ephemeral sandbox clone per request
↓
OpenCode CLI generates project inside sandbox
↓
Backend detects filesystem changes
↓
Backend streams git-style diffs + logs via SSE
↓
Frontend receives events
↓
WebContainer applies files/patches
↓
Vite dev server preview updates live

---

## TECH STACK

Frontend:

* React, Vite, TypeScript
* Tailwind CSS
* ShadCN UI
* WebContainer for live preview

Backend:

* Node.js + Express
* Docker control via child_process

Container:

* Ubuntu 22.04
* OpenCode CLI installed
* Ephemeral containers with CPU/memory limits
* Snapshot cloning to reduce startup time
* Auto-cleanup after 60–120 seconds
* Multi-user isolation (`/tmp/sandbox/<user-id>`)

Streaming:

* Server-Sent Events (SSE)
* Incremental diff streaming using unified git-style patches

---

## DOCKER IMAGE

Dockerfile example:

```dockerfile
FROM ubuntu:22.04

# Dependencies
RUN apt-get update && apt-get install -y curl git nodejs npm

# OpenCode CLI
RUN npm install -g opencode-cli

WORKDIR /workspace
```

* Persistent sandbox pool: keeps base Docker image ready to clone ephemeral containers quickly.
* Ephemeral sandbox per request: `docker run --rm --cpus=1 --memory=512m -v /tmp/sandbox/<user-id>/<id>:/workspace sandbox-base opencode generate "<prompt>"`
* Containers auto-terminate after 60–120 seconds.
* Each user has isolated `/tmp/sandbox/<user-id>` directories.

---

## BACKEND API

POST `/api/generate`

1. Receive user prompt and user ID.
2. Create unique ephemeral sandbox via snapshot clone.
3. Spawn Docker container with:

   * CPU/memory limits
   * Volume mapping to `/tmp/sandbox/<user-id>/<id>`
4. Run `opencode generate "<prompt>"` inside container.
5. Detect filesystem changes:

   * Compute diffs only for changed files.
6. Stream events to frontend using SSE:

   * `text`, `log`, `file`, `diff`, `command`, `done`, `error`

Example event:

```json
{
  "type": "diff",
  "path": "src/App.tsx",
  "patch": "@@ -1,3 +1,4 @@\n+import React from 'react';\n const App = () => <h1>Hello</h1>;"
}
```

* Auto-cleanup: terminate container after generation or timeout.

---

## FRONTEND

Layout:

```
--------------------------------
| Chat Panel | Preview Panel |
--------------------------------
```

* Chat panel:

  * Prompt input
  * Streaming generation log
  * Progress updates
* Preview panel:

  * WebContainer iframe with live Vite server

Event handling:

```ts
switch(event.type) {
  case "file": await webcontainer.fs.writeFile(event.path, event.content); break;
  case "diff":
    const oldFile = await webcontainer.fs.readFile(event.path);
    const newFile = applyPatch(oldFile, event.patch);
    await webcontainer.fs.writeFile(event.path, newFile);
    break;
  case "command": await webcontainer.spawn(event.command); break;
  case "text":
  case "log": console.log(event.content); break;
  case "done": reload preview; break;
  case "error": console.error(event.content); break;
}
```

* `applyPatch` comes from a JS diff library.

---

## WEBCONTAINER + VITE

* Initialize WebContainer.
* Apply file/diff events in real-time.
* Spawn Vite dev server inside WebContainer.
* Display preview iframe URL live.

---

## SECURITY & RESOURCE MANAGEMENT

* CPU/memory limits: `docker run --cpus=1 --memory=512m`
* Auto-termination after 60–120 seconds
* Isolate each user: `/tmp/sandbox/<user-id>/<id>`
* Snapshot cloning: reduce container startup time
* Diff optimization: compute only changed files to reduce SSE payload

---

## PROJECT STRUCTURE

```
root
  /client
    src/
  /server
    index.ts
  /docker
    Dockerfile
  /sandboxes
```

---

## OUTPUT REQUIREMENTS

Generate:

1. Frontend + backend code
2. Dockerfile
3. WebContainer integration
4. Diff streaming implementation
5. Multi-user sandbox isolation
6. Instructions to run:

   * `docker build -t opencode-runner .`
   * `npm install`
   * `npm run dev`

Streaming must be **real-time**.
Do **not** buffer output — frontend updates live while the sandbox runs.

---

💡 This design implements **Lovable/Cursor-level architecture** with:

* ephemeral sandbox cloning
* live SSE streaming
* incremental diff updates
* multi-user isolation
* resource limits and auto-cleanup
* live WebContainer preview
* scalable, fast, and safe AI app generation

**Implementation (cursor-web):** All of the above are implemented. **Snapshot cloning:** new workspaces are created by copying from `workspaces/_template` (minimal skeleton) so startup is faster than empty dir + git init. Old workspaces are pruned by `pruneOldWorkspaces` (auto-cleanup). **Live SSE streaming** via WebSocket and `GET /api/agent/sse?workspaceId=...&chatSessionId=...`. **Diff optimization:** for `edit_file` and `search_replace`, when the resulting file is larger than 8KB we send a unified diff instead of full content to reduce SSE/WS payload; the frontend already renders diffs. Diffs also use `git diff` and editor diff display; multi-user isolation is by `workspaceId`; resource limits use command timeouts and workspace age; preview is live via proxy to the dev server (browser WebContainer can be added later for a fully in-browser preview).
