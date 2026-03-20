import { chill } from './convenience.mjs'
import { getLogger } from './logger.mjs'

const DEFAULT_POLL_TIMEOUT = 30000
const M_ROOM_ENCRYPTED = 'm.room.encrypted'

/**
 * Inject 'm.room.encrypted' into a sync filter's types arrays when crypto is active.
 * The server only sees the encrypted envelope type, not the original event type.
 * Without this, all encrypted events would be silently dropped by the server-side filter.
 *
 * Returns a deep-cloned filter with 'm.room.encrypted' added to:
 *   - filter.room.timeline.types (if present)
 *
 * The original types array is preserved as _originalTypes on the timeline object
 * so that post-decryption client-side filtering can re-apply the original type constraint.
 *
 * @param {Object} filter - The sync filter object
 * @returns {Object} The augmented filter (new object, original unchanged)
 */
function augmentFilterForCrypto (filter) {
  if (!filter) return filter

  const augmented = JSON.parse(JSON.stringify(filter))

  const timeline = augmented.room?.timeline
  if (timeline?.types && !timeline.types.includes(M_ROOM_ENCRYPTED)) {
    // Preserve original types for post-decrypt filtering
    timeline._originalTypes = [...timeline.types]
    timeline.types.push(M_ROOM_ENCRYPTED)
  }

  return augmented
}

/**
 * Apply post-decryption type filtering.
 * After decryption, m.room.encrypted events have been replaced with their original type.
 * We need to re-apply the original type constraint because m.room.encrypted is a catch-all —
 * any event type could have been inside.
 *
 * @param {Object[]} roomEvents - Array of (possibly decrypted) events
 * @param {string[]} originalTypes - The original types filter (before crypto augmentation)
 * @returns {Object[]} Filtered events
 */
function applyPostDecryptTypeFilter (roomEvents, originalTypes) {
  if (!originalTypes || originalTypes.length === 0) return roomEvents
  return roomEvents.filter(event => originalTypes.includes(event.type))
}

/**
 * @param {import('./http-api.mjs').HttpAPI} httpApi
 * @param {Object} [options={}] - Optional crypto callbacks
 * @param {Function} [options.onSyncResponse] - async (syncData) => void — feed sync data into crypto
 * @param {Function} [options.decryptEvent]   - async (event, roomId) => decryptedEvent | null
 */
const TimelineAPI = function (httpApi, options = {}) {
  this.httpApi = httpApi
  this.onSyncResponse = options.onSyncResponse || null
  this.decryptEvent = options.decryptEvent || null
}

TimelineAPI.prototype.credentials = function () {
  return this.httpApi.credentials
}

TimelineAPI.prototype.content = async function (roomId, filter, _from) {
  getLogger().debug('Timeline content filter:', JSON.stringify(filter))

  // Augment the filter for crypto: add m.room.encrypted to types
  let effectiveFilter = filter
  let originalTypes = null
  if (this.decryptEvent && filter?.types && !filter.types.includes(M_ROOM_ENCRYPTED)) {
    effectiveFilter = { ...filter, types: [...filter.types, M_ROOM_ENCRYPTED] }
    originalTypes = filter.types
  }

  const result = await this.catchUp(roomId, null, null, 'f', effectiveFilter)

  // Decrypt + post-filter
  if (this.decryptEvent && result.events) {
    for (let i = 0; i < result.events.length; i++) {
      if (result.events[i].type === M_ROOM_ENCRYPTED) {
        const decrypted = await this.decryptEvent(result.events[i], roomId)
        if (decrypted) {
          result.events[i] = decrypted
        }
      }
    }

    if (originalTypes) {
      result.events = applyPostDecryptTypeFilter(result.events, originalTypes)
    }
  }

  return result
}


