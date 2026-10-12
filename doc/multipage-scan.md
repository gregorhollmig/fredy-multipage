# One-time multi-page scan

Fredy reads **one result page per provider per run**. That is the right default: the newest listings
are on page one, and a scheduled run should stay cheap. It also means a search that has hundreds of
active results only ever surfaces the first page's worth.

The multi-page scan is a **manual, one-time** escape hatch. It walks every result page of a job's
providers and imports the older listings - and it never runs on the scheduler, so ordinary runs are
exactly as fast and as cheap as before.

## Where to trigger it

Two places, both one-time:

1. **Jobs page → the `⋯` menu of a job → "Multi-page scan (one-time)."** Walks every page for that
   job's providers and imports what is missing. Quiet: it does **not** notify.
2. **Jobs page → the `⋯` menu of a job → "Multi-page backfill (notify)."** The same deep walk, but it
   **sends the fetched backlog to the job's notification channels** (see below).
3. **Job create/edit form → "Multi-page scan after saving".** Saving the job also kicks off a single
   quiet scan. The switch is *not* stored on the job - it is a gesture attached to that one save.

All start a run immediately and report progress through the usual job status (the card's `RUNNING`
chip and the "Job finished" toast).

## Backfill vs. quiet import

The **quiet scan** stores what it finds and stops. This is the safe default for a first deep scan,
because a search with hundreds of results would otherwise notify on all of them at once.

The **backfill (notify)** is the one that hands the backlog to your channels. It notifies *what the
search returned* - after the blacklist and spec filters, but **before** the similarity and area
filters. That last part is the point: the area filter soft-deletes everything outside the job's map
area, and notifying only survivors would drop exactly the listings a backfill exists to deliver.

Consequences worth knowing:

- The backfill sends listings **outside the job's map area** to the channels too (they are still
  hidden in Fredy's own listing list - the filters are unchanged).
- It skips travel-time lookups, so a few hundred listings do not each cost a routing request.
- It does not send listings the blacklist or the spec filter (price/rooms/size) reject.
- Run it once. Repeats re-send the same backlog; a receiver that de-duplicates (like the AI filter in
  the companion project) will skip them, but other channels will not.

## What it does (and does not do)

- It walks **all** result pages, not just the first, for the providers that can be paged.
- It **stores** everything it finds, so older listings appear in the listings view and are marked as
  known - the next normal run will not re-notify them.
- **Quiet scan:** sends no notifications and skips travel-time lookups. A first deep scan finds every
  older result at once, so notifying on all of them at once would flood the channels.
- **Backfill (notify):** sends the fetched backlog to the job's channels (see the section above),
  skipping the travel-time lookups as well.
- A portal with no page parameter (its result list is a "load more" widget rather than numbered
  pages) degrades to a single page; nothing is guessed.

## Which providers can be paged

The page parameter is the portal's own, so each paged portal is named explicitly in
`lib/services/pagination/paginationService.js` (`MULTIPAGE_PROVIDERS`):

| Provider | Page mechanism | Notes |
|---|---|---|
| `immoscout` | `pagenumber` (query) | mobile API; asks for `pagesize=100` |
| `immowelt` | `page` (query) | search BFF, 100 per page; **3 s pause** between pages (its wall answers 403 on a burst) |
| `engelVoelkers` | `page` (query) | |
| `kleinanzeigen` | `/seite:N/` (path) | handled by `kleinanzeigenPageUrl`; a `?page=` parameter is ignored by the portal |
| `sparkasse` | `page` (query) | |
| `immoswp` | `page` (query) | |
| `regionalimmobilien24` | `page` (query) | |
| `ohneMakler`, `mcMakler` | - | "load more" widgets; single page |

Adding a provider is one line in that map. A portal that pages in the path rather than the query
string sets `pageUrl` (a function returning page N's URL) instead of `param`; a portal whose bot wall
reacts to request rate sets `delayMs`. A wrong parameter is not dangerous: the walk stops as soon as
a page contributes nothing new, so a portal that ignores it simply stops after page one.

## Limits

The walk is capped, and the cap is configurable without a code change:

| Env var | Default | Meaning |
|---|---|---|
| `FREDY_MULTIPAGE_MAX_PAGES` | `25` | Hard ceiling on pages per provider. |
| `FREDY_MULTIPAGE_DELAY_MS` | `350` | Pause between two page requests. |

## Build and run

This is a fork of Fredy. Build the image from this repository and run it with the **same
`/conf` and `/db` volumes** as your existing instance - jobs, settings, notes and listings all
live in `/db` and are untouched.

```bash
# from the repository root
docker build -t fredy-multipage .

docker run -d --name fredy \
  -v fredy_conf:/conf \
  -v fredy_db:/db \
  -p 9998:9998 \
  fredy-multipage
```

Or with Compose, replacing the image in `docker-compose.yml` with `fredy-multipage`.

To confirm it is active, enable debug logging in Settings and trigger a scan: the log shows
`Running single job manually: <id> (multi-page scan)` followed by
`Multi-page scan collected <n> raw listing(s) (Provider: '<id>')`.

## How it is wired

| File | Change |
|---|---|
| `lib/services/pagination/paginationService.js` | New. Provider descriptors, the page walk, and the run options. |
| `lib/FredyPipelineExecutioner.js` | Collects pages when the run is a multi-page run; a silent run skips the notification tail. |
| `lib/services/jobs/jobExecutionService.js` | Turns `multiPage` into pipeline options (`silent: true`). |
| `lib/api/routes/jobRouter.js` | Reads `multiPage` on `POST /api/jobs/:id/run`; triggers a scan after `POST /api/jobs` when asked. |
| `lib/services/storage/jobStorage.js` | `upsertJob` now returns the job id (so "create and scan" can trigger the run). |
| `ui/src/components/jobs/JobActions.jsx`, `.../grid/jobs/JobGrid.jsx`, `.../table/JobsTable.jsx` | The one-time action. |
| `ui/src/views/jobs/mutation/JobMutation.jsx` | The "scan after saving" switch. |
| `ui/src/locales/*.json` | Four strings per language. |
