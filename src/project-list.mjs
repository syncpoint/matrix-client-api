import { roomStateReducer, wrap } from "./convenience.mjs"




const domainMapper = matrixRoomState => {
  const project = {...matrixRoomState}
  delete project.room_id
  delete project.type
  delete project.children
  return project
}

const ProjectList = function ({ structureAPI, timelineAPI }) {
  this.structureAPI = structureAPI
  this.timelineAPI = timelineAPI
  
  // wellKnown maps the keys of matrix to ODIN and vice-versa  
  this.wellKnown = new Map()
}

ProjectList.prototype.hydrate = async function () {

  const joined = await this.structureAPI.projects()
  const invited = await this.structureAPI.invitedProjects()
  const myProjects = {...joined, ...invited}

  Object.entries(myProjects).forEach(([roomId, roomState]) => {
    this.wellKnown.set(roomId, roomState.id)  // upstream (matrix) => downstream (ODIN)
    this.wellKnown.set(roomState.id, roomId)
  })
}

ProjectList.prototype.share = async function (projectId, name, description) {
  const result = await this.structureAPI.createProject(projectId, name, description)
  this.wellKnown.set(result.globalId, result.localId)
  this.wellKnown.set(result.localId, result.globalId)
  return {
    id: projectId,
    upstreamId: result.globalId
  }
}

ProjectList.prototype.invite = async function (projectId, userId) {
  const upstreamId = this.wellKnown.get(projectId)
  const result = await this.structureAPI.invite(upstreamId, userId)
  return result
}

ProjectList.prototype.invited = async function () {
  // all projects the user is invited but has not joined
  const invited = await this.structureAPI.invitedProjects()
  return Object.values(invited).map(domainMapper)
}

ProjectList.prototype.joined = async function () {
  const joined = await this.structureAPI.projects()
  return Object.values(joined).map(domainMapper)
}

ProjectList.prototype.join = async function (projectId) {
  const upstreamId = this.wellKnown.get(projectId)
  await this.structureAPI.join(upstreamId)
  return {
    id: projectId,
    upstreamId
  }
}

ProjectList.prototype.setName = async function (projectId, name) {
  const upstreamId = this.wellKnown.get(projectId)
  return this.structureAPI.setName(upstreamId, name)
}

ProjectList.prototype.setDescription = async function (projectId, description) {
  const upstreamId = this.wellKnown.get(projectId)
  return this.structureAPI.setTopic(upstreamId, description)
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
      timeline: { 
        lazy_load_members: true, // improve performance
        limit: 1000, 
        types: EVENT_TYPES, 
        not_senders: [ this.timelineAPI.credentials().user_id ] // NO events if the current user is the sender
      },
      ephemeral: {
        not_types: [ '*' ]
      }
    }
  }

  const streamHandler = wrap(handler)

  this.stream = this.timelineAPI.stream(streamToken, () => filter)
  for await (const chunk of this.stream) {

    if (chunk instanceof Error) {
      await streamHandler.error(chunk)
      continue
    }

    // just store the next batch value no matter if we will process the stream any further 
    await streamHandler.streamToken(chunk.next_batch)

    if (Object.keys(chunk.events).length === 0) continue

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

      const self = this.timelineAPI.credentials().user_id
      const isInvitation = content
        .find(event => event.type === 'm.room.member' 
           && event.state_key === self
           && event.content?.membership === 'invite'
        )
      
      if (isInvitation) {
        const roomState = content.reduce(roomStateReducer, {})
        if (roomState.type === 'm.space' && roomState.id) {
          // does look like an ODIN project
          this.wellKnown.set(roomId, roomState.id)
          this.wellKnown.set(roomState.id, roomId)

          await streamHandler.invited(domainMapper(roomState))
        }
        
      } else {
        const named = content.find(event => event.type === "m.room.name")
        if (!named) return 
        /*
          We ignore membership changes of other users for now.
        */
        const projectId = this.wellKnown.get(roomId)
        const renamed = {
          id: projectId,
          name: named.content.name
        }
        await streamHandler.renamed(renamed)
      }
    })

    
  }  
}

ProjectList.prototype.stop = async function () {
  await this.stream?.return()
  delete this.stream
}

export {
  ProjectList
} 
