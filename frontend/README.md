# Orbit Desk — frontend

The support dashboard and UI element library for the ticketing system. Styled from [`../DESIGN.md`](../DESIGN.md) ("starlit violet cosmos").

Built with Vite, React 19 and TypeScript, styled with CSS Modules, with no UI or chart libraries.

## Run

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build to dist/
```

| Route | What |
| --- | --- |
| `#/` | Overview dashboard: triage summary, KPIs, ticket volume, queue health, ticket queue, activity, team load |
| `#/elements` | Element gallery: color, type scale, buttons, ticket signals, inputs, controls, cards, icons |

Keyboard shortcuts:
- `/` focuses search.
- `Esc` closes the drawer, the dialog or the mobile nav.
- `⌘/Ctrl + Enter` sends a reply.
- Arrow keys step through the chart once it has focus.

## Structure

```
src/
  styles/tokens.css        every design token (colors, type, spacing, radii, inset glows)
  styles/base.css          reset, 400/500 weight clamp, focus ring, reduced motion
  components/ui/           Button, Badge, Card, Input/Search/Select/Textarea, Dialog, Tabs,
                           Avatar(Group), Kbd, Meter, Icon, StatusPill, PriorityGlyph,
                           SlaIndicator, Sparkline, StarField, GradientText, AuroraDivider
  components/layout/       Sidebar, TopBar (floating nav pill), Logo
  features/dashboard/      page sections, TicketDrawer, NewTicketDialog
  features/elements/       the gallery page
  data/                    typed mock data and saved views (swap for an API later)
```

## Design rules the code enforces

- **Weights:** only 400 and 500. `base.css` clamps headings, `b`, `strong` and `th` to 500.
- **Radii:** only 5px (buttons and inputs), 16px (cards), 32px (badges) and 999px (the nav pill). Circles and 2–4px chart data-ends are the only exceptions.
- **Elevation:** inset rim-light glows (`--shadow-lg`, `--shadow-lg-2`, `--shadow-md`) and no drop shadows.
- **No semantic colors.** Ticket status is shown by glyph shape, label and opacity. Priority is signal bars. The lavender accent (`#9382ff`) marks only what needs attention: open tickets, urgent priority, breached SLAs, focus and links.
- **Cosmic gradient:** applied only to text and thin strokes (the triage headline, the logo ring).
- **Iris (`#5046e4`):** used as a fill for exactly one primary action per view ("New ticket"). Everything else uses Deep Indigo `secondary` buttons.
