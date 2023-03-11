import { roomStateReducer } from './convenience.mjs'

const MAX_BATCH_SIZE = 64

const EVENT_TYPES = {
  STATE: ['m.room.name', 'm.room.member', 'm.space.child'],
  MESSAGE: ['m.room.message']
}



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
 * @typedef {Object} MatrixAPI
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

  /**
   * @description Returns the project structure hierarchy (tree).
   * @param {MatrixRoomId} globalId - The [matrix] roomId of the project 
   */
  async project (globalId) {
    const hierarchy = await this.httpAPI.getRoomHierarchy(globalId)
    const layerRoomIds = hierarchy.rooms
      .filter(room => room.room_type === 'io.syncpoint.odin.layer')
      .map(room => room.room_id)
    const filter = {
      room: {
        timeline: { not_types: [ '*' ] },
        rooms: layerRoomIds
      }
    }
    const state = await this.httpAPI.sync(undefined, filter, 0)
    const layers = {}

    for (const [roomId, content] of Object.entries(state.rooms?.join || {})) {
      const room = content.state.events.reduce(roomStateReducer, { room_id: roomId })
      layers[roomId] = room
    }

    return layers
  }

  /**
   * 
   * @param {string} localId -  This id will be used as a canonical_alias. Other instances joining the project will use this id
   *                            as its local db key for the project.
   * @param {string} friendlyName - This name will be shown in the "project" view for every node that gets invited to join the project.
   * @returns 
   */
  async createProject (localId, friendlyName, description) {
    const creationOptions = {
      name: friendlyName,
      topic: description,
      visibility: 'private',
      creation_content: {
        type: 'm.space',  // indicates that the room has the role of a SPACE
        // type: 'io.syncpoint.odin.project', 3mar23: breaks the parent/child hierarchy
        guest_access: 'forbidden',
        'io.syncpoint.odin.id': localId
      },
      power_level_content_override: {
        'users_default': 0,
        'events': {
          'm.room.name': 50,
          'm.room.power_levels': 100,
          'm.room.history_visibility': 100,
          'm.room.canonical_alias': 100,
          'm.room.avatar': 50,
          'm.room.tombstone': 100,
          'm.room.server_acl': 100,
          'm.room.encryption': 100,
          'm.space.child': 0, // every member is allowed to add child rooms to the space
          'm.room.topic': 50,
          'm.room.pinned_events': 50,
          'm.reaction': 100
        },
        'events_default': 100,
        'state_default': 50,
        'ban': 50,
        'kick': 50,
        'redact': 50,
        'invite': 0,
        'historical': 100
      }
    }

    const { room_id: globalId } = await this.httpAPI.createRoom(creationOptions)

    await this.httpAPI.sendStateEvent(globalId, 'm.room.guest_access', {
      guest_access: 'forbidden'
    })
    
    // await this.httpAPI.sendStateEvent(globalId, 'io.syncpoint.odin.id', { id: localId }, '')

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
  async createLayer (localId, friendlyName, description) {
    const creationOptions = {
      name: friendlyName,
      topic: description,
      visibility: 'private',
      creation_content: {
        type: 'io.syncpoint.odin.layer',
        guest_access: 'forbidden',
        'io.syncpoint.odin.id': localId
      },
      power_level_content_override: 
      {
        'users_default': 0,
        'events': {
          'm.room.name': 0,
          'm.room.power_levels': 100,
          'm.room.history_visibility': 100,
          'm.room.canonical_alias': 100,
          'm.room.avatar': 50,
          'm.room.tombstone': 100,
          'm.room.server_acl': 100,
          'm.room.encryption': 100,
          'm.space.parent': 0
        },
        'events_default': 0,
        'state_default': 50,
        'ban': 50,
        'kick': 50,
        'redact': 50,
        'invite': 0,
        'historical': 100
      }
    }

    const { room_id: globalId } = await this.httpAPI.createRoom(creationOptions)

    await this.httpAPI.sendStateEvent(globalId, 'm.room.guest_access', {
      guest_access: 'forbidden'
    })
    // await this.httpAPI.sendStateEvent(globalId, 'io.syncpoint.odin.id', { id: localId }, '')

    return {
      localId,
      /** @type {MatrixRoomId} */
      globalId,
      friendlyName,
      /** @type {ROOM_TYPE} */
      type: ROOM_TYPE.LAYER
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

  /**
   * 
   * @param {MatrixRoomId} globalId - The [matrix] roomId of the room to rename
   * @param {*} friendlyName - The new name of the layer or project
   * @returns 
   */
  async rename (globalId, friendlyName) {
    return this.httpAPI.sendStateEvent(globalId, 'm.room.name', { name: friendlyName })
  }

  /**
   * 
   * @param {MatrixRoomId} globalLayerId 
   * @param {object} message
   * @description Calls are scheduled 
   */
  post (globalLayerId, message) {
    this.commandAPI.schedule(['sendMessageEvent', globalLayerId, MESSAGE_EVENT_TYPE, message])
  }

}

export {
  StructureAPI
}