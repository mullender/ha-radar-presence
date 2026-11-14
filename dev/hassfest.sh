#!/usr/bin/env bash
# Run Home Assistant's hassfest validation (same as the GitHub workflow) in Docker.
# On Apple Silicon the image is amd64-only, so it runs under emulation (~1 min).
set -euo pipefail
cd "$(dirname "$0")/.."
exec docker run --rm --platform linux/amd64 -v "$PWD:/github/workspace:ro" ghcr.io/home-assistant/hassfest
