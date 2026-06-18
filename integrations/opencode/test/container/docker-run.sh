#!/usr/bin/env bash
# Run the e2e container locally.
#
# Usage:
#   ./integrations/opencode/test/container/docker-run.sh [options] [prompt]
#
# Options are passed through to run-e2e.ts. Common ones:
#   --record <name>          Save fixture files to e2e-output/<name>/
#   --mode stub|real|local   LLM mode (default: stub)
#   --model <id>             Model id for real/local mode
#   --scenario <name>        Stub scenario (default: tool-call-then-text)
#   --keep                   Keep sandbox dir (container must not be --rm for this)
#
# Examples:
#   # Basic stub run
#   ./integrations/opencode/test/container/docker-run.sh
#
#   # Record fixtures
#   ./integrations/opencode/test/container/docker-run.sh --record my-run "Fix the clamp bug"
#
#   # Real provider
#   ANTHROPIC_API_KEY=sk-... \
#     ./integrations/opencode/test/container/docker-run.sh \
#     --mode real --model anthropic/claude-haiku-4-5 "Fix the clamp bug"
#
#   # Local model (Ollama)
#   ./integrations/opencode/test/container/docker-run.sh \
#     --mode local --model local/llama3.2 --base-url http://host.docker.internal:11434/v1 \
#     "Fix the clamp bug"

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../" && pwd)"
IMAGE_TAG="${AP_E2E_IMAGE:-ap-e2e:latest}"
OUTPUT_DIR="${AP_E2E_OUTPUT:-${REPO_ROOT}/e2e-output}"

mkdir -p "$OUTPUT_DIR"

echo "[docker-run] building image ${IMAGE_TAG}..."
docker build \
  --file "${REPO_ROOT}/integrations/opencode/test/container/Dockerfile" \
  --tag "${IMAGE_TAG}" \
  "${REPO_ROOT}"

echo "[docker-run] running container..."
docker run --rm \
  --volume "${OUTPUT_DIR}:/output" \
  ${ANTHROPIC_API_KEY:+--env ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"} \
  ${OPENAI_API_KEY:+--env OPENAI_API_KEY="$OPENAI_API_KEY"} \
  "${IMAGE_TAG}" \
  "$@"

echo "[docker-run] done. Output in: ${OUTPUT_DIR}"
