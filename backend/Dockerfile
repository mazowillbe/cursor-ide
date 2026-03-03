# -------- Builder Stage --------
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# -------- Production Stage --------
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git dumb-init gosu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/opencode-config ./opencode-config
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create non-root user
RUN adduser --disabled-password --gecos "" appuser \
  && mkdir -p /var/data/workspaces \
  && chown -R appuser:appuser /app /var/data

ENV NODE_ENV=production
ENV WORKSPACE_ROOT=/var/data/workspaces

EXPOSE 3001

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
