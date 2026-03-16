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
 * @param {Object} [crypto] - Optional crypto context
 * @param {import('./crypto.mjs').CryptoManager} [crypto.cryptoManager]
 * @param {import('./http-api.mjs').HttpAPI} [crypto.httpAPI]
 */
const TimelineAPI = function (httpApi, crypto) {
  this.httpApi = httpApi
  this.crypto = crypto || null
}

TimelineAPI.prototype.credentials = function () {
  return this.httpApi.credentials
}

TimelineAPI.prototype.content = async function (roomId, filter, from) {
  getLogger().debug('Timeline content filter:', JSON.stringify(filter))

  // Augment the filter for crypto: add m.room.encrypted to types
  let effectiveFilter = filter
  let originalTypes = null
  if (this.crypto && filter?.types && !filter.types.includes(M_ROOM_ENCRYPTED)) {
    effectiveFilter = { ...filter, types: [...filter.types, M_ROOM_ENCRYPTED] }
    originalTypes = filter.types
  }

  const result = await this.catchUp(roomId, null, null, 'f', effectiveFilter)

  // Decrypt + post-filter
  if (this.crypto && result.events) {
    const { cryptoManager } = this.crypto
    const log = getLogger()
    for (let i = 0; i < result.events.length; i++) {
      if (result.events[i].type === M_ROOM_ENCRYPTED) {
        const decrypted = await cryptoManager.decryptRoomEvent(result.events[i], roomId)
        if (decrypted) {
          result.events[i] = {
            ...result.events[i],
            type: decrypted.event.type,
            content: decrypted.event.content,
            decrypted: true
          }
        } else {
          log.warn('Could not decrypt event in room', roomId, result.events[i].event_id)
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
  const effectiveFilter = this.crypto ? augmentFilterForCrypto(filter) : filter
  const originalTypes = effectiveFilter?.room?.timeline?._originalTypes || null

  const events = {}
  // for catching up 
  const jobs = {}

  const syncResult = await this.httpApi.sync(since, effectiveFilter, timeout)

  // Feed crypto state from sync response
  if (this.crypto) {
    const { cryptoManager, httpAPI } = this.crypto
    const toDeviceEvents = syncResult.to_device?.events || []
    const deviceLists = syncResult.device_lists || {}
    const oneTimeKeyCounts = syncResult.device_one_time_keys_count || {}
    const unusedFallbackKeys = syncResult.device_unused_fallback_key_types || undefined

    await cryptoManager.receiveSyncChanges(toDeviceEvents, deviceLists, oneTimeKeyCounts, unusedFallbackKeys)
    await httpAPI.processOutgoingCryptoRequests(cryptoManager)
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
  if (this.crypto) {
    const { cryptoManager } = this.crypto
    const log = getLogger()
    for (const [roomId, roomEvents] of Object.entries(events)) {
      for (let i = 0; i < roomEvents.length; i++) {
        if (roomEvents[i].type === M_ROOM_ENCRYPTED) {
          const decrypted = await cryptoManager.decryptRoomEvent(roomEvents[i], roomId)
          if (decrypted) {
            roomEvents[i] = {
              ...roomEvents[i],
              type: decrypted.event.type,
              content: decrypted.event.content,
              decrypted: true
            }
          } else {
            log.warn('Could not decrypt event in room', roomId, roomEvents[i].event_id)
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

  const queryOptions = { 
    filter,
    dir,
    to: lastKnownStreamToken,
    limit: 1000
  }

  // Properties "from" and "limited" will be modified during catchUp-phase
  const pagination = {
    from: currentStreamToken,    
    limited: true                      
  }

  // The order of events is newest to oldest since we move backwards on the timeline.
  let events = []

  while (pagination.limited) {
    const options = {...queryOptions, ...pagination}

    const batch = await this.httpApi.getMessages(roomId, options)
    events = [...events, ...batch.chunk]
    if (batch.end && batch.end !== pagination.to) {
      pagination.from = batch.end
    } else {
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