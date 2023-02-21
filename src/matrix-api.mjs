import { HttpAPI, roomStateReducer } from './http-api.mjs'
import { TimelineAPI } from './timeline-api.mjs'
import { CommandAPI } from './command-api.mjs'
import { Store } from './store.mjs'
import { EventEmitter } from 'node:events'

const MESSAGE_EVENT_TYPE = 'm.room.message'
const DEFAULT_POLLING_INTERVAL = 30_000
const MAX_BATCH_SIZE = 64

const EVENT_TYPES = {
  STATE: ['m.room.name', 'm.room.member', 'm.space.child'],
  MESSAGE: ['m.room.message']
}

/*
    emit('project/invited') - for projects
    emit('layer/added')
    emit('layer/removed') - I.e. if a user get's kicked/banned it looks like the layer has been removed
    emit('layer/renamed)
    emit('message) -> ODINv2 related payload
    emit('stream') -> The [matrix] stream token
  */
 /**
  * @readonly
  * @enum
  */
const EVENTS = {
  'PROJECT/INVITED': 'project/invited',
  'LAYER/ADDED': 'layer/added',
  'LAYER/RENAMED': 'layer/renamed',
  'LAYER/REMOVED': 'layer/removed',
  'MESSAGE': 'message',
  'STREAMTOKEN': 'streamtoken'
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
 */
class MatrixAPI extends EventEmitter {
  constructor (credentials, projectId) {
    super()
    this.projectId = projectId
    this.httpAPI = new HttpAPI(credentials)
    this.timelineAPI = new TimelineAPI(this.httpAPI)
    this.commandAPI = new CommandAPI(this.httpAPI)
    this.credentials = credentials

    this.store = new Store({
      controller: new AbortController(),
      timeout: 0
    })
  }

  static Builder = () => new MatrixAPI._Builder()

  static _Builder = class {
    useProjectId (projectId) {
      this.projectId = projectId
      return this
    }

    useCredentials (credentials) {
      this.credentials = credentials
      return this
    }

    async build () {
      if (!this.credentials) throw new Error('Missing credentials. Please use "useCredentials".')
      const loginResult = await MatrixAPI.login(this.credentials)
      return new MatrixAPI(loginResult, this.projectId)
    }
  }

  static async login (loginParams) {
    return HttpAPI.loginWithPassword(loginParams)
  }

  async logout () {
    return this.httpAPI.logout()
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
      if (room.type === 'm.space') {
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
      Thus we cannot distinguishe between projects (spaces) and layers. The sync call is way more expensive but brings
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
      if (room.type === 'm.space') {
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
    return this.httpAPI.getRoomHierarchy(globalId)
  }

  /**
   * 
   * @param {string} localId -  This id will be used as a canonical_alias. Other instances joining the project will use this id
   *                            as its local db key for the project.
   * @param {string} friendlyName - This name will be shown in the "project" view for every node that gets invited to join the project.
   * @returns 
   */
  async createProject (localId, friendlyName) {
    const creationOptions = {
      name: friendlyName,
      room_alias_name: localId,
      visibility: 'private',
      creation_content: {
        type: 'm.space',  // indicates that the room has the role of a SPACE
        guest_access: 'forbidden'
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
  async createLayer (localId, friendlyName) {
    const creationOptions = {
      name: friendlyName,
      room_alias_name: localId,
      visibility: 'private',
      creation_content: {
        guest_access: 'forbidden'
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
        this.credentials.home_server
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


  async start (previousStreamToken) {
    const buildProjectFilter = hierarchy => {
      const filter = { 
        room: {
          rooms: hierarchy.rooms?.map(r => r.room_id),
          timeline: { limit: MAX_BATCH_SIZE, types: [...EVENT_TYPES.STATE, ...EVENT_TYPES.MESSAGE] },
          ephemeral: {
            not_types: [ '*' ]
          }
        }
      }
      return filter
    }

    const dispatch = timeline => {
      console.dir(timeline)
      if (timeline instanceof Error) {
        console.error(timeline.message)
        this.store.setDelay(DEFAULT_POLLING_INTERVAL, true)
        this.store.setStreamToken(this.store.getState().streamToken)
        return
      }
      this.store.setTimeout(DEFAULT_POLLING_INTERVAL, true)
      this.store.setDelay(0, true)
      this.store.setStreamToken(timeline.next_batch)
    }

    const doSync = async ({ streamToken, filter, timeout, controller }, dispatch) => {
      console.log('DOSYNC', streamToken)
      try {
        const timeline = await this.timelineAPI.syncTimeline(streamToken, filter, timeout, controller.signal)
        dispatch(timeline)
      } catch (error) {
        
        dispatch(error)
      }      
    }  


    if (this.projectId) {
      
      const hierarchy = await this.project(this.projectId)
      const filter = buildProjectFilter(hierarchy)

      this.store.on('streamToken', () => {
        const currentState = this.store.getState()
        setTimeout(doSync, currentState.delay, currentState, dispatch)
      })

      this.store.setFilter(filter, true)
      this.store.setStreamToken(previousStreamToken) // triggers call to doSync(...)
    }

    


    /*
      SCOPE.PROJECT_LIST:
      We wait for new project invitations and react if the name of the project changes.

      1) retrieve all projects the user is invited to but has not joined
      2) create a filter
      3) start syncing and emitting events
      4) returns void
    */
    
    


    
  }


  async stop() {
    this.store.controller.abort()
  }


  

}

export {
  MatrixAPI
}