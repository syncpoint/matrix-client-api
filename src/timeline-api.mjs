const DEFAULT_POLL_TIMEOUT = 30000

const TimelineAPI = function (httpApi) {
  this.httpApi = httpApi
}

TimelineAPI.prototype.credentials = function () {
  return this.httpApi.credentials
}

TimelineAPI.prototype.content = async function (roomId, filter) {
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

  for (const [roomId, content] of Object.entries(syncResult.rooms?.join || {})) {
    if (content.timeline.events?.length === 0) continue

    events[roomId] = content.timeline.events
    if (content.timeline.limited) {
      jobs[roomId] = content.timeline.prev_batch
    }
  }

  // get the complete timeline for all rooms that we have already joined
  const catchUp = await Promise.all(
    Object.entries(jobs).map(([roomId, prev_batch]) => this.catchUp(roomId, syncResult.next_batch, prev_batch, filter?.room?.timeline))
  )
  catchUp.forEach(result => {
    events[result.roomId] = [...events[result.roomId], ...result.events]
  })

  // revert order of events to oldest first
  Object.keys(events).forEach(roomId => {
    events[roomId].reverse()
  })

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
  
  /**
   * @param {Number} retryCounter 
   * @returns A promise that resolves after a calculated time depending on the retryCounter using an exponential back-off algorithm. The max. delay is 30s.
   */
  const chill = retryCounter => new Promise((resolve) => {
    const BACKOFF_FACTOR = 0.5
    const BACKOFF_LIMIT = 30_000
    const delay = Math.min(BACKOFF_LIMIT, (retryCounter === 0 ? 0 : BACKOFF_FACTOR * (2 ** (retryCounter)) * 1000))
    setTimeout(() => {
      resolve()
    }, delay);
  })

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