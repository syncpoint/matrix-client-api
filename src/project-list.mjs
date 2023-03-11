import { roomStateReducer } from "./convenience.mjs"


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

  /*
    wellKnown maps the keys of matrix to ODIN and vice-versa
  */
  this.wellKnown = new Map()
}

ProjectList.prototype.hydrate = async function () {

  const joined = await this.joined()
  const invited = await this.invited()
  const myProjects = {...joined, ...invited}

  Object.entries(myProjects).forEach(([roomId, roomState]) => {
    this.wellKnown.set(roomId, roomState.id)  // upstream (matrix) => downstream (ODIN)
    this.wellKnown.set(roomState.id, roomId)
  })
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
  return this.structureAPI.projects()
}

ProjectList.prototype.join = async function (projectId) {
  const upstreamId = this.wellKnown.get(projectId)
  return this.structureAPI.join(upstreamId)
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

    if (chunk instanceof Error) {
      console.error(chunk.message)      
      await streamHandler.error(chunk)
      continue
    }

    if (Object.keys(chunk.events).length === 0) {
      await streamHandler.streamToken(chunk.next_batch)
      continue
    }

    /*
      We receive room-related events. Since we are only interested in invitations or
      room name changes we need to check which handler to apply.

      ROOM NAME CHANGED
        there is NO m.room.member event


      INVITATION:
        there is at least ONE m.room.member event and the state key must
        be the current user
    */

    Object.entries(chunk.events).forEach(async ([roomId, content]) => {
      const isInvitation = content
        .find(event => event.type === 'm.room.member' 
           && event.state_key === this.timelineAPI.credentials().user_id
           && event.content?.membership === 'invite'
        )
      
      if (isInvitation) {
        const roomState = content.reduce(roomStateReducer, {})
        if (roomState.type === 'm.space' && roomState.id) {
          // does look like an ODIN project
          this.wellKnown.set(roomId, roomState.id)
          this.wellKnown.set(roomState.id, roomId)
          await streamHandler.invited(roomState)
        }
        
      } else {
        const named = content.find(event => event.type === "m.room.name")
        const projectId = this.wellKnown.get(roomId)
        const renamed = {
          id: projectId,
          name: named.content.name
        }
        await streamHandler.renamed(renamed)
      }
    })

 
    
    /*  We are only interested in name changes for ODIN projects that we either
        have already joined or are invited to join.
        The sync API does not know what ODIN projects are and sends us
        changes for all spaces/rooms.
    */
    /* await streamHandler['m.room.name'](
      buckets['m.room.name'].filter(event => this.wellKnown.has(event.roomId))
    ) */

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
