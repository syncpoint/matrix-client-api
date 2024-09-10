import { randomUUID } from 'crypto'
import { roomStateReducer } from './convenience.mjs'
import * as power from './powerlevel.mjs'

import { ROOM_TYPE } from './shared.mjs'


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
    
    const allRoomIds = hierarchy.rooms
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
        rooms: allRoomIds,
        ephemeral: {
          not_types: [ '*' ]
        }
      }
    }
    const state = await this.httpAPI.sync(undefined, filter, 0)
    
    const layers = {}
    const wellknown = {}
    let space = undefined
    for (const [roomId, content] of Object.entries(state.rooms?.join || {})) {
      if (!allRoomIds.includes(roomId)) continue
      const room = content.state.events.reduce(roomStateReducer, { room_id: roomId })
      const scope = (roomId === globalId) 
                    ? power.SCOPE.PROJECT
                    : power.SCOPE.LAYER
      room.powerlevel = (power.powerlevel(this.httpAPI.credentials.user_id, room.power_levels, scope))
      delete room.power_levels
      
      if (roomId === globalId) // space!
      {
        space = room
      } else if (room.type === ROOM_TYPE.WELLKNOWN.ASSEMBLY.fqn) {
        wellknown[roomId] = room
      } else {
        layers[roomId] = room
      }      
    }

    /*
      We have set up children of a space to be discoverable without an explicit invitation (see join_rules for the children).
      Thus, these children are NOT LISTED in the 'invite' object of 'state.rooms', but they are part of the hierarchy API call.
      So every layer that is listed in the hierarchy but is not part of the layers joined must be a candidate that may be joined.
    */

    const candidateIds = allRoomIds.filter(roomId => (layers[roomId] === undefined))
    const candidates = hierarchy.rooms
                        .filter(room => room.room_id !== globalId)
                        .filter(room => candidateIds.includes(room.room_id))
                        .map(room => ({
                          id: room.room_id,
                          name: room.name,
                          topic: room.topic,
                          type: room.room_type
                        }))


    const project = {
      name: space.name,
      powerlevel: space.powerlevel,
      room_id: space.room_id,
      topic: space.topic,
      candidates, // invitations
      layers,
      wellknown
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
        'users': {},
        'events': {
          'm.room.name': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
          'm.room.power_levels': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
          'm.room.history_visibility': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
          'm.room.canonical_alias': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
          'm.room.avatar': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
          'm.room.tombstone': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
          'm.room.server_acl': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
          'm.room.encryption': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
          'm.space.child': power.ROLES.PROJECT.CONTRIBUTOR.powerlevel,
          'm.room.topic': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
          'm.reaction': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel
        },
        'events_default': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
        'state_default': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
        'ban': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
        'kick': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
        'redact': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
        'invite': power.ROLES.PROJECT.ADMINISTRATOR.powerlevel,
        'historical': power.ROLES.PROJECT.READER.powerlevel
      }
    }

    creationOptions.power_level_content_override.users[this.httpAPI.credentials.user_id] = power.ROLES.PROJECT.OWNER.powerlevel
    const { room_id: globalId } = await this.httpAPI.createRoom(creationOptions)

    return {
      localId,
      globalId,
      friendlyName,
      /** @type {ROOM_TYPE} */
      type: ROOM_TYPE.PROJECT.type,
      powerlevel: {
        self: power.ROLES.LAYER.OWNER,
        default: defaultUserRole
      }
    }
  }

  async createLayer (localId, friendlyName, description, defaultUserRole = power.ROLES.LAYER.READER) {
    return this.__createRoom(localId, friendlyName, description, ROOM_TYPE.LAYER, defaultUserRole)
  }

  async createWellKnownRoom (roomType) {
    return this.__createRoom(roomType.type, roomType.name ?? roomType.type, '', roomType, null)
  }

  /**
   * @private
   * @param {string} localId - This id will be used as a canonical_alias. Other instances joining the layer will use this id
   *                            as its local db key for the project.
   * @param {string} friendlyName - This name will be shown in the "layer" scope.
   * @returns 
   */
  async __createRoom (localId, friendlyName, description, roomType, defaultUserRole) {
    const creationOptions = {
      name: friendlyName,
      topic: description,
      visibility: 'private',
      creation_content: {
        type: roomType.fqn,
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
      ]      
    }

    if (defaultUserRole) {
      creationOptions.power_level_content_override =
      {
        'users_default': defaultUserRole.powerlevel,
        'users': {},
        'events': {
          'm.room.name': power.ROLES.LAYER.CONTRIBUTOR.powerlevel,
          'm.room.power_levels': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
          'm.room.history_visibility': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
          'm.room.canonical_alias': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
          'm.room.avatar': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
          'm.room.tombstone': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
          'm.room.server_acl': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
          'm.room.encryption': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
          'm.space.parent': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
          'io.syncpoint.odin.operation': power.ROLES.LAYER.CONTRIBUTOR.powerlevel
        },
        'events_default': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
        'state_default': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
        'ban': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
        'kick': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
        'redact': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
        'invite': power.ROLES.LAYER.ADMINISTRATOR.powerlevel,
        'historical': power.ROLES.LAYER.READER.powerlevel
      }

      creationOptions.power_level_content_override.users[this.httpAPI.credentials.user_id] = power.ROLES.LAYER.OWNER.powerlevel
    }

    

    const { room_id: globalId } = await this.httpAPI.createRoom(creationOptions)

    return {
      localId,
      /** @type {MatrixRoomId} */
      globalId,
      friendlyName,
      /** @type {ROOM_TYPE} */
      type: roomType.type,
      powerlevel: {
        self: power.ROLES.LAYER.OWNER,
        default: defaultUserRole
      }
    }
  }

  /**
   * 
   * @param {MatrixRoomId} globalProjectId 
   * @param {MatrixRoomId} globalLayerId 
   */
  async addLayerToProject (globalProjectId, globalLayerId, suggested = false) {

    const childOptions = {
      auto_join: false,
      suggested,
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
    layer.powerlevel = power.powerlevel(this.httpAPI.credentials.user_id, layer.power_levels)
    delete layer.power_levels
    return layer
  }

  async setDefaultPowerlevel (globalId, powerlevel) {
    const room = await this.httpAPI.getRoom(globalId)
    const power_levels = {...room.power_levels}
    power_levels.users_default = powerlevel.powerlevel
    return this.httpAPI.sendStateEvent(globalId, 'm.room.power_levels', power_levels)
  }

  async setPowerlevel (globalId, userId, powerlevel) {
    const room = await this.httpAPI.getRoom(globalId)
    const power_levels = {...room.power_levels}
    power_levels.users[userId] = powerlevel.powerlevel
    return this.httpAPI.sendStateEvent(globalId, 'm.room.power_levels', power_levels)
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