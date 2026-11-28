#!/usr/bin/env bash
# Builds the Kladde image with the plugins of this repository.
#
#   IMAGE=ghcr.io/<owner>/kladde ./scripts/build-image.sh            Kladde from kladde.version
#   KLADDE_VERSION=v2.29.0 IMAGE=… ./scripts/build-image.sh          try another Kladde version
#   NPMRC=~/.npmrc IMAGE=… ./scripts/build-image.sh                  plugins from a private registry
#   PUSH=1 IMAGE=… ./scripts/build-image.sh                          push the image afterwards
#
# The build stops (and no image is made) when a plugin does not fit this Kladde: the message names the plugin,
# the range it needs and the version Kladde provides.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${KLADDE_VERSION:-$(tr -d '[:space:]' < kladde.version)}"
IMAGE="${IMAGE:?Set IMAGE, e.g. ghcr.io/<owner>/kladde}"
SOURCE="${KLADDE_SOURCE:-https://github.com/steveee99/kladde-notes.git}"
TAG="$VERSION-$(git rev-parse --short HEAD 2>/dev/null || echo local)"

echo "Kladde $VERSION with the plugins of kladde.plugins.json → $IMAGE:$TAG"
rm -rf .build
git clone --quiet --depth 1 --branch "$VERSION" "$SOURCE" .build/kladde
cp kladde.plugins.json .build/kladde/
if [ -d plugins ]; then cp -R plugins/. .build/kladde/plugins/; fi

SECRET=()
if [ -n "${NPMRC:-}" ]; then SECRET=(--secret "id=npmrc,src=$NPMRC"); fi
docker build ${SECRET[@]+"${SECRET[@]}"} -t "$IMAGE:$TAG" -t "$IMAGE:latest" .build/kladde

if [ "${PUSH:-}" = "1" ]; then
  docker push "$IMAGE:$TAG"
  docker push "$IMAGE:latest"
fi
echo "✔ $IMAGE:$TAG"
