# syntax=docker/dockerfile:1.7
#
# One multi-stage build for every TMS image. Pick one with --target:
#   api      NestJS HTTP API
#   worker   background process (outbox relay, delivery, mailbox) from the API code
#   migrate  one-shot: applies DB migrations, then the idempotent seed
#   web      nginx serving the console and chat widget, proxying /api and /socket.io
#   orbit-desk  nginx serving the Orbit Desk dashboard, proxying /api and /socket.io
#
# Behind a TLS-intercepting proxy, pass its CA as a build secret:
#   docker build --secret id=extra_ca,src=/path/to/ca.pem ...

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# ---- build: install, compile everything, then produce slim per-app bundles ----
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/chat-widget/package.json apps/chat-widget/
COPY apps/web/package.json apps/web/
COPY apps/orbit-desk/package.json apps/orbit-desk/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    corepack prepare --activate && pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
# `pnpm deploy` copies one package with its production dependencies and the
# built output of its workspace dependencies (their `files` field).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm --filter @tms/api deploy --prod /out/api && \
    pnpm --filter @tms/db deploy --prod /out/db

# ---- runtime images ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node

FROM runtime AS api
COPY --from=build --chown=node:node /out/api ./
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# Same code as the API, different entry point (no HTTP server).
FROM runtime AS worker
COPY --from=build --chown=node:node /out/api ./
CMD ["node", "dist/worker.js"]

FROM runtime AS migrate
COPY --from=build --chown=node:node /out/db ./
CMD ["sh", "-c", "node dist/scripts/migrate.js && node dist/scripts/seed.js"]

FROM nginx:1.27-alpine AS web
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY --from=build /repo/apps/chat-widget/dist /usr/share/nginx/html/widget
EXPOSE 80

FROM nginx:1.27-alpine AS orbit-desk
COPY apps/orbit-desk/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/orbit-desk/dist /usr/share/nginx/html
EXPOSE 80
