import { chill } from './convenience.mjs'
import { getLogger } from './logger.mjs'

const DEFAULT_POLL_TIMEOUT = 30000

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

  return this.catchUp(roomId, null, null, 'f', filter)
}


TimelineAPI.prototype.syncTimeline = async function(since, filter, timeout = 0) {
  /*
    We want the complete timeline for all rooms that we have already joined. Thus we get the most recent
    events and then iterate over partial results until we filled the gap. The order of the events shall be 
    oldes first. 

    All events regarding invited rooms will not be catched up since we are typically interested in invitations
    and name changes only.
  */

  const events = {}
  // for catching up 
  const jobs = {}

  const syncResult = await this.httpApi.sync(since, filter, timeout)

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

  for (const [roomId, content] of Object.entries(syncResult.rooms?.join || {})) {
    if (content.timeline.events?.length === 0) continue

    events[roomId] = content.timeline.events
    if (content.timeline.limited) {
      jobs[roomId] = content.timeline.prev_batch
    }
  }

  // get the complete timeline for all rooms that we have already joined
  const catchUp = await Promise.all(
    Object.entries(jobs).map(([roomId, prev_batch]) => this.catchUp(roomId, syncResult.next_batch, prev_batch, 'b', filter?.room?.timeline))
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
        if (roomEvents[i].type === 'm.room.encrypted') {
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
    }
  }

  for (const [roomId, content] of Object.entries(syncResult.rooms?.invite || {})) {
    if (content.invite_state.events?.length === 0) continue

    events[roomId] = content.invite_state.events
  }

  return {
    since,
    next_batch: syncResult.next_batch,
    events
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