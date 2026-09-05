#!/usr/bin/env bash
# Mirrors the "Lint and types" CI job. Run after `pnpm install`.
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm run lint
pnpm run format:check
pnpm run typecheck
