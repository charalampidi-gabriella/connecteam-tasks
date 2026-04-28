# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — installs all workspaces (root, `server`, `client`).
- `npm run dev` — runs server (port 3001) and client (Vite, port 5173) concurrently. Vite proxies `/api` → `http://localhost:3001`.
- `npm run dev:server` / `npm run dev:client` — run one side only.
- `npm --workspace client run build` / `... run preview` — production build / preview of the client.

`server/` requires `CONNECTEAM_API_KEY` in `connecteam-tasks/.env` (loaded via `path.resolve(__dirname, "../.env")` from `server/index.js`); the server exits on startup if it is missing. There are no tests, linter, or typecheck configured.

## Architecture

Two parallel deployments of the same feature — a calendar view of Connecteam tasks — sharing no runtime code:

1. **Local dev stack (`server/` + `client/`)** — Express proxy + React/Vite SPA. Used for development.
2. **Apps Script deployment (`apps-script/`)** — single-file Google Apps Script web app (`Code.gs` + `Index.html`). This is the production deployment; the client-side logic in `Index.html` is a hand-rolled rewrite of `client/src/App.jsx` that calls Apps Script `google.script.run` instead of `/api/*`. Keep the two in sync when changing user-visible behavior.

### Connecteam API access pattern (shared between both stacks)

Both `server/index.js` and `apps-script/Code.gs` implement the same pattern against `https://api.connecteam.com`:

- Auth via `X-API-KEY` header.
- Pagination helper that fetches the first page sequentially, then issues subsequent pages in batches of `PAGE_CONCURRENCY` × `PAGE_LIMIT=100` until a short page is returned. Connecteam responses wrap the array under `data.<some_key>`, so both helpers do `Object.values(body.data)[0]` to extract it.
- Endpoints used: `/tasks/v1/taskboards`, `/tasks/v1/taskboards/{id}/tasks`, `/tasks/v1/taskboards/{id}/labels`, `/users/v1/users`.
- **Apps Script throttling**: `PAGE_CONCURRENCY=1` (serial), 250ms inter-page sleep, retry-with-backoff (`INITIAL_BACKOFF_MS=2000`, doubling up to `MAX_BACKOFF_MS=60000`, `MAX_RETRIES=6`) for 429/5xx and any 4xx whose body matches `/bandwidth|quota|rate/i`. This handles Connecteam's per-window bandwidth quota; note that `Exception: Bandwidth quota exceeded` from Apps Script can also indicate Google's own daily `UrlFetchApp` quota (separate from Connecteam's), which only resets at midnight PT.

### Caching

- **Server**: in-memory `Map` with stale-while-revalidate. `cached()` returns stale values immediately and kicks off a background `refresh()`; `?refresh=1` on any endpoint forces a cache bust. The `/api/boards/:id/tasks?stream=1` endpoint streams NDJSON (one JSON page per line) when there is no cached value, so the client can render incrementally.
- **Apps Script**: `CacheService.getScriptCache()` with manual chunking (`CHUNK_MAX_BYTES = 90KB`) because cache entries are size-limited. `cached_()` returns `{ value, stale }` based on `SOFT_TTL_SEC` (1 hour) vs `CACHE_TTL_SEC` (6 hours, the Apps Script max); the client decides whether to call `refreshBootstrap` / `refreshBoardData` / `forceRefreshBoardData` based on `stale`. TTLs were bumped from 5min/30min to reduce daily UrlFetchApp bandwidth consumption.

### Client UI conventions (both `App.jsx` and `Index.html`)

- FullCalendar with `listMonth` as the default view; custom "today" button that scrolls to today's row in list views.
- User filter dropdown is hard-coded to a specific allowlist of first names (Naya, Gaby, Davin, Cici, Jacob, Aldo, Elizabeth, Albert) — non-matching users are hidden from the filter even though all tasks are still loaded.
- "Overdue" = `dueDate < now && status !== 'completed' && !isArchived`. The overdue pill toggles a `listYear` view filtered to overdue tasks only. Overdue tasks lacking a `startTime` are surfaced in the default view by pinning their event start to today's midnight.
- Refresh pill triggers a hard refresh by re-fetching with `?refresh=1` (server) / calling `forceRefreshBoardData` (Apps Script).
- Recurring pill opens a side drawer with a hard-coded recurring-tasks table (per-person frequency reference). Closes via X / backdrop click / Escape.
- Today highlighting: list view today rows use brand-green background + brand-navy text + navy left-edge bar; grid views tint the cell green and pill the day-number.
- **Today auto-anchor (App.jsx specifics)**: a synthetic invisible "today-marker" event is injected so today's row exists even when the user has no tasks today; an 80vh `padding-bottom` on the list scroller lets today reach the top even near month-end. The pending-scroll flag is set on mount, on `userFilter` change, and on `status` flipping to `ready` — `eventsSet` callback consumes it once per cycle to avoid fighting interactive scrolling during streaming.

### Server-side filter difference (intentional but undocumented)

`/api/boards/:id/tasks` filters to `status=published` by default unless `?includeCompleted=1` is set. The Apps Script equivalent returns all statuses. If a task is missing locally compared to production, this is likely why.

### Apps Script auth

`Code.gs` `doGet()` gates access by email against `ALLOWED_EMAILS` (currently `manager@rippnertennis.com`, `hddavino@gmail.com`). The web app is deployed with `executeAs: USER_ACCESSING` and `access: ANYONE`, so this allowlist is the only access control — and is required, since `executeAs: OWNER` would make `Session.getActiveUser().getEmail()` return empty string for accessors outside the owner's Workspace domain (e.g. `hddavino@gmail.com`), locking them out. The `CONNECTEAM_API_KEY` lives in Script Properties, not in source. Script owner is `manager@rippnertennis.com`.
