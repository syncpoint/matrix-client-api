import { roomStateReducer } from './convenience.mjs'
import * as power from './powerlevel.mjs'

/**
 * @readonly
 * @enum {string}
 */
const ROOM_TYPE = {
  LAYER: 'layer',
  PROJECT: 'project'
}

/**
 * @typedef {string} MatrixRoomId - #rrrr:home_server
 * @typedef {string} MatrixUserId - @uuuu:home_server
 */

/**
 * @description Designed for usage in ODINv2.
 * @typedef {Object} StructureAPI
 */
class StructureAPI {
  constructor (httpAPI) {
    this.httpAPI = httpAPI
  }

  credentials () {
    return this.httpAPI.credentials
  }

  /**
   * @description Returns an array of project structures that the currently logged in user is invited to
   */
  async invitedProjects () {
    const filter = {
      room: {
        timeline: { not_types: [ '*' ] }
      }
    }
    const state = await this.httpAPI.sync(undefined, filter, 0)
    const projects = {}

    for (const [roomId, content] of Object.entries(state.rooms?.invite || {})) {
      const room = content.invite_state.events.reduce(roomStateReducer, { room_id: roomId })
      if (room.type === 'm.space' && room.id) {
        projects[roomId] = room
      }
    }

    return projects
  }

  /**
   * @description Returns all projects the currently logged-in user has either already joined
   */
  async projects () {
    /*
      Sadly the API call "joinedRoom" is not sufficient since it returns only roomIds without any type information.
      Thus we cannot distinguish between projects (spaces) and layers. The sync call is way more expensive but brings
      all the data we need.
    */

    const filter = {
      room: {
        timeline: { not_types: [ '*' ] }
      }
    }
    const state = await this.httpAPI.sync(undefined, filter, 0)
    const projects = {}

    for (const [roomId, content] of Object.entries(state.rooms?.join || {})) {
      const room = content.state.events.reduce(roomStateReducer, { room_id: roomId })
      if (room.type === 'm.space' && room.id) {
        projects[roomId] = room
      }
    }

    return projects
  }

  /**
   * 
   * @param {MatrixRoomId} globalProjectId - The globally unique [matrix] id of the project.
   * @param {MatrixUserId} userId - UserId must meet the requirements of [matrix] and start with a "@".
   */
  async invite (globalProjectId, userId) {
    return this.httpAPI.invite(globalProjectId, userId)
  }

  /**
   * @param {MatrixRoomId} globalId - Joins a room
   */
  async join (globalId) {
    return this.httpAPI.join(globalId)
  }

  /**
   * 
   * @param {MatrixRoomId} globalId 
   * @returns 
   */
  async leave (globalId) {
    return this.httpAPI.leave(globalId)
  }

  async members (globalId) {
    return this.httpAPI.members(globalId)
  }

  async kick (globalId, userId) {
    return this.httpAPI.kick(globalId, userId)
  }

  async powerlevel (globalId, userId) {
    const state = await this.httpAPI.getState(globalId)
    const roomPowerlevels = state.find(stateEvent => stateEvent.type === 'm.room.power_levels')
    return power.powerlevel(userId, roomPowerlevels)
  }

  mediaContentUrl (mediaUrl) {
    if (!mediaUrl) return undefined
    return this.httpAPI.getMediaContentUrl(mediaUrl)
  }

  async searchInUserDirectory (term) {
    return this.httpAPI.searchInUserDirectory(term)
  }

  async profile (userId) {
    return this.httpAPI.getProfile(userId)
  }

