# iGEM Warroom

Local tactical dashboard for the iGEM 2026 competition: an interactive Equal Earth world map with a
marker per team, live-monitoring each team's wiki repository on `gitlab.igem.org`.

## Run

Requires Node.js ≥ 24 (uses the built-in `node:sqlite` and native TypeScript type stripping).

```sh
npm install
npm run build      # build the client once
npm start          # http://127.0.0.1:8787 — server + sync + built client
```

For development with hot reload: `npm run dev` (Vite on http://localhost:5173, proxying `/api` to the server).

Optional configuration: copy `.env.example` to `.env`.

| Variable | Default | |
|---|---|---|
| `GITLAB_TOKEN` | — | Personal access token (`read_api` scope). Raises the API budget well beyond the anonymous 600 req/h. |
| `POLL_INTERVAL_SEC` | 180 | Change-detection interval |
| `HOME_TEAM` | `heidelberg` | Team slug highlighted on the map |
| `WIKI_FREEZE_AT` | `2026-10-21T15:00:00Z` | Countdown target |

## Data sources

- **Team registry** — `api.igem.org/v1/teams?year=2026` (list) and `/teams/:id` (slug, lat/lng, institution).
  Refreshed every 24 h; per-team detail records are re-fetched weekly.
- **Wiki repositories** — `gitlab.igem.org/2026/<slug>`. The `2026` group is hidden from anonymous users,
  but its public projects are discoverable via namespace search and are readable without a token.
- Teams without a public repo (private, not created yet, or non-competition programs) are shown as
  dashed hollow markers.
- **Coordinates** — the registry's are used when they fall inside the team's country (or within 75 km
  of its coast / 25 km of its border; checked against Natural Earth 1:50m outlines). Missing, `0,0`
  placeholder, or out-of-country coordinates are geocoded once via OpenStreetMap Nominatim
  (institution name first, then city) and cached in the `geocode_cache` table. City-level fixes are
  marked "location approximate" in the tooltip.

## Intel: watchlist, villages, breaking news, daily briefing

- **Villages** — each team's iGEM village (thematic judging pool) comes from the team registry. Teams in the
  home team's village are *village rivals*: dashed ring on the map, "My village" leaderboard scope.
- **Watchlist** — "◇ Watch" in a team's dossier subscribes to it (stored server-side in `subscriptions`).
  Watched teams (and the home team) get per-file detail: every commit's diff is fetched once
  (`commit_files`, last 7 days, only while the GitLab budget has headroom) to show which wiki pages and files
  they edit. They get their own dossier in the daily briefing and a lower alert threshold.
- **News desk** (`server/src/intel/breaking.ts`) — scores pushes against thresholds scaled by relation
  (home/watched ×3, village ×2): lines pushed within ~20 min (`BREAKING_LINES`, default 4000), commit bursts
  (20 / 30 min), registry jumps (8 newly published parts), plus wiki-freeze countdown milestones.
  Score ≥ 1 is **BREAKING NEWS** (full-screen intermission: red alarm vignette, banner, ticker, map flies to
  the team with siren rings); ≥ 0.5 is a **FLASH** toast. 2 h cooldown per team and type. Timing uses
  first-seen time, so rebased history doesn't look like a fresh push. "Test alert" in the map legend fires a drill.
- **Daily briefing** (`server/src/intel/briefing.ts`) — published at `BRIEFING_TIME` in `BRIEFING_TZ`
  (default 09:00 Europe/Berlin) covering the preceding 24 h; a missed slot is caught up on startup. Contents:
  headline numbers, the news wire, home dossier, village standings, watchlist dossiers, most active, biggest
  code drops, rank climbers, teams gone quiet, registry publishers, first commits. "Briefing" in the top bar
  opens it (archive + live draft); a new one opens itself.

## Parts registry window

"Parts registry ↗" in the top bar opens `/registry.html` in its own window: per-team published / screening /
draft counts, published 2026 parts with types and lengths, the largest unpublished backlogs, and a live feed of
newly published parts. Selecting a team in either window selects it in the other (`BroadcastChannel`).

Data comes from `api.registry.igem.org` (≈100 requests / 10 min, tracked from its `x-ratelimit-*` headers):

- **Counts** — `/organisations/igem/{teamId}/summary`, the registry's public aggregate per team; refreshed every
  2 h, sooner when a team's parts change. Changes are kept in `reg_summary_history`.
- **Published parts** — `/parts?name=BBa_26` (anonymous callers only receive published parts), fully listed
  daily and polled every 2 min by last update. Each part is attributed to teams once via
  `/parts/{uuid}/authors/organisations`.
- Unpublished parts are represented **only** by the aggregate counts. The per-organisation parts endpoint is
  deliberately not used: it also returns draft contents to anonymous callers.

The first full load (≈460 summaries + ≈970 attributions) takes about 2.5 h; afterwards upkeep is light.

## How syncing works

The anonymous GitLab API budget is **600 requests/hour**, so everything is budget-aware
(`server/src/sources/gitlab.ts` tracks `RateLimit-Remaining`/`RateLimit-Reset`):

1. **Backfill** (once per team, background): full default-branch history with per-commit line stats.
   Pauses when the budget drops to the reserve and resumes after the hourly reset.
2. **Poll** (every 3 min): one query for public projects with `last_activity_after` the previous poll,
   filtered to the `2026/` namespace; only changed teams get their newest commits fetched.
   Polling may dip into the reserved budget.
3. **Sweep** (each poll, if budget allows): re-checks the least recently synced teams, as a safety net
   in case GitLab's `last_activity_at` lags behind a push.

New commits are pushed to the browser over Server-Sent Events (`/api/events`).

Commits up to 5 minutes after a project's creation are the iGEM template, flagged `is_template`
and excluded from all stats. Only the default branch is tracked; timestamps are committer dates.

## Layout

```
server/src/
  sources/   gitlab.ts (rate-limited client), igem.ts (registry), http.ts
  sync/      teams.ts, commits.ts, scheduler.ts
  stats/     aggregate.ts (per-team metrics, heat, ranks, feed)
  routes/    api.ts (REST + SSE)
  cli.ts     npm run sync:teams | sync:commits (manual runs; don't run alongside the server)
client/src/
  map/       WorldMap.tsx (canvas, d3-geo Equal Earth, d3-zoom, quadtree hit-testing), heat.ts
  ui/        Hud, Leaderboard, TeamPanel, LiveFeed, Tooltip, MapLegend, Sparkline
data/        SQLite database (gitignored)
```

## Metrics

- **Heat** — Σ exp(−age / 48 h) over a team's commits; colour on a single-hue amber ramp, log-normalised.
- **Marker size** — area ∝ total team commits.
- **Weekly rhythm** — hour × weekday, shifted from UTC by the team's solar offset (longitude / 15).
