# Deploy cursor-web to Railway

Backend and frontend are configured for Railway via `backend/railway.toml` and `frontend/railway.toml`.

## Troubleshooting: Exit 137 / "Killed"

If you see `[agent] OpenCode process ended, code: 137` or `Killed` in logs, the container ran out of memory (OOM).

**Fix:** In Railway → Backend service → **Settings → Resources**, give the backend **at least 1.5–2 GB** memory. The free tier often has 512MB, which is not enough for OpenCode + Node. Set `NODE_OPTIONS=--max-old-space-size=896` to cap Node's heap and leave room for the rest.

## 1. Create a Railway project

1. Go to [railway.app](https://railway.app) and sign in.
2. **New Project** → **Deploy from GitHub repo** → select your `cursor-web` (or `cursor-ide`) repo.
3. Railway will add one service. We need **two services** (backend + frontend).

## 2. Add the backend service

- If the first service was created from the repo root, either:
  - **Option A:** In that service, open **Settings** → **Source** → set **Root Directory** to `backend`. Rename the service to `cursor-web-backend`.  
  - **Option B:** Delete that service and add a new one: **New** → **GitHub Repo** → same repo, set **Root Directory** to `backend`.
- Backend will use `backend/railway.toml` (Dockerfile). No need to set build/start in the UI.
- In **Variables**, add (same as Render):
  - `NODE_ENV` = `production`
  - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
  - `OPENCODE_ZEN_API_KEY` or `GEMINI_API_KEY`
  - `USE_SUPABASE_FILES` = `true`
  - `NODE_OPTIONS` = `--max-old-space-size=896`
  - `CORS_ORIGIN` = your frontend URL(s), comma-separated — include `http://localhost:5173` when testing with a local frontend (e.g. `https://your-app.onrender.com,http://localhost:5173`)
- **Memory:** The agent spawns `opencode-ai`, which can use several hundred MB. If you see **exit code 137** or "Killed" in logs, the container ran out of RAM. Give the backend service **at least 1.5–2 GB** in Railway (Settings → Resources) for reliable agent runs.
- Deploy. Copy the backend URL (e.g. `https://cursor-web-backend-production-xxx.up.railway.app`).

## 3. Add the frontend service

- In the same project: **New** → **GitHub Repo** → same repo.
- Set **Root Directory** to `frontend**. Rename to `cursor-web-frontend`.
- Frontend will use `frontend/railway.toml` (build + serve).
- In **Variables**, add:
  - `VITE_API_URL` = **your backend URL** from step 2 (e.g. `https://cursor-web-backend-production-xxx.up.railway.app`)
  - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (same as backend Supabase)
- Deploy. Copy the frontend URL.

## 4. Point backend CORS at the frontend

- In the **backend** service → **Variables** → set:
  - `CORS_ORIGIN` = **every URL that serves the frontend**, comma-separated (e.g. `https://cursor-web-frontend-production-xxx.up.railway.app,https://cursor-web-ide.onrender.com,http://localhost:5173`)
- If the frontend is on Render (or another host), add that origin too. Otherwise requests (e.g. `/api/:workspaceId/files/sync`) will be blocked by CORS and you may see 503 or "No 'Access-Control-Allow-Origin' header".
- Redeploy the backend after changing CORS_ORIGIN.

## 5. Deploy from CLI (optional)

After the project and both services exist:

1. Install CLI: `npm i -g @railway/cli`
2. Log in: `railway login`
3. Link: `railway link` (choose the project and environment)
4. Deploy backend: `cd backend && railway up --service cursor-web-backend`
5. Deploy frontend: `cd frontend && railway up --service cursor-web-frontend`

For CI/CD, create a **Project Token** in Railway (Project → Settings → Tokens) and use:

```bash
RAILWAY_TOKEN=<project-token> railway up --service <service-name>
```

---

**Preview HMR:** The app preview iframe may show "[vite] failed to connect to websocket" in the console. The preview still works; you just won’t get hot reload. Use the **Refresh** button on the preview to see changes. WebSocket proxying can fail on some hosting setups.

**Security:** Do not commit `.env` or any file containing tokens. Rotate any token that was ever shared in chat or logs.
