// const DEFAULT_BATCH_SIZE = 64
const DEFAULT_POLL_TIMEOUT = 30000

const TimelineAPI = function (httpApi) {
  this.httpApi = httpApi
}

TimelineAPI.prototype.syncTimeline = async function(since, filter, timeout = 0, signal) {
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

TimelineAPI.prototype.catchUp = async function (roomId, lastKnownStreamToken, currentStreamToken, filter = {}) {

  const queryOptions = { 
    filter,
    dir: 'b', // move backwards on the timeline,
    to: lastKnownStreamToken
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


TimelineAPI.prototype.stream = async function* (since, filter, signal = (new AbortController()).signal) {
  let streamToken = since
  
  const initialSync = await this.syncTimeline(since, filter, 0)
  streamToken = initialSync.next_batch
  yield initialSync

  const delay = value => new Promise((resolve) => {
    setTimeout(() => {
      resolve()
    }, value);
  })

  let requestCounter = 1
  let coolOffTime = 0 // time in ms to wait before next try, changed in case of an error
  while (!signal.aborted) {
    try {
      await delay(coolOffTime)
      const syncResult = await this.syncTimeline(streamToken, filter, DEFAULT_POLL_TIMEOUT, signal)
      coolOffTime = 0
      if (streamToken !== syncResult.next_batch) {
        console.log('streamToken changed to ', syncResult.next_batch)
        streamToken = syncResult.next_batch
        console.log('This was request # ', requestCounter)
        requestCounter++
        yield syncResult
      }
    } catch (error) {
      coolOffTime = 30_000
      yield new Error('probably offline')
    }
      
  }
}

export {
  TimelineAPI
}