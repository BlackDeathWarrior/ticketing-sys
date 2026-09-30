# CLAUDE.md — ticketing-sys

Orbit Desk is the ticketing system's frontend: a support dashboard plus a UI element library. It lives in `frontend/` and is styled from `DESIGN.md`. It is a static SPA with mock data and no backend yet.

## Local workflow (Docker Desktop)

Prerequisites: Git and Docker Desktop, running. You don't need Node on the host.

```bash
# 1. Clone
git clone https://github.com/BlackDeathWarrior/ticketing-sys.git
cd ticketing-sys
git checkout claude/gifted-clarke-yl2r34   # until it is merged into main

# 2a. Run the production build (nginx) → http://localhost:8080
docker compose up -d --build web

# 2b. OR run the hot-reloading dev server → http://localhost:5173
docker compose --profile dev up --build dev
```

Verify it's up:

```bash
docker compose ps                                          # web shows "(healthy)"
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/   # 200
```

Routes: `#/` is the dashboard; `#/elements` is the element gallery.

Stop and clean up:

```bash
docker compose down                      # stop web
docker compose --profile dev down -v     # stop dev + drop its node_modules volume
```

### How the containers are set up
- **`frontend/Dockerfile`** has four stages:
  - `deps` runs `npm ci` from the lockfile.
  - `dev` runs the Vite dev server.
  - `build` runs `tsc -b` and `vite build`.
  - `prod` serves `dist/` with nginx (config in `frontend/nginx.conf`).
- **`docker-compose.yml` › `web`:** the prod target, served on port `8080:80` with a health check.
- **`docker-compose.yml` › `dev`** (profile `dev`), served on port `5173`:
  - `./frontend` is bind-mounted, so edits on the host hot-reload.
  - An anonymous volume keeps the container's Linux `node_modules`. The host's `node_modules` (macOS/Windows native binaries) is never used.
  - `VITE_USE_POLLING=true` turns on polling file watching, which Windows bind mounts need.

### Troubleshooting
- **Port already in use:** change the left side of the port mapping in `docker-compose.yml` (e.g. `"8081:80"`).
- **Dependencies changed in `package.json`:**
  - For `dev`, rebuild and renew the node_modules volume: `docker compose --profile dev up --build -V dev`.
  - For `web`, a plain `up -d --build web` is enough.
- **Edits don't hot-reload on Windows:** keep the repo inside the WSL2 filesystem (e.g. `\\wsl$\...`), or rely on the polling that is already on.
- **`429 Too Many Requests` from Docker Hub:** run `docker login`, or pull the base images through a mirror and retag them:
  `docker pull mirror.gcr.io/library/node:22-alpine && docker tag mirror.gcr.io/library/node:22-alpine node:22-alpine`. Do the same for `nginx:1.27-alpine`.
- **TLS errors during `npm ci`** usually mean a corporate proxy with its own root CA. Two ways to fix it:
  - Configure the proxy and CA in Docker Desktop (Settings › Resources › Proxies).
  - Or copy the CA into the `deps` stage and set `NODE_EXTRA_CA_CERTS` to it.

## Without Docker

Node 22 (≥ 22.12) is required.

```bash
cd frontend
npm ci
npm run dev        # http://localhost:5173
npm run build      # type-check + production bundle → frontend/dist
```

## Before committing
- `cd frontend && npm run build` must pass. It runs `tsc -b` with strict settings, and there's no separate test suite yet.
- For UI changes, check them in a browser at desktop and phone widths (≈1440px and 390px). Check the Console for errors and make sure nothing scrolls sideways.

## Design rules (from DESIGN.md — keep them)
- **Tokens:** use the variables in `frontend/src/styles/tokens.css`. Never hard-code colors, radii or shadows.
- **Weights:** only 400 and 500, never 600 or above.
- **Radii:** only 5px (buttons/inputs), 16px (cards), 32px (badges) and 999px (the nav pill).
- **Elevation:** inset rim-light glows only, never drop shadows.
- **Accent:** lavender `#9382ff` marks only links, focus, active states and "needs attention".
- **Status:** no red/green/yellow. Status is shown by glyph shape, label and opacity.
- **Gradient:** the cosmic gradient goes only on text and thin strokes.
- **Iris fill:** `#5046e4` is used on at most one primary button per view.

## Code map
- `frontend/src/components/ui/`: reusable elements, exported from `index.ts`.
- `frontend/src/components/layout/`: the Sidebar and the floating TopBar pill.
- `frontend/src/features/dashboard/`: dashboard sections, the ticket drawer and the new-ticket dialog.
- `frontend/src/features/elements/`: the gallery page. Add any new element here too.
- `frontend/src/data/`: typed mock data and saved views. Replace these with API calls when a backend exists.
