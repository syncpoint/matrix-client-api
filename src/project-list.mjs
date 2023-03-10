
const wrap = handler => {
  const proxyHandler = {
    get (target, property) {
      return (property in target && typeof target[property] === 'function') ? target[property] : () => console.error(`HANDLER does not handle ${property}`)
    }
  }
  return new Proxy(handler, proxyHandler)
}


/**
 * 
 * @param {MatrixAPI} matrixAPI 
 */
const ProjectList = function ({ structureAPI, timelineAPI }) {
  this.structureAPI = structureAPI
  this.timelineAPI = timelineAPI
}

ProjectList.prototype.hydrate = async function () {
  
}

ProjectList.prototype.share = async function (projectId) {
  // share/publish an existing local project
}

ProjectList.prototype.invite = async function (projectId, users) {
  // invite new users
}

ProjectList.prototype.invited = async function () {
  // all projects the user is invited but has not joined
  return this.structureAPI.invitedProjects()
}

ProjectList.prototype.joined = async function () {
  const projects = await this.structureAPI.projects()
  const odinProjects = Object.values(projects).map((value) => {

  })
}

ProjectList.prototype.join = async function (projectId) {
  return this.structureAPI.join(projectId)
}

ProjectList.prototype.members = async function (projectId) {
  // returns a list of members
}

ProjectList.prototype.start = async function (streamToken, handler = {}) {
  if (this.stream) return //already started

  const EVENT_TYPES = [
      'm.room.member',      
      'm.room.name'
  ]
  const filter = { 
    account_data: {
      not_types:  [ '*' ]
    },
    room: {
      timeline: { limit: 1000, types: EVENT_TYPES },
      ephemeral: {
        not_types: [ '*' ]
      }
    }
  }

  const streamHandler = wrap(handler)

  this.stream = this.timelineAPI.stream(streamToken, filter)
  for await (const chunk of this.stream) {
    // console.dir(chunk, { depth: 5 })

    if (chunk instanceof Error) {
      console.error(chunk.message)      
      await streamHandler.error(chunk)
      continue
    }

    if (Object.keys(chunk.events).length === 0) {
      await streamHandler.streamToken(chunk.next_batch)
      continue
    }


    const eventsByType = {}
    EVENT_TYPES.forEach(eventType => {
      eventsByType[eventType] = []
    })

    const flattenedEvents = Object.entries(chunk.events)
      .map(([roomId, roomEvents]) => {
        return roomEvents.map(event => ({
          content: event.content,
          event_id: event.event_id,
          origin_server_ts: event.origin_server_ts,
          roomId,
          sender: event.sender,          
          state_key: event.state_key,
          type: event.type          
        }))
      })
      .flat()

    const buckets = flattenedEvents.reduce((acc, current) => {
      acc[current.type].push(current)
      return acc
    }, eventsByType)
    
    await streamHandler['m.room.member'](buckets['m.room.member'])
    await streamHandler['m.room.name'](buckets['m.room.name'])
    await streamHandler.streamToken(chunk.next_batch)
  }
  
}

ProjectList.prototype.stop = async function () {
  await this.stream?.return()
  delete this.stream
}

export {
  ProjectList
} 