TimelineAPI.prototype.syncTimeline = async function(since, filter, timeout = 0) {
  /*
    We want the complete timeline for all rooms that we have already joined. Thus we get the most recent
    events and then iterate over partial results until we filled the gap. The order of the events shall be
    oldes first.

    All events regarding invited rooms will not be catched up since we are typically interested in invitations
    and name changes only.
  */

  // When crypto is active, inject 'm.room.encrypted' into the server-side filter
  // so encrypted events are not silently dropped. The original types are preserved
  // for post-decryption client-side filtering.
  const effectiveFilter = this.decryptEvent ? augmentFilterForCrypto(filter) : filter
  const originalTypes = effectiveFilter?.room?.timeline?._originalTypes || null

  const events = {}
  // for catching up
  const jobs = {}

  const syncResult = await this.httpApi.sync(since, effectiveFilter, timeout)

  // Feed crypto state from sync response
  if (this.onSyncResponse) {
    const toDeviceEvents = syncResult.to_device?.events || []
    const deviceLists = syncResult.device_lists || {}
    const oneTimeKeyCounts = syncResult.device_one_time_keys_count || {}
    const unusedFallbackKeys = syncResult.device_unused_fallback_key_types || undefined

    await this.onSyncResponse({ toDeviceEvents, deviceLists, oneTimeKeyCounts, unusedFallbackKeys })
  }

  const stateEvents = {}

  for (const [roomId, content] of Object.entries(syncResult.rooms?.join || {})) {
    // Collect state events (membership changes, power levels, etc.)
    if (content.state?.events?.length) {
      stateEvents[roomId] = content.state.events
    }
    // Also include state events from timeline (Tuwunel puts them there)
    const timelineState = (content.timeline?.events || []).filter(e => 'state_key' in e)
    if (timelineState.length) {
      stateEvents[roomId] = [...(stateEvents[roomId] || []), ...timelineState]
    }

    if (!content.timeline?.events?.length) continue

    events[roomId] = content.timeline.events
    if (content.timeline.limited) {
      jobs[roomId] = content.timeline.prev_batch
    }
  }

  // get the complete timeline for all rooms that we have already joined
  // Use the effective (crypto-augmented) filter for catch-up too
  const catchUp = await Promise.all(
    Object.entries(jobs).map(([roomId, prev_batch]) => this.catchUp(roomId, syncResult.next_batch, prev_batch, 'b', effectiveFilter?.room?.timeline))
  )
  /*
    Since we walk backwards ('b') in time we need to append the events at the head of the array
    in order to maintain the chronological order (oldest first).
  */
  catchUp.forEach(result => {
    events[result.roomId] = [...events[result.roomId], ...result.events]
  })

  // Decrypt encrypted events if crypto is available
  if (this.decryptEvent) {
    for (const [roomId, roomEvents] of Object.entries(events)) {
      for (let i = 0; i < roomEvents.length; i++) {
        if (roomEvents[i].type === M_ROOM_ENCRYPTED) {
          const decrypted = await this.decryptEvent(roomEvents[i], roomId)
          if (decrypted) {
            roomEvents[i] = decrypted
          }
        }
      }

      // Post-decryption type filter: m.room.encrypted is a catch-all on the server side.
      // After decryption, re-apply the original type constraint to ensure only expected
      // event types are passed through (e.g. only io.syncpoint.odin.operation, not arbitrary types).
      if (originalTypes) {
        events[roomId] = applyPostDecryptTypeFilter(roomEvents, originalTypes)
      }
    }
  }

  for (const [roomId, content] of Object.entries(syncResult.rooms?.invite || {})) {
    if (content.invite_state.events?.length === 0) continue

    events[roomId] = content.invite_state.events
  }

  return {
    since,
    next_batch: syncResult.next_batch,
    events,
    stateEvents
  }
}

TimelineAPI.prototype.catchUp = async function (roomId, lastKnownStreamToken, currentStreamToken, dir = 'b', filter = {}) {

  const MAX_EMPTY_RETRIES = 4
  const INITIAL_RETRY_DELAY_MS = 500

  const queryOptions = {
    filter,
    dir,
    to: lastKnownStreamToken,
    limit: 100
  }

  // Properties "from" and "limited" will be modified during catchUp-phase
  const pagination = {
    from: currentStreamToken,
    limited: true
  }

  const log = getLogger()
  let events = []
  let emptyRetries = 0

  while (pagination.limited) {
    const options = {...queryOptions, ...pagination}

    const batch = await this.httpApi.getMessages(roomId, options)
    const hasMore = batch.end && batch.end !== queryOptions.to

    if (batch.chunk.length > 0) {
      events = [...events, ...batch.chunk]
      emptyRetries = 0

      if (hasMore) {
        pagination.from = batch.end
      } else {
        pagination.limited = false
      }
    } else if (hasMore) {
      // Empty chunk but the server signals more events exist.
      // This can happen with federated rooms where the remote server
      // has not yet delivered its events. Retry with exponential backoff.
      emptyRetries++
      if (emptyRetries > MAX_EMPTY_RETRIES) {
        log.warn(`Pagination for room ${roomId}: ${MAX_EMPTY_RETRIES} consecutive empty responses, stopping`)
        pagination.limited = false
      } else {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, emptyRetries - 1)
        log.debug(`Pagination for room ${roomId}: empty chunk with end token, retry ${emptyRetries}/${MAX_EMPTY_RETRIES} in ${delay}ms`)
        await new Promise(resolve => setTimeout(resolve, delay))
        // Retry with the same from-token; do NOT advance pagination.from
      }
    } else {
      // Empty chunk, no end token — we have reached the end.
      pagination.limited = false
    }
  }

  return {
    roomId,
    events
  }
}


TimelineAPI.prototype.stream = async function* (since, filterProvider, signal = (new AbortController()).signal) {



  let streamToken = since
  let retryCounter = 0

  while (!signal.aborted) {
    try {
      await chill(retryCounter)
      const filter = filterProvider ? filterProvider() : undefined
      const syncResult = await this.syncTimeline(streamToken, filter, DEFAULT_POLL_TIMEOUT, signal)
      retryCounter = 0
      if (streamToken !== syncResult.next_batch) {
        streamToken = syncResult.next_batch
        yield syncResult
      }
    } catch (error) {
      retryCounter++
      yield new Error(error)
    }
  }
}

export {
  TimelineAPI
}
