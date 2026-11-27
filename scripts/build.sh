#!/usr/bin/env bash
# OrgIQ image build + push.
#
# Usage:
#   ./scripts/build.sh [options] [portal|middleware|all]
#
# Options:
#   --registry REGISTRY   Docker registry prefix (required; or set REGISTRY)
#   --tag TAG             Image tag (default: dev)
#   --push                Push images after building
#   -h, --help            Show this message
#
# Examples:
#   # Build both images locally
#   REGISTRY=local ./scripts/build.sh
#
#   # Build + push with a release tag
#   REGISTRY=ghcr.io/yourname ./scripts/build.sh --push --tag v0.1.0
#
#   # Build portal only
#   REGISTRY=local ./scripts/build.sh portal
#
# Sibling repos required at build time:
#   ../ui-components and ../realtime-modules — committed objects at the package
#   pins must exist locally. Uncommitted sibling output is never packaged.
#
# Run this from the project root (aws-agentcore/).

set -euo pipefail

REGISTRY="${REGISTRY:-}"
TAG="${TAG:-dev}"
PUSH=false
TARGET="all"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry) REGISTRY="$2"; shift 2 ;;
    --tag)      TAG="$2";      shift 2 ;;
    --push)     PUSH=true;     shift   ;;
    portal|middleware|all) TARGET="$1"; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "${REGISTRY}" ]]; then
  echo "No registry given. Set REGISTRY or pass --registry (for example REGISTRY=ghcr.io/yourname)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

node "${PROJECT_ROOT}/scripts/docker/prepare-libraries.mjs"

build_middleware() {
  local image="${REGISTRY}/orgiq-middleware:${TAG}"
  echo
  echo "=== Building ${image} ==="

  docker build \
    --target production \
    --build-context "locked_libraries=${PROJECT_ROOT}/.docker-libraries" \
    -t "${image}" \
    -f "${PROJECT_ROOT}/middleware/Dockerfile" \
    "${PROJECT_ROOT}/middleware/"

  if [[ "${PUSH}" == "true" ]]; then
    echo "=== Pushing ${image} ==="
    docker push "${image}"
  fi
}

build_portal() {
  local image="${REGISTRY}/orgiq-portal:${TAG}"
  echo
  echo "=== Building ${image} ==="

  docker build \
    --target production \
    --build-context "locked_libraries=${PROJECT_ROOT}/.docker-libraries" \
    -t "${image}" \
    -f "${PROJECT_ROOT}/portal/Dockerfile" \
    "${PROJECT_ROOT}/portal/"

  if [[ "${PUSH}" == "true" ]]; then
    echo "=== Pushing ${image} ==="
    docker push "${image}"
  fi
}

case "${TARGET}" in
  portal)     build_portal ;;
  middleware) build_middleware ;;
  all)
    build_portal
    build_middleware
    ;;
esac

echo
echo "Build complete."
if [[ "${PUSH}" == "true" ]]; then
  echo "Pushed to ${REGISTRY}."
fi
echo
echo "Next step — apply CRDs to your cluster:"
echo "  kubectl apply -f k8s/crds/"
