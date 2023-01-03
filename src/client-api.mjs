import { effectiveFilter } from "./convenience.mjs"

// const DEFAULT_BATCH_SIZE = 64
const DEFAULT_POLL_TIMEOUT = 30000

const ClientAPI = function (httpApi) {
  this.httpApi = httpApi
}

ClientAPI.prototype.sync = async function(since, filter, timeout = 0, signal) {
  const events = {}
  const jobs = {}

  const syncResult = await this.httpApi.sync(since, filter, timeout, signal)

  for (const [roomId, content] of Object.entries(syncResult.rooms?.join || {})) {
    if (content.timeline.events?.length === 0) continue

    events[roomId] = content.timeline.events
    if (content.timeline.limited) {
      jobs[roomId] = content.timeline.prev_batch
    }
  }

  try {
    const catchUp = await Promise.all(
      Object.entries(jobs).map(([roomId, prev_batch]) => this.catchUp(roomId, since, prev_batch, filter.room?.timeline))
    )
    catchUp.forEach(result => {
      events[result.roomId] = [...events[result.roomId], ...result.events]
    })
  } catch (error) {
    console.error(error)
  }
  

  return {
    since,
    next_batch: syncResult.next_batch,
    events
  }
}

ClientAPI.prototype.catchUp = async function (roomId, lastKnownSyncToken, currentSyncToken, filter = {}) {

  const queryOptions = { 
    filter: effectiveFilter(filter),
    dir: 'b', // move backwards on the timeline,
    to: lastKnownSyncToken
    /* ,
    limit: this.batchSize */
  }

  // Properties "from" and "limited" will be modified during catchUp-phase
  const pagination = {
    from: currentSyncToken,    
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


ClientAPI.prototype.stream = async function* (since, filter, signal = (new AbortController()).signal) {
  let token
  try {
    const initialSync = await this.sync(since, filter, 0)
    token = initialSync.next_batch
    yield initialSync
  } catch (error) {
    const throwable = new Error(error.message)
    throwable.cause = error
    yield throwable
  }
    
  while (!signal.aborted) {
    try {
      const syncResult = await this.sync(token, filter, DEFAULT_POLL_TIMEOUT, signal)
      if (syncResult.next_batch === token) continue // no new events
      token = syncResult.next_batch
      yield syncResult
    } catch (error) {
      const throwable = new Error(error.message)
      throwable.cause = error
      yield throwable
    }
  }
}

export {
  ClientAPI
}