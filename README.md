# ticketing-sys
Ticketing System for Companies

## Frontend

A support dashboard and UI element library live in [`frontend/`](frontend/README.md). They follow the style reference in [`DESIGN.md`](DESIGN.md).

### Run with Docker Desktop

```bash
docker compose up -d --build web                  # production build → http://localhost:8080
docker compose --profile dev up --build dev       # hot-reload dev server → http://localhost:5173
```

### Run with Node 22

```bash
cd frontend && npm ci && npm run dev
```

See [`CLAUDE.md`](CLAUDE.md) for the full local workflow, troubleshooting and project conventions.
