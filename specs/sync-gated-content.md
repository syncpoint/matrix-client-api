# Sync-Gated Content after Join

## Problem

When a user joins a Matrix room via `POST /join`, the server acknowledges the join immediately. However, calling the `/messages` endpoint right after returns an empty result set. The room content only becomes available after the server has fully processed the join — typically within ~1 second, but the actual delay depends on network conditions, server load, federation, and room size.

The current workaround in ODIN is a hardcoded `setTimeout(1000)` before fetching content. This is unreliable: too short for slow servers, unnecessarily slow for fast ones.

## Context

### How Element Web solves this

Element Web never calls `/messages` directly after a join. Instead, it relies on the `/sync` endpoint:

1. After joining, the room appears in the next `/sync` response under `rooms.join`
2. The sync response includes a `timeline.prev_batch` pagination token
3. Only when the user scrolls up does Element call `/messages` using that token

The sync response is the **server's signal** that the room is ready. No guessing, no delays.

### Current architecture in matrix-client-api

- `TimelineAPI.stream()` is a generator that long-polls `/sync` via `syncTimeline()`
- `Project.start()` consumes the stream and dispatches events to handlers
- `Project.joinLayer()` joins a room and returns metadata, but no content
- `Project.content()` fetches historical content via `/messages` (used at hydrate time)
- ODIN calls `joinLayer()` and then `content()` separately — this is where the race happens

### Key insight

`Project.start()` already runs a continuous sync loop. After `joinLayer()`, the next sync cycle will include the newly joined room. We can use this as the trigger to fetch content — no delay, no polling, no guessing.

## Design

### Pending Content Queue

`Project` maintains a `Set` of room IDs that are waiting for their initial content fetch:

```javascript
this.pendingContent = new Set()
```

### Modified `joinLayer()`

After the REST join succeeds:

1. Register the room in `idMapping` (already happens)
2. Register the room as encrypted with CryptoManager if applicable (already happens in `hydrate`, needs to happen here too)
3. Add the room's Matrix ID to `pendingContent`
4. Return layer metadata (no content)

```javascript
Project.prototype.joinLayer = async function (layerId) {
  const upstreamId = this.idMapping.get(layerId) || (Base64.isValid(layerId) ? Base64.decode(layerId) : layerId)

  await this.structureAPI.join(upstreamId)
  const room = await this.structureAPI.getLayer(upstreamId)
  this.idMapping.remember(room.id, room.room_id)

  // Register encryption if applicable
  if (this.cryptoManager && room.encryption) {
    await this.cryptoManager.setRoomEncryption(room.room_id, room.encryption)
  }

  // Mark for content fetch when sync delivers this room
  this.pendingContent.add(room.room_id)

  const layer = { ...room }
  layer.role = {
    self: room.powerlevel.self.name,
    default: room.powerlevel.default.name
  }
  delete layer.powerlevel
  return layer
}
```

### Modified `start()` — internal sync handler

Inside the `for await` loop in `start()`, before processing external handlers, check for pending rooms.

**Important:** The sync response for a newly joined room typically contains 0..n events in `timeline.events` plus a `prev_batch` token. These sync events represent only the most recent slice of the room history. To reconstruct the full layer state, we need **all** events — both the historical ones (before the sync) and the ones delivered in the sync itself.

The approach mirrors what `syncTimeline()` already does for `limited` timelines:

1. Use `prev_batch` from the sync to paginate backwards via `catchUp()` — this yields all events **before** the sync timeline
2. Take the events from the sync timeline itself
3. Combine them in chronological order (oldest first)

This avoids calling `content()` (which fetches forward from the beginning) and prevents duplicate events.

```javascript
for await (const chunk of this.stream) {
  // ... error handling, streamToken update (unchanged) ...

  // --- NEW: Sync-gated content fetch for recently joined rooms ---
  for (const roomId of this.pendingContent) {
    const syncEvents = chunk.events[roomId] || null
    if (!syncEvents) continue  // Room not yet in sync — keep waiting

    // Room appeared in sync. Fetch historical content + combine with sync events.
    this.pendingContent.delete(roomId)

    const filter = {
      lazy_load_members: true,
      limit: 1000,
      types: [ODINv2_MESSAGE_TYPE]
      // No not_senders: we need ALL events to reconstruct full layer state
    }

    // The sync chunk for this room has a prev_batch token (available in
    // the raw sync response). Use it to paginate backwards for all events
    // that came before the sync timeline.
    // Note: syncTimeline() already does catchUp for limited timelines and
    // prepends the result. For pending rooms, the events in chunk.events[roomId]
    // are the sync timeline events. Historical events before prev_batch need
    // to be fetched separately.

    const prevBatch = chunk.prevBatch?.[roomId] || null
    let allEvents = []

    if (prevBatch) {
      // Paginate backwards from prev_batch to get all historical events
      const historical = await this.timelineAPI.catchUp(roomId, null, prevBatch, 'b', filter)
      allEvents = [...historical.events, ...syncEvents]
    } else {
      // No prev_batch — sync events are all there is (e.g. brand-new room)
      allEvents = syncEvents
    }

    // Filter for ODIN operations and decode
    const operations = allEvents
      .filter(event => event.type === ODINv2_MESSAGE_TYPE)
      .map(event => JSON.parse(Base64.decode(event.content.content)))
      .flat()

    if (operations.length > 0) {
      await streamHandler.received({
        id: this.idMapping.get(roomId),
        operations
      })
    }
  }

  // --- Existing handler dispatch (unchanged) ---
  // ...
}
```

