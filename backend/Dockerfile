-------- Builder Stage -------- 

FROM node:20-slim AS builder

node-pty requires native compilation 

RUN apt-get update && apt-get install -y --no-install-recommends 
python3 
make 
g++ 
curl 
ca-certificates 
&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./ RUN npm ci

COPY . . RUN npm run build RUN npm prune --omit=dev

-------- Production Stage -------- 

FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends 
ca-certificates 
git 
dumb-init 
gosu 
bsdutils 
curl 
&& rm -rf /var/lib/apt/lists/*

Install Supabase CLI 

RUN curl -L https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.tar.gz 
| tar -xz 
&& mv supabase /usr/local/bin/supabase 
&& chmod +x /usr/local/bin/supabase

WORKDIR /app

COPY package*.json ./ COPY --from=builder /app/node_modules ./node_modules COPY --from=builder /app/dist ./dist COPY --from=builder /app/opencode-config ./opencode-config COPY docker-entrypoint.sh /usr/local/bin/

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

Create non-root user 

RUN adduser --disabled-password --gecos "" appuser 
&& mkdir -p /var/data/workspaces 
&& chown -R appuser:appuser /app /var/data

ENV NODE_ENV=production ENV WORKSPACE_ROOT=/var/data/workspaces

Keep Node heap under 1GB 

ENV NODE_OPTIONS=--max-old-space-size=896

EXPOSE 3001

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"] CMD ["node", "dist/index.js"]
