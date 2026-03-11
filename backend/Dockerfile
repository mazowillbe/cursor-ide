# -------- Builder Stage --------
FROM node:20-slim AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 make g++ curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

# -------- Production Stage --------
FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates git dumb-init gosu bsdutils curl \
  && rm -rf /var/lib/apt/lists/*

# Install Supabase CLI globally
RUN curl -L https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.tar.gz \
  | tar -xz \
  && mv supabase /usr/local/bin/supabase \
  && chmod +x /usr/local/bin/supabase

# Set working directory
WORKDIR /app

# Copy application
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/opencode-config ./opencode-config
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create non-root user
RUN adduser --disabled-password --gecos "" appuser \
  && mkdir -p /var/data/workspaces \
  && chown -R appuser:appuser /app /var/data

# Environment variables
ENV NODE_ENV=production
ENV WORKSPACE_ROOT=/var/data/workspaces
ENV NODE_OPTIONS="--max-old-space-size=896"
# Global fallback Supabase home
ENV SUPABASE_HOME=/var/data/.supabase

# Ensure global fallback exists
RUN mkdir -p /var/data/.supabase && chown -R appuser:appuser /var/data/.supabase

EXPOSE 3001

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
