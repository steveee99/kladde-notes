#!/bin/sh
# Starts the server as the unprivileged "node" user. Started as root (the default), it first
# hands the data volume to that user once: volumes from older versions belong to root.
set -e

DATA_DIR="$(dirname "${DB_PATH:-/app/data/kladde.sqlite}")"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Without CAP_DAC_OVERRIDE root cannot look into the node user's directories: then they are fine already
  if [ -n "$(find "$DATA_DIR" ! -user node -print -quit 2>/dev/null)" ]; then
    chown -R node:node "$DATA_DIR"
  fi
  exec su-exec node "$@"
fi

exec "$@"