  /**
   * @description Returns the project structure hierarchy (tree).
   * @param {MatrixRoomId} globalId - The [matrix] roomId of the project 
   */
  async project (globalId) {
    const hierarchy = await this.httpAPI.getRoomHierarchy(globalId)

    // const space = hierarchy.rooms.find(room => room.room_type === 'm.space')
    
    const layerRoomIds = hierarchy.rooms
      // .filter(room => room.room_type === 'io.syncpoint.odin.layer')
      .map(room => room.room_id)

    const filter = {
      account_data: {
        not_types:  [ '*' ]
      },
      room: {
        timeline: {
          lazy_load_members: true,  // improve performance
          not_types: [ '*' ]        // don't care about timeline
        },
        rooms: layerRoomIds,
        ephemeral: {
          not_types: [ '*' ]
        }
      }
    }
    const state = await this.httpAPI.sync(undefined, filter, 0)
    
    const layers = {}
    let space = undefined
    for (const [roomId, content] of Object.entries(state.rooms?.join || {})) {
      if (!layerRoomIds.includes(roomId)) continue
      const room = content.state.events.reduce(roomStateReducer, { room_id: roomId })
      
      const scope = (roomId === globalId) 
                    ? power.SCOPE.PROJECT
                    : power.SCOPE.LAYER
      room.powerlevel = (power.powerlevel(this.httpAPI.credentials.user_id, room.power_levels, scope))
      delete room.power_levels
      
      if (roomId === globalId) // space!
      {
        space = room
      } else {
        layers[roomId] = room
      }
      
    }

    /*
      We have set up children of a space to be discoverable without an explicit invitation (see join_rules for the children).
      Thus, these children are NOT LISTED in the 'invite' object of 'state.rooms', but they are part of the hierarchy API call.
      So every layer that is listed in the hierarchy but is not part of the layers joined must be a candidate that may be joined.
    */

    const candidateIds = layerRoomIds.filter(roomId => (layers[roomId] === undefined))
    const candidates = hierarchy.rooms
                        .filter(room => candidateIds.includes(room.room_id))
                        .map(room => ({
                          id: room.room_id,
                          name: room.name,
                          topic: room.topic
                        }))
    

    const project = {
      name: space.name,
      powerlevel: space.powerlevel,
      room_id: space.room_id,
      topic: space.topic,
      candidates, // invitations
      layers,
    }    

    return project
  }

  /**
   * 
   * @param {string} localId -  This id will be used as a canonical_alias. Other instances joining the project will use this id
   *                            as its local db key for the project.
   * @param {string} friendlyName - This name will be shown in the "project" view for every node that gets invited to join the project.
   * @returns 
   */
  async createProject (localId, friendlyName, description, defaultUserRole = power.ROLES.PROJECT.CONTRIBUTOR) {
    const creationOptions = {
      name: friendlyName,
      topic: description,
      visibility: 'private',
      creation_content: {
        type: 'm.space',  // indicates that the room has the role of a SPACE
        // type: 'io.syncpoint.odin.project', 3mar23: breaks the parent/child hierarchy
        // guest_access: 'forbidden',
        'io.syncpoint.odin.id': localId
      },
      initial_state: [
        {
          type: 'm.room.history_visibility',
          content: {
            history_visibility: 'shared'
          },
          state_key: ''
        }, 
        {
          type: 'm.room.guest_access',
          content: {
            guest_access: 'forbidden'
          },
          state_key: ''
        }
      ],
      power_level_content_override: {
        'users_default': defaultUserRole.powerlevel,
        'events': {
          'm.room.name': power.ROLES.PROJECT.MANAGER.powerlevel,
          'm.room.power_levels': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
          'm.room.history_visibility': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
          'm.room.canonical_alias': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
          'm.room.avatar': power.ROLES.PROJECT.MANAGER.powerlevel,
          'm.room.tombstone': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
          'm.room.server_acl': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
          'm.room.encryption': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
          'm.space.child': power.ROLES.PROJECT.CONTRIBUTOR.powerlevel,
          'm.room.topic': power.ROLES.PROJECT.MANAGER.powerlevel,
          'm.reaction': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel
        },
        'events_default': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
        'state_default': power.ROLES.PROJECT.MANAGER.powerlevel,
        'ban': power.ROLES.PROJECT.MANAGER.powerlevel,
        'kick': power.ROLES.PROJECT.MANAGER.powerlevel,
        'redact': power.ROLES.PROJECT.MANAGER.powerlevel,
        'invite': power.ROLES.PROJECT.MANAGER.powerlevel,
        'historical': power.ROLES.PROJECT.READER.powerlevel
      }
    }

    const { room_id: globalId } = await this.httpAPI.createRoom(creationOptions)

    /* await this.httpAPI.sendStateEvent(globalId, 'm.room.guest_access', {
      guest_access: 'forbidden'
    }) */

    return {
      localId,
      globalId,
      friendlyName,
      /** @type {ROOM_TYPE} */
      type: ROOM_TYPE.PROJECT
    }
  }

