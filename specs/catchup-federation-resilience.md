# catchUp Federation Resilience

## Problem

Two issues with `TimelineAPI.catchUp()`:

1. **Federation lag**: When fetching room history via `/messages` after a join,
   federated servers may not have delivered their events yet. The response
   returns an empty `chunk` but includes an `end` pagination token, indicating
   more events exist. The previous implementation treated this as "done" and
   returned an empty result.

2. **Timeline ordering**: `catchUp()` with `dir='b'` (backwards) returns events
   newest→oldest. The `syncTimeline()` caller appended these events *after* the
   sync timeline events instead of prepending them in reversed order. This broke
   the oldest-first ordering that ODIN depends on for correct operation sequencing.

3. **Page size**: The previous page size of 1000 was unnecessarily large for
   typical ODIN usage patterns.

## Changes

### `timeline-api.mjs` — `catchUp()`

- **Page size**: Reduced from 1000 to 100.
- **Empty response retry**: When `/messages` returns an empty `chunk` but a
  valid `end` token (indicating more events may exist), retry up to 4 times
  with exponential backoff (500ms, 1s, 2s, 4s). The retry counter resets
  when events are successfully received.
- **Graceful exhaustion**: After max retries, log a warning and stop pagination
  (no infinite loop).

### `timeline-api.mjs` — `syncTimeline()`

- **Timeline ordering fix**: Catch-up events (fetched backwards) are now
  reversed to oldest→newest and prepended before the sync timeline events.
  This ensures the full array is in chronological order (oldest first).

### `project.mjs` — `start()` sync-gated check

- **State events check**: The sync-gated content detection now also checks
  `chunk.stateEvents` in addition to `chunk.events`. A room may appear in
  sync with only state events (e.g. the join membership event) but no
  timeline events when the server-side `not_senders` filter excludes the
  joining user's own events.

### E2E Test Cleanup

- **Removed** `content-after-join-high-level.test.mjs` — superseded by
  `content-ordering.test.mjs`.
- **Removed** `content-after-join.test.mjs` — superseded by
  `sync-gated-content.test.mjs`.
- **Rewritten** `project-join-content.test.mjs` — tests the actual ODIN flow:
  immediate `content()` after `joinLayer()` via the high-level MatrixClient API.
- **Added** `content-ordering.test.mjs` — verifies that `content()` returns
  operations in strict chronological order (oldest first) across 5 sequential
  posts.

### Unit Tests

- **Added** `test/catchup.test.mjs` — 8 tests covering: single page, multi-page
  pagination, target token termination, empty responses, federation retry,
  max retry exhaustion, retry counter reset, and parameter passing.

## Test Matrix

| Test File | Scope | E2EE |
|---|---|---|
| `content-ordering.test.mjs` | High-level: ordering oldest-first | No |
| `project-join-content.test.mjs` | High-level: immediate content() after join | No |
| `sync-gated-content.test.mjs` | Low-level: sync-gated plain + E2EE | Both |
| `matrix-client-api.test.mjs` | All layers: E2EE round-trip | Yes |
| `e2ee.test.mjs` | Crypto primitives | Yes |
| `sas-verification.test.mjs` | SAS emoji verification | Yes |
| `test/catchup.test.mjs` | Unit: catchUp pagination + retry | N/A |

## Open Items (not in this PR)

- **Sync-gated content in `Project.start()`**: The `rooms` filter in the
  Project stream does not include newly joined rooms until the next sync poll.
  Combined with `not_senders` filtering out the user's own join event, the
  sync-gated mechanism in `Project.start()` does not reliably detect room
  appearance. A potential fix involves aborting the current long-poll and
  restarting with an updated filter before executing the join — deferred to
  a separate discussion.
