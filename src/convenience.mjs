import { powerlevel } from "./powerlevel.mjs"

const effectiveFilter = filter => {
  if (!filter) return
  if (typeof filter === 'string') return filter
  if (typeof filter === 'object') return JSON.stringify(filter)
  return filter
}


const invitedSpaces = invitationRoomState => {

  const invitedSpaces = []
  if (!invitationRoomState) return invitedSpaces

  for (const [roomId, batch] of (Object.entries(invitationRoomState))) {

    if (! batch.invite_state?.events) continue

    const invitation = batch.invite_state.events.reduce((acc, event) => {
      switch (event.type) {
        case 'm.room.create': { acc.type = event.content.type === 'm.space' ? 'space' : 'room' ; break } // should be 'm.space'
        case 'm.room.name': { acc.name = event.content.name; break }
        case 'm.room.canonical_alias': { acc.alias = event.content.alias; break }            
      }          
      return acc
    }, { room_id: roomId })

    invitedSpaces.push(invitation)
  }

  return invitedSpaces
}

const timelineQueryParams = (roomState, filter, limit) => {

  if (roomState.timeline.limited && roomState.timeline.prev_batch) {
    return {
      dir: 'b', // backwards,
      from: roomState.timeline.prev_batch,
      filter,
      limit
    }
  }
}


const roomStateReducer = (acc, event) => {
  switch (event.type) {
    case 'm.room.create': {
      acc.type = (event.content?.type) ? event.content.type : 'm.room'
      acc.id = event.content['io.syncpoint.odin.id']
      acc.creator = event.sender
      break 
    }
    case 'm.room.name': { acc.name = event.content.name; break }
    case 'm.room.canonical_alias': { acc.alias = event.content.canonical_alias; break }
    case 'm.room.topic': { acc.topic = event.content.topic; break }
    case 'm.room.member': { if (acc.members) { acc.members.push(event.state_key) } else { acc['members'] = [event.state_key] }; break }
    case 'm.space.child': { if (acc.children) { acc.children.push(event.state_key) } else { acc['children'] = [event.state_key] }; break }
    case 'm.room.power_levels': { acc.power_levels = event.content; break }
    // case 'io.syncpoint.odin.id': { acc.id = event.content?.id; break }
  }
  return acc
}

const wrap = handler => {
  const proxyHandler = {
    get (target, property) {
      return (property in target && typeof target[property] === 'function') ? target[property] : () => console.error(`HANDLER does not handle ${property}`)
    }
  }
  return new Proxy(handler, proxyHandler)
}

/**
   * @param {Number} retryCounter 
   * @param {Object} signal The signal object of an AbortController
   * @returns A promise that resolves after a calculated time depending on the retryCounter using an exponential back-off algorithm. The max. delay is 30s.
*/
const chill = (retryCounter, signal) => new Promise((resolve, reject) => {

  if (signal?.aborted) return reject(signal.reason)

  const BACKOFF_FACTOR = 0.5
  const BACKOFF_LIMIT = 30_000
  const delay = Math.min(BACKOFF_LIMIT, (retryCounter === 0 ? 0 : BACKOFF_FACTOR * (2 ** (retryCounter)) * 1000))

  let timeout

  const abortHandler = () => {
    signal.removeEventListener('abort', abortHandler)
    clearTimeout(timeout)
    reject(signal.reason)
  }

  timeout = setTimeout(() => {
    signal?.removeEventListener('abort', abortHandler)
    resolve()
  }, delay)

  signal?.addEventListener('abort', abortHandler)  
})

export {
  effectiveFilter,
  invitedSpaces,
  timelineQueryParams,
  roomStateReducer,
  wrap,
  chill
}