#!/bin/bash
# Prepares a Claude Code on the web session so lint, typecheck and tests can run.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
pnpm install --frozen-lockfile
pnpm --filter @tms/shared --filter @tms/db build
