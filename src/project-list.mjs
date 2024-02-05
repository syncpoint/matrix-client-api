import { roomStateReducer, wrap } from "./convenience.mjs"
import { powerlevel, SCOPE as POWERLEVEL_SCOPE } from "./powerlevel.mjs"



const domainMapper = userId => matrixRoomState => {
  const project = {...matrixRoomState}
  project.upstreamId = matrixRoomState.room_id
  if (project.power_levels) {
    project.powerlevel = (powerlevel(userId, project.power_levels, POWERLEVEL_SCOPE.PROJECT)).name
    delete project.power_levels
  }
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
  if (this.wellKnown.get(projectId)) {
    /* project is already shared */
    return
  }
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
  return Object.values(invited).map(domainMapper(this.timelineAPI.credentials().user_id))
}

ProjectList.prototype.joined = async function () {
  const joined = await this.structureAPI.projects()
  return Object.values(joined).map(domainMapper(this.timelineAPI.credentials().user_id))
}

ProjectList.prototype.join = async function (projectId) {
  const upstreamId = this.wellKnown.get(projectId)
  await this.structureAPI.join(upstreamId)
  return {
    id: projectId,
    upstreamId
  }
}

ProjectList.prototype.kick = async function (projectId, userId) {
  const upstreamId = this.wellKnown.get(projectId)
  return this.structureAPI.kick(upstreamId, userId)
}

ProjectList.prototype.setName = async function (projectId, name) {
  const upstreamId = this.wellKnown.get(projectId)
  return this.structureAPI.setName(upstreamId, name)
}

ProjectList.prototype.setDescription = async function (projectId, description) {
  const upstreamId = this.wellKnown.get(projectId)
  return this.structureAPI.setTopic(upstreamId, description)
}

ProjectList.prototype.members = async function (projectId) {
  const upstreamId = this.wellKnown.get(projectId)
  const result = await this.structureAPI.members(upstreamId)
  const members = (result.chunk || []).map(event => ({
    membership: event.content.membership,
    displayName: event.content.displayname,
    userId: event.state_key,
    avatarUrl: this.structureAPI.mediaContentUrl(event.content.avatar_url)
  }))
  return members
}

ProjectList.prototype.searchUsers = async function (term) {
  const { results } = await this.structureAPI.searchInUserDirectory(term)
  return results.map(user => ({
    displayName: user.display_name,   // ANNOYING! display_name
    userId: user.user_id,
    avatarUrl: this.structureAPI.mediaContentUrl(user.avatar_url)
  }))
}

ProjectList.prototype.profile = async function (userId) {
  try {
    const profile = await this.structureAPI.profile(userId)
    return {
      displayName: profile.displayname,  // ANNOYING! displayname
      userId,
      avatarUrl: this.structureAPI.mediaContentUrl(profile.avatar_url)
    }
  } catch (error) {
    return null
  }
}

/**
 * 
 * @param {String} projectId 
 * @param {String} userId. If not provided the currently logged in userId will be used.
 * @returns {Object} An object that has the actions (invite, kick, ban, redact) as keys and boolen values
 * to indicate if this action is allowed for the given userId.
 */
ProjectList.prototype.permissions = async function (projectId, userId) {
  const upstreamId = this.wellKnown.get(projectId)
  return this.structureAPI.permissions(upstreamId, userId || this.timelineAPI.credentials().user_id)
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

          await streamHandler.invited(domainMapper(this.timelineAPI.credentials().user_id)(roomState))
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
