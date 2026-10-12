# One-time multi-page scan

Fredy reads **one result page per provider per run**. That is the right default: the newest listings
are on page one, and a scheduled run should stay cheap. It also means a search that has hundreds of
active results only ever surfaces the first page's worth.

The multi-page scan is a **manual, one-time** escape hatch. It walks every result page of a job's
providers and imports the older listings - and it never runs on the scheduler, so ordinary runs are
exactly as fast and as cheap as before.

## Where to trigger it

Two places, both one-time:

1. **Jobs page → the `⋯` menu of a job → "Multi-page scan (one-time)".** Walks every page for that
   job's providers and imports what is missing.
2. **Job create/edit form → "Multi-page scan after saving".** Saving the job also kicks off a single
   scan. The switch is *not* stored on the job - it is a gesture attached to that one save.

Both start a run immediately and report progress through the usual job status (the card's
`RUNNING` chip and the "Job finished" toast).

## What it does (and does not do)

- It walks **all** result pages, not just the first, for the providers that can be paged.
- It **stores** everything it finds, so older listings appear in the listings view and are marked as
  known - the next normal run will not re-notify them.
- It is **silent**: a multi-page import does **not** send notifications, and skips the travel-time
  lookups. A first deep scan finds every older result at once; notifying on all of them would flood
  the channels and burn a routing lookup per listing. The trade-off is that an AI/notification
  pipeline downstream of Fredy's webhook will not see the backfilled listings - only genuinely new
  ones from then on.
- A portal with no page parameter (its result list is a "load more" widget rather than numbered
  pages) degrades to a single page; nothing is guessed.

## Which providers can be paged

The page parameter is the portal's own, so each paged portal is named explicitly in
`lib/services/pagination/paginationService.js` (`MULTIPAGE_PROVIDERS`):

| Provider | Page parameter | Notes |
|---|---|---|
| `immoscout` | `pagenumber` | mobile API; asks for `pagesize=100` |
| `immowelt` | `page` | search BFF, 100 per page |
| `engelVoelkers` | `page` | |
| `kleinanzeigen` | `page` | |
| `sparkasse` | `page` | |
| `immoswp` | `page` | |
| `regionalimmobilien24` | `page` | |
| `ohneMakler` | - | "load more" widget; single page |

Adding a provider is one line in that map. A wrong parameter is not dangerous: the walk stops as
soon as a page contributes nothing new, so a portal that ignores `page` simply stops after page one.

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
