# ADR 0005: Orbit Desk is the product console

Status: accepted (2026-09-30). This records a decision already made in code (merge `14c3ad3`, wiring `a6516fa`).

## Context

The plan kept the web UI unstyled until a final frontend phase (Phase 11), where it would pick a component library (shadcn/ui + Tailwind or Mantine). In practice a second console was built on its own branch: **Orbit Desk** (`apps/orbit-desk`), styled from `docs/DESIGN.md`. It was merged and wired to the real API, and the E2E suite now covers it.

## Decision

- Orbit Desk is the console agents, leads and admins use. New user-facing features (settings, AI visibility, take-over, approvals, reports, KB search) are built there.
- It uses Vite, React 19, TypeScript and **CSS Modules with design tokens** (`src/styles/tokens.css`). It has no UI kit or chart library, so the design rules in `CLAUDE.md` can be enforced in code: weights 400 and 500, radii 5/16/32/999px, inset glows, no status colours.
- Routing is hash based (`#/`, `#/elements`); a page is a route and a feature folder.
- `apps/web` stays as a barebones test console. It keeps working for API-level checks and the older E2E specs, but gets no new features.
- Both consoles are nginx images from the root `Dockerfile` (ports 8080 and 8081 in Docker) and proxy `/api` and `/socket.io` to the API.

## Consequences

- Phase 11 becomes "finish Orbit Desk" rather than "replace barebones pages".
- Status and AI-versus-human cues have to use glyph shape, label and opacity, never red, green or yellow. This constrains how SLA, AI badges and handover state are drawn.
- Every UI change is checked at about 1440px and 390px with no horizontal scroll and no console errors. The E2E suite fails on unexpected console errors.