  /**
   * 
   * @param {string} localId - This id will be used as a canonical_alias. Other instances joining the layer will use this id
   *                            as its local db key for the project.
   * @param {string} friendlyName - This name will be shown in the "layer" scope.
   * @returns 
   */
  async createLayer (localId, friendlyName, description, defaultUserRole = power.ROLES.LAYER.READER) {
    const creationOptions = {
      name: friendlyName,
      topic: description,
      visibility: 'private',
      creation_content: {
        type: 'io.syncpoint.odin.layer',
        'io.syncpoint.odin.id': localId
      },
      initial_state: [
        {
          type: 'm.room.history_visibility',
          content: {
            history_visibility: 'shared'
          },
          state_key: ''
        }, 
        {
          type: 'm.room.guest_access',
          content: {
            guest_access: 'forbidden'
          },
          state_key: ''
        }
      ],
      power_level_content_override: 
      {
        'users_default': defaultUserRole.powerlevel,
        'events': {
          'm.room.name': power.ROLES.LAYER.MANAGER.powerlevel,
          'm.room.power_levels': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
          'm.room.history_visibility': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
          'm.room.canonical_alias': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
          'm.room.avatar': power.ROLES.LAYER.MANAGER.powerlevel,
          'm.room.tombstone': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
          'm.room.server_acl': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
          'm.room.encryption': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
          'm.space.parent': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
          'io.syncpoint.odin.operation': power.ROLES.LAYER.CONTRIBUTOR.powerlevel
        },
        'events_default': power.ROLES.LAYER.MANAGER.powerlevel,
        'state_default': power.ROLES.LAYER.MANAGER.powerlevel,
        'ban': power.ROLES.LAYER.MANAGER.powerlevel,
        'kick': power.ROLES.LAYER.MANAGER.powerlevel,
        'redact': power.ROLES.LAYER.MANAGER.powerlevel,
        'invite': power.ROLES.LAYER.MANAGER.powerlevel,
        'historical': power.ROLES.LAYER.READER.powerlevel
      }
    }

    const { room_id: globalId } = await this.httpAPI.createRoom(creationOptions)

    /* await this.httpAPI.sendStateEvent(globalId, 'm.room.guest_access', {
      guest_access: 'forbidden'
    }) */

    return {
      localId,
      /** @type {MatrixRoomId} */
      globalId,
      friendlyName,
      /** @type {ROOM_TYPE} */
      type: ROOM_TYPE.LAYER,
      powerlevel: power.ROLES.LAYER.ADMINISTRATOR.name
    }
  }

  /**
   * 
   * @param {MatrixRoomId} globalProjectId 
   * @param {MatrixRoomId} globalLayerId 
   */
  async addLayerToProject (globalProjectId, globalLayerId) {

    const childOptions = {
      auto_join: false,
      suggested: false,
      via: [
        this.httpAPI.credentials.home_server
      ]
    }

    const allowSpaceMembersToJoin =
    {
      join_rule: 'restricted',        // see enum JoinRule from @types/partials.ts
      allow: [
        {
          type: 'm.room_membership',  // see enum RestrictedAllowType from @types/partials.ts
          room_id: globalProjectId
        }
      ]
    }

    await this.httpAPI.sendStateEvent(globalLayerId, 'm.room.join_rules', allowSpaceMembersToJoin)
    await this.httpAPI.sendStateEvent(globalLayerId, 'm.space.parent', {}, globalProjectId)
    await this.httpAPI.sendStateEvent(globalProjectId, 'm.space.child', childOptions, globalLayerId)
    
    return {
      /** @type {MatrixRoomId} */
      projectId: globalProjectId,
      /** @type {MatrixRoomId} */
      layerId: globalLayerId
    }
  }

  async getLayer (globalId) {
    const layer = await this.httpAPI.getRoom(globalId)
    layer.powerlevel = (power.powerlevel(this.httpAPI.credentials.user_id, layer.power_levels)).name
    delete layer.power_levels
    return layer
  }

  /**
   * 
   * @param {MatrixRoomId} globalId - The [matrix] roomId of the room to rename
   * @param {*} friendlyName - The new name of the layer or project
   * @returns 
   */
  async setName (globalId, name) {
    return this.httpAPI.sendStateEvent(globalId, 'm.room.name', { name })
  }

  async setTopic (globalId, topic) {
    return this.httpAPI.sendStateEvent(globalId, 'm.room.topic', { topic })
  }

}

export {
  StructureAPI
}