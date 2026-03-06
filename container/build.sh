#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="${CONTAINER_IMAGE:-nanoclaw-agent:latest}"

echo "Building NanoClaw agent container: ${IMAGE_NAME}"
docker build \
  -t "${IMAGE_NAME}" \
  -f "${SCRIPT_DIR}/Dockerfile" \
  "${SCRIPT_DIR}"

echo "Build complete: ${IMAGE_NAME}"
echo "To verify: docker run --rm ${IMAGE_NAME} 'opencode --version'"
