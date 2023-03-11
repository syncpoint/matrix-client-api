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
      break 
    }
    case 'm.room.name': { acc.name = event.content.name; break }
    case 'm.room.canonical_alias': { acc.canonical_alias = event.content.alias; break }
    case 'm.room.topic': { acc.topic = event.content.topic; break }
    case 'm.room.member': { if (acc.members) { acc.members.push(event.state_key) } else { acc['members'] = [event.state_key] }; break }
    case 'm.space.child': { if (acc.children) { acc.children.push(event.state_key) } else { acc['children'] = [event.state_key] }; break }
    // case 'io.syncpoint.odin.id': { acc.id = event.content?.id; break }
  }
  return acc
}

export {
  effectiveFilter,
  invitedSpaces,
  timelineQueryParams,
  roomStateReducer
}