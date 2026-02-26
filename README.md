# Cursor Web — OpenCode IDE

A production-ready, browser-based AI coding IDE that looks and behaves like [Cursor](https://cursor.com), using [OpenCode](https://opencode.ai/) as the backend AI agent.

## Overview

- **Cursor-style UI**: Left panel (AI chat), center (Monaco editor), right (file tree), bottom (terminal).
- **OpenCode integration**: User prompts are sent to the OpenCode CLI (`opencode run`); output is streamed in real time over WebSockets.
- **Per-session workspaces**: Each session gets an isolated workspace on the server for files and agent runs.
- **File management**: Create, edit, delete files via REST API; file tree and Monaco editor stay in sync.

## Prerequisites

- **Node.js** 18+
- **Supabase** project ([create one](https://supabase.com)) for auth and persistence
- **OpenCode** installed (already done if you ran the project setup):
  ```bash
  npm install -g opencode-ai
  ```

### Using Gemini (or another provider)

This app uses **Gemini** by default if you added your Gemini API key in OpenCode.

1. **Connect OpenCode to Google (Gemini)** — one-time, in a terminal:
   ```bash
   opencode auth login
   ```
   Select **Google** (or the provider that offers Gemini), paste your API key when prompted, and confirm.

2. **Run the app.** The backend uses `google/gemini-2.0-flash` by default. To use a different Gemini model, set the env var (see Configuration):
   ```bash
   OPENCODE_DEFAULT_MODEL=google/gemini-1.5-pro
   ```
   Run `opencode models google` to list available Gemini model IDs.

### Other options: OpenCode Zen (free tier) or local models

- **Zen free models:** Sign up at [opencode.ai/auth](https://opencode.ai/auth), then `opencode auth login` → select OpenCode (Zen). Set `OPENCODE_DEFAULT_MODEL=opencode/minimax-m2.5-free` (or `opencode/glm-5-free`, etc.).
- **Local (no API key):** Install [Ollama](https://ollama.ai), run e.g. `ollama run codellama`, configure OpenCode for the provider, then set `OPENCODE_DEFAULT_MODEL` to that model (e.g. `ollama/codellama`).

## Quick Start

### 1. Supabase setup

1. Create a project at [supabase.com](https://supabase.com)
2. Run the migration: In Supabase Dashboard → SQL Editor, run the contents of `backend/src/lib/supabase/migrations/001_initial_schema.sql`
3. Copy your project URL and keys from Settings → API

### 2. Backend

```bash
cd backend
cp .env.example .env
# Edit .env: add SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
npm install
npm run dev
```

Runs on `http://127.0.0.1:3001` (configurable via `PORT` and `HOST`).

### 3. Frontend

```bash
cd frontend
cp .env.example .env
# Edit .env: add VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

Open `http://localhost:5173`. Sign in or sign up, then the app will create a workspace and load the IDE.

### 4. Use the IDE

- **Chat**: Type a prompt (e.g. "Create a simple Express server in server.js") and press Enter. OpenCode runs in your workspace and streams the response.
- **Files**: Use the file tree to open files; edit in Monaco and click **Save**.
- **Terminal**: Read-only view; agent output is shown in the Chat panel.

## Project Structure

```
cursor-web/
├── backend/           # Node.js agent server
│   ├── src/
│   │   ├── index.ts       # Express + WebSocket server
│   │   ├── agent.ts       # OpenCode CLI runner
│   │   ├── workspace.ts   # Workspace and file APIs
│   │   ├── websocket.ts   # Agent WebSocket handler
│   │   ├── config.ts
│   │   └── routes/
│   └── package.json
├── frontend/          # React + Vite + Monaco + xterm
│   ├── src/
│   │   ├── App.tsx
│   │   ├── api/client.ts
│   │   └── components/
│   │       ├── Layout.tsx
│   │       ├── ChatPanel.tsx
│   │       ├── EditorPanel.tsx
│   │       ├── FileTree.tsx
│   │       └── TerminalPanel.tsx
│   └── package.json
├── instructions.md
└── README.md
```

## Configuration

### Backend (env)

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `3001` |
| `HOST` | Bind address | `127.0.0.1` |
| `WORKSPACE_ROOT` | Directory for workspace folders | `./workspaces` |
| `OPENCODE_PATH` | OpenCode CLI command | `opencode` |
| `OPENCODE_DEFAULT_MODEL` | Default model for agent (e.g. Zen free model) | `opencode/minimax-m2.5-free` |
| `GEMINI_API_KEY` | For edit_file apply agent (Gemini 2.0 Flash) and chat titles | optional |
| `SUPABASE_URL` | Supabase project URL | required |
| `SUPABASE_ANON_KEY` | Supabase anon key (for JWT verification) | required |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (for backend ops) | required |
| `CORS_ORIGIN` | Allowed origin(s), comma-separated (e.g. for Render frontend URL) | optional; if unset, allows all |
| `USE_SUPABASE_FILES` | Set to `true` to persist workspace files to Supabase (enables multi-user on Render) | optional |

### Frontend (env)

| Variable | Description |
|----------|-------------|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key |
| `VITE_API_URL` | Backend URL when frontend is on a different origin (e.g. Render) |

- In development, the Vite dev server proxies `/api` to the backend; the agent WebSocket connects directly to `ws://127.0.0.1:3001`.
- For production, serve the frontend and backend from the same origin (or set your API/WS base URL via env and use it in `src/api/client.ts`).

## Production Build

```bash
# Backend
cd backend && npm run build && npm start

# Frontend
cd frontend && npm run build
```

Serve `frontend/dist` with your static server and ensure API and WebSocket routes point to the backend (e.g. reverse proxy to the same host).

## Deploy to Render (Option B: Backend + Static Site)

1. Push this repo to GitHub and connect it to [Render](https://render.com).
2. Create a new Blueprint from the repo; Render will detect `render.yaml`.
3. Set environment variables in the Render Dashboard for both services:
   - **Backend** (`cursor-web-backend`): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY` (optional), `CORS_ORIGIN` (your frontend URL, e.g. `https://cursor-web-frontend.onrender.com`).
   - **Frontend** (`cursor-web-frontend`): `VITE_API_URL` (your backend URL, e.g. `https://cursor-web-backend.onrender.com`), `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
4. Deploy. After the first deploy, copy the backend URL and set `VITE_API_URL` on the frontend, then redeploy the frontend.

## Architecture

- **Auth**: Supabase Auth (email/password). Users must sign in before using the IDE.
- **REST**: `POST /api/session` (requires `Authorization: Bearer <token>`) creates a project and workspace; `GET/PUT/DELETE /api/:workspaceId/files|file` manage the file tree and content.
- **Persistence**: Projects, chat sessions, and chat messages are stored in Supabase. Files are stored on disk in workspace folders.
- **WebSocket** `ws://host/api/agent`: client sends `{ type: "run", workspaceId, message }`; server runs `opencode run "<message>"` in that workspace and streams stdout/stderr as `{ type: "chunk", data }`; `type: "end"` or `type: "error"` closes the run.
- **OpenCode**: Must be installed and authenticated; the backend spawns it with `opencode run "user message"` in the session workspace directory.

## License

MIT.
