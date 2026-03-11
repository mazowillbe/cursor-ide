#!/bin/sh
set -e

# Ensure workspace root exists and is writable
mkdir -p "$WORKSPACE_ROOT"
chown -R appuser:appuser "$WORKSPACE_ROOT"

# Ensure _template folder exists
mkdir -p "$WORKSPACE_ROOT/_template"
chown -R appuser:appuser "$WORKSPACE_ROOT/_template"

# Ensure global Supabase home exists
mkdir -p "$SUPABASE_HOME"
chown -R appuser:appuser "$SUPABASE_HOME"

# Switch to non-root user
exec gosu appuser "$@"
