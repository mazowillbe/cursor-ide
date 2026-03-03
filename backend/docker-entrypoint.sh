#!/bin/sh
set -e
# Ensure workspace dir exists and appuser can write (handles persistent disk mount)
mkdir -p /var/data/workspaces
chown -R appuser:appuser /var/data
exec gosu appuser "$@"
