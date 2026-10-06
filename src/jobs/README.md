# Jobs — BullMQ worker process (`pnpm worker`)

One process, two queues, both namespaced by `QUEUE_PREFIX`:

| Queue | File | What |
|---|---|---|
| `upload-extraction` | `extraction.ts` | Spec §8.4: download → validate central directory → verify every playlist reference → stream entries to storage → publish `ready` or roll back. Retries are real (transient faults hand the row back to `queued`), claims are atomic, stuck `processing` rows are reclaimed (`recovery.ts`). |
| `janitor` | `janitor.ts` | Spec §8.5/§7.3: one repeatable sweep every `JANITOR_INTERVAL_MS` (default hourly; `0` disables). Also runnable on demand: `pnpm cli janitor:run`. |

Supporting files: `queue.ts` (queue/worker factories, schedule upsert), `keys.ts` (storage
key layout), `lifecycle.ts` (scratch hygiene, bounded shutdown), `worker.ts` (entrypoint).

## Janitor rules

| Rule | Condition | Action |
|---|---|---|
| Abandoned handshake | `uploading`, created > 7 days ago | delete temp archive, status `failed` (`abandoned`) |
| Expired temp archive | `failed`, last updated > 7 days ago, archive not yet deleted | delete temp archive |
| Never attached | `ready`, no `episode_streams` row, never detached, ready > 14 days | delete media prefix + temp archive, status `failed` (`reclaimed`) |
| Detached | `ready`, no `episode_streams` row, `detached_at` > 30 days ago | same |
| Orphan thumbnail | `images` row > 14 days old whose public path no program/episode/genre `thumbnail_url` ends with | delete object + row |
| Stale scratch | `tplace-upload-*` directory whose newest file is > 6 hours old | remove |
| Partitions | `playback_events_YYYY_MM` for this month and the next 2 | `CREATE TABLE … PARTITION OF` when missing; warn if `playback_events_default` holds rows (see migration 0001 for the recovery) |

Every rule is independent: a failure is reported in the sweep's result and logged, the
others still run. Rows are handled in batches of 200 per rule per sweep.

`detached_at` is written by the catalog module whenever an upload loses its episode
(episode/program delete, angle-set replacement) and cleared when it is re-attached.
