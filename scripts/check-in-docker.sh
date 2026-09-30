#!/usr/bin/env bash
# Runs the CI "check" job (format, lint, build, typecheck, unit and integration
# tests) inside a Linux container against the running compose services.
#
# Use it on hosts where the native toolchain can't run the tests, for example
# Windows machines where @swc/core refuses its cache directory. It tests the
# working tree as git sees it: tracked files with uncommitted edits, plus new
# untracked files, always with LF line endings.
#
#   pnpm infra:up            # or pnpm docker:up
#   bash scripts/check-in-docker.sh            # everything
#   bash scripts/check-in-docker.sh test:int   # just one step
#   RUN='pnpm --filter @tms/api exec vitest run -c vitest.int.config.ts test/kb.int.test.ts' #     bash scripts/check-in-docker.sh build     # steps, then one custom command
#
# Env: TMS_NETWORK (compose network, default tms_default),
#      NODE_IMAGE  (default mirror.gcr.io/library/node:22-bookworm-slim).
set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK=${TMS_NETWORK:-tms_default}
IMAGE=${NODE_IMAGE:-mirror.gcr.io/library/node:22-bookworm-slim}
STEPS=${*:-format:check lint build typecheck test test:int}

docker compose -f infra/docker-compose.yml exec -T postgres \
  sh -c 'psql -U tms -tc "select 1 from pg_database where datname = '"'"'tms_test'"'"'" | grep -q 1 || createdb -U tms tms_test'

# Tracked files as they are in the working tree, via a throwaway stash commit
# (git stores them with LF), plus untracked files that aren't ignored.
tree=$(git stash create 2>/dev/null || true)
tree=${tree:-HEAD}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git -c core.autocrlf=false -c core.eol=lf archive --format=tar "$tree" >"$work/src.tar"
git ls-files -z --others --exclude-standard | tar --null -T - -rf "$work/src.tar"

docker volume create tms-check-pnpm-store >/dev/null
docker run --rm -i --network "$NETWORK" \
  -v tms-check-pnpm-store:/pnpm/store \
  -e CI=true \
  -e TEST_DATABASE_URL=postgres://tms:tms@postgres:5432/tms_test \
  -e TEST_REDIS_URL=redis://redis:6379/15 \
  -e TEST_S3_ENDPOINT=http://objectstore:8333 \
  -e TEST_MAIL_HOST=greenmail \
  -e TEST_LITELLM_URL=http://litellm:4000 \
  -e TEST_FAKE_LLM_URL=http://fake-providers:4010 \
  -e TEST_FAKE_MCP_URL=http://fake-providers:4010/mcp \
  -e STEPS="$STEPS"   -e RUN="${RUN:-}"   -e TEST_LOG_LEVEL="${TEST_LOG_LEVEL:-}" \
  "$IMAGE" bash -euo pipefail -c '
    mkdir -p /repo && tar -xf - -C /repo && cd /repo
    corepack enable >/dev/null 2>&1
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    pnpm config set store-dir /pnpm/store >/dev/null
    pnpm install --frozen-lockfile --reporter=silent
    for step in $STEPS; do
      echo "=== pnpm $step"
      pnpm "$step"
    done
    if [ -n "$RUN" ]; then echo "=== $RUN"; sh -c "$RUN"; fi
  ' <"$work/src.tar"
