#!/bin/sh
set -e

# Ensure workspace dir exists and appuser can write
mkdir -p /var/data/workspaces
chown -R appuser:appuser /var/data

# Set workspace ID (fallback to 'default' if not provided)
WORKSPACE_ID=${WORKSPACE_ID:-default}

# Create per-workspace Supabase home
export SUPABASE_HOME="$WORKSPACE_ROOT/$WORKSPACE_ID/.supabase"
mkdir -p "$SUPABASE_HOME"
chown -R appuser:appuser "$SUPABASE_HOME"

# Switch to non-root user and execute the command
exec gosu appuser "$@"