### `prev_batch` availability

The raw sync response contains `prev_batch` per room at `rooms.join[roomId].timeline.prev_batch`. Currently, `syncTimeline()` processes limited timelines internally via `catchUp()` but does not expose `prev_batch` per room to the caller.

To make `prev_batch` available in `start()`, `syncTimeline()` must include it in its return value. Options:

1. **Return `prevBatch` map** alongside `events`: `{ next_batch, events, stateEvents, prevBatch: { roomId: token } }`
2. **Only for pending rooms**: Since `syncTimeline()` already handles limited-timeline catch-up, the `prev_batch` is only needed for rooms in `pendingContent` where the standard catch-up may not apply (the room is new to the sync, not a gap in an existing timeline)

Option 1 is simpler and more general. The `prevBatch` map would contain entries for every room that has a `prev_batch` in the sync response.

### `content()` remains unchanged

`Project.content()` and `TimelineAPI.content()` stay as they are. They are still needed for:

- Initial hydrate (project open, layers already joined)
- Any other caller that needs historical content outside the stream context

The sync-gated mechanism is specifically for rooms joined **while the stream is running**.

### Filter considerations

The stream filter in `filterProvider()` uses `not_senders: [self]` to skip own events during normal operation. This is correct for the stream.

The content fetch for pending rooms uses its own filter **without** `not_senders`, because we need all events (including own) to reconstruct full layer state. This is consistent with the existing `Project.content()` filter.

The stream filter also has a `rooms` list built from `idMapping`. Since `joinLayer()` updates `idMapping` before the next sync cycle, the new room will automatically be included in the filter.

### Sync response structure

When a room first appears in a sync response after join, it may contain:

- `timeline.events` — recent events (possibly empty for a brand-new room)
- `timeline.prev_batch` — pagination token for fetching earlier events
- `timeline.limited` — indicates whether the timeline has been truncated
- `state.events` — current room state

For the pending content mechanism, the key fields are:

- **`timeline.events`**: The 0..n most recent events. These are part of the complete history and must be included.
- **`timeline.prev_batch`**: The starting point for backwards pagination. All events before this token must be fetched via `/messages` (i.e., `catchUp()`).

The combination of `catchUp(prev_batch, backwards)` + sync timeline events yields the complete room history.

## E2EE Interaction

This spec explicitly does **not** address E2EE decryption timing. However, the sync-gated approach has a beneficial side effect:

- Historical keys are shared via `to_device` events
- `to_device` events are processed in `receiveSyncChanges()` during each sync cycle
- By the time the room appears in the sync join block, the `to_device` events from the same or preceding sync responses have likely already been processed
- This means the keys are more likely to be available when `content()` decrypts the events

The E2EE decrypt-retry mechanism will be addressed in a separate spec.

## Edge Cases

### Room joined before `start()` is called

Not affected. These rooms are handled by the existing hydrate → `content()` flow.

### Room joined but never appears in sync

The room stays in `pendingContent` indefinitely. This should only happen if the join actually failed server-side. Consider adding a timeout or cleanup mechanism if this becomes a problem in practice.

### Multiple rooms joined rapidly

Each room is tracked independently in `pendingContent`. They may resolve in the same or different sync cycles. No ordering dependency between rooms.

### Re-join after leave

Same flow as a fresh join. `joinLayer()` adds to `pendingContent`, sync triggers content fetch.

## Acceptance Criteria

1. After `joinLayer()`, no direct call to `content()` or `/messages` is made
2. Content is fetched only after the room appears in a sync response
3. Historical content (via `prev_batch` backwards pagination) is combined with sync timeline events in chronological order (oldest first)
4. No duplicate events — historical fetch and sync events do not overlap
5. Content includes all events (including own) for full state reconstruction
6. Content is delivered to ODIN via the existing `streamHandler.received()` callback
7. `syncTimeline()` exposes `prev_batch` per room in its return value
8. The existing `content()` method continues to work unchanged for hydrate and other callers
9. No hardcoded delays or retry loops for the join → content flow
10. Works with and without E2EE enabled

## Test Plan

1. **Unit test:** Join a room, verify it's added to `pendingContent`
2. **Unit test:** Simulate a sync response containing the room, verify `content()` is called and `pendingContent` is cleared
3. **Unit test:** Verify the content filter does not contain `not_senders`
4. **Integration test:** Join a room via `joinLayer()` while stream is running, verify operations arrive via `received()` handler
5. **Integration test (E2EE):** Same as above with encrypted room, verify operations are decrypted
