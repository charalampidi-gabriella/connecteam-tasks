# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — installs root + `client` workspace.
- `npm run dev` — runs `wrangler pages dev` on port 8788, which spawns Vite (port 5173) as a proxy target. Functions in `functions/` are served at `/api/*`; everything else is forwarded to Vite for HMR. Hit `http://localhost:8788`, not 5173.
- `npm run dev:client` — Vite alone (no API; useful only for pure-frontend work).
- `npm run build` — Vite production build into `client/dist/`.
- `npm run preview` — build then `wrangler pages dev` against the build output.
- `npm run deploy` — build then `wrangler pages deploy` (requires `wrangler login`; normally Pages auto-deploys from GitHub on push).

`CONNECTEAM_API_KEY` lives in `.dev.vars` (gitignored) for local wrangler dev, and in the Pages dashboard env vars for production. The legacy `.env` is no longer read by anything but is kept as a backup. There are no tests, linter, or typecheck configured.

## Architecture

A calendar view of Connecteam tasks deployed on **Cloudflare Pages**:

- **`client/`** — React/Vite SPA, built into `client/dist`.
- **`functions/`** — Pages Functions handling `/api/*` (boards, board tasks with NDJSON streaming, board labels, users) and a top-level `_middleware.js` gating the entire site behind a shared secret token.

### Connecteam API access pattern

`functions/_lib/connecteam.js` calls `https://api.connecteam.com`:

- Auth via `X-API-KEY` header (`env.CONNECTEAM_API_KEY`).
- Pagination helper that fetches the first page sequentially, then issues subsequent pages in batches of `PAGE_CONCURRENCY=5` × `PAGE_LIMIT=100` until a short page is returned. Connecteam responses wrap the array under `data.<some_key>`, so the helper does `Object.values(body.data)[0]` to extract it.
- Endpoints used: `/tasks/v1/taskboards`, `/tasks/v1/taskboards/{id}/tasks`, `/tasks/v1/taskboards/{id}/labels`, `/users/v1/users`.
- No throttling — relies on Connecteam's normal rate limits and Workers' subrequest cap (50 on free, 1000 on paid).

### Caching

Cloudflare [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) (`caches.default`) with stale-while-revalidate. `cachedJson()` reads via `caches.default.match`, checks a custom `x-expires` header, and on staleness uses `ctx.waitUntil()` to refresh in the background. `?refresh=1` on any endpoint forces a cache bust. The `/api/boards/:id/tasks?stream=1` endpoint streams NDJSON via a `TransformStream` (one JSON page per line) when there is no cached value; it backfills the cache once paginate completes. Default TTL is 10 minutes.

### Access control

`functions/_middleware.js` gates the entire site (SPA + `/api/*`) behind `env.ACCESS_TOKEN`:

- First visit needs `?key=<ACCESS_TOKEN>`. Middleware verifies in constant time, sets a `__Host-`-prefixed `HttpOnly`/`Secure`/`SameSite=Lax` cookie containing the **SHA-256 of the token** (not the raw token, so cookie leak ≠ credential leak), and 302-redirects to the same URL minus the key.
- Subsequent requests validate by cookie. Anything without a valid cookie or token gets a 404 (no auth prompt, no signal that a site exists at that path).
- Cookie has a 1-year `Max-Age`. To revoke access for everyone, rotate `ACCESS_TOKEN` in the Pages dashboard.
- Threat model: this is "secret link" auth, equivalent to a Google Doc set to "anyone with the link". Adequate for low-stakes internal tooling; **not appropriate** for regulated data, customer PII, or any compliance-relevant payload. Considered acceptable here because the data is staff task names + due dates only.

### Client UI conventions

- FullCalendar with `listMonth` as the default view; custom "today" button that scrolls to today's row in list views.
- User filter dropdown is hard-coded to a specific allowlist of first names (Naya, Gaby, Davin, Cici, Jacob, Aldo, Elizabeth, Albert) — non-matching users are hidden from the filter even though all tasks are still loaded. Until a name is picked the dropdown pulses brand-green and a wiggling "pick your name!" pill sits beside it (onboarding hint).
- "Overdue" = `dueDate < now && status !== 'completed' && !isArchived`. The overdue pill toggles a `listYear` view filtered to overdue tasks only. Overdue tasks lacking a `startTime` are surfaced in the default view by pinning their event start to today's midnight.
- Refresh pill triggers a hard refresh by re-fetching with `?refresh=1`.
- Recurring pill opens a side drawer with a hard-coded recurring-tasks table (per-person frequency reference). Closes via X / backdrop click / Escape.
- Today highlighting: list view today rows use brand-green background + brand-navy text + navy left-edge bar; grid views tint the cell green and pill the day-number.
- **Today auto-anchor**: a synthetic invisible "today-marker" event is injected so today's row exists even when the user has no tasks today; an 80vh `padding-bottom` on the list scroller lets today reach the top even near month-end. The pending-scroll flag is set on mount, on `userFilter` change, and on `status` flipping to `ready` — `eventsSet` callback consumes it once per cycle to avoid fighting interactive scrolling during streaming.

### API filter default

`/api/boards/:id/tasks` filters to `status=published` by default unless `?includeCompleted=1` is set.
