import { effectiveFilter } from "./convenience.mjs"

const DEFAULT_BATCH_SIZE = 64

const ClientAPI = function (httpApi, batchSize = DEFAULT_BATCH_SIZE) {
  this.httpApi = httpApi
  this.batchSize = batchSize
}

ClientAPI.prototype.sync = async function(since, filter, timeout = 0) {
  const events = {}
  const jobs = {}

  const syncResult = await this.httpApi.sync(since, filter, timeout)

  for (const [roomId, content] of Object.entries(syncResult.rooms?.join)) {
    events[roomId] = content.timeline.events
    if (content.timeline.limited) {
      jobs[roomId] = content.timeline.prev_batch
    }
  }

  const catchUp = await Promise.all(
    Object.entries(jobs).map(([roomId, prev_batch]) => this.catchUp(roomId, since, prev_batch, filter.room?.timeline))
  )
  console.dir(catchUp)
  catchUp.forEach(result => {
    events[result.roomId] = [...events[result.roomId], ...result.events]
  })

  return events
}

ClientAPI.prototype.catchUp = async function (roomId, lastKnownSyncToken, currentSyncToken, filter = {}) {

  const queryOptions = { 
    filter: effectiveFilter(filter),
    dir: 'b', // move backwards on the timeline,
    to: lastKnownSyncToken,
    limit: this.batchSize
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
    console.log(`${roomId} :: fetched ${batch.chunk.length} events from ${pagination.from} to ${pagination.to}`)
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

export {
  ClientAPI
}