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

Inside the `for await` loop in `start()`, before processing external handlers, check for pending rooms:

```javascript
for await (const chunk of this.stream) {
  // ... error handling, streamToken update (unchanged) ...

  // --- NEW: Sync-gated content fetch for recently joined rooms ---
  for (const roomId of this.pendingContent) {
    const joinData = chunk.events[roomId] || null
    if (!joinData) continue  // Room not yet in sync — keep waiting

    // Room appeared in sync. Fetch full content.
    this.pendingContent.delete(roomId)

    const filter = {
      lazy_load_members: true,
      limit: 1000,
      types: [ODINv2_MESSAGE_TYPE]
      // No not_senders: we need ALL events to reconstruct full layer state
    }

    const content = await this.timelineAPI.content(roomId, filter)
    const operations = content.events
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

The existing `syncTimeline()` in `TimelineAPI` already handles `limited` timelines via `catchUp()`. The `content()` call in the pending handler gets the full history regardless.

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
3. Content includes all events (including own) for full state reconstruction
4. Content is delivered to ODIN via the existing `streamHandler.received()` callback
5. The existing `content()` method continues to work unchanged for hydrate and other callers
6. No hardcoded delays or retry loops for the join → content flow
7. Works with and without E2EE enabled

## Test Plan

1. **Unit test:** Join a room, verify it's added to `pendingContent`
2. **Unit test:** Simulate a sync response containing the room, verify `content()` is called and `pendingContent` is cleared
3. **Unit test:** Verify the content filter does not contain `not_senders`
4. **Integration test:** Join a room via `joinLayer()` while stream is running, verify operations arrive via `received()` handler
5. **Integration test (E2EE):** Same as above with encrypted room, verify operations are decrypted
