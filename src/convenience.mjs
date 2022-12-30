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

export {
  effectiveFilter,
  invitedSpaces,
  timelineQueryParams
}