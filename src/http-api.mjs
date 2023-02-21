import { got } from 'got'
import { randomUUID } from 'crypto'
import { effectiveFilter } from './convenience.mjs'

const POLL_TIMEOUT = 30000
const RETRY_LIMIT = 0

/**
 * @readonly
 * @enum {string}
 */
const Direction = {
  backward: 'b',
  forward: 'f'
}

const roomStateReducer = (acc, event) => {
  switch (event.type) {
    case 'm.room.create': {
      acc.type = (event.content?.type === 'm.space') ? 'm.space' : 'm.room'
      break 
    }
    case 'm.room.name': { acc.name = event.content.name; break }
    case 'm.room.canonical_alias': { acc.canonical_alias = event.content.alias; break }
    case 'm.room.member': { if (acc.members) { acc.members.push(event.state_key) } else { acc['members'] = [event.state_key] }; break }
    case 'm.space.child': { if (acc.children) { acc.children.push(event.state_key) } else { acc['children'] = [event.state_key] }; break }
  }
  return acc
}

function HttpAPI (credentials) {

  this.credentials = {
    user_id: credentials.user_id,
    home_server: credentials.home_server
  }
 
  const clientOptions = {
    prefixUrl: new URL('/_matrix/client', credentials.home_server_url),
    headers: {
      'User-Agent': 'ODIN/v2'
    },
    context: {
      access_token: credentials.access_token
    },
    retry: {
      limit: RETRY_LIMIT
    },
    hooks: {
      beforeRequest: [
        options => {
          if (options.context?.access_token) {
            options.headers.Authorization = `Bearer ${options.context.access_token}`
          }
        }
      ]
    },
    timeout: {
      connect: 2500,
      send: 10000,
      response: 1.1 * POLL_TIMEOUT
    }
  }
  
  if (credentials.refresh_token && credentials.expires_in_ms) {
    if (this.refreshTokenJob) {
      clearTimeout(this.refreshTokenJob)
      this.refreshTokenJob = undefined
    }
    setImmediate(() => this.refreshAccessToken(credentials.refresh_token))
  }

  this.client = got.extend(clientOptions)

}


HttpAPI.prototype.refreshAccessToken = async function (refreshToken) {
  try {
    const tokens = await this.client.post('v3/refresh', { // v1 vs v3 !!
      json: {
        refresh_token: refreshToken
      }
    }).json()
    this.client.defaults.options.context.access_token = tokens.access_token
    
    const fractionOfLifetime = 0.95
    this.refreshTokenJob = setTimeout((token) => this.refreshAccessToken(token), Math.floor(tokens.expires_in_ms * fractionOfLifetime), tokens.refresh_token)
    console.log(`Scheduled token refresh in ${Math.floor(tokens.expires_in_ms / 1000 * fractionOfLifetime)}s, expires in ${tokens.expires_in_ms / 1000}s`)
  } catch (error) {
    console.error('REFRESH ACCESS TOKEN FAILED: ${error.message}')
  }  
}


HttpAPI.loginWithPassword = async function ({ homeServerUrl, userId, password, deviceId }) {
  const options = {
    type: 'm.login.password',
    identifier: {
      type: 'm.id.user',
      user: userId
    },
    password,
    device_id: deviceId
  }

  return this.login(homeServerUrl, options)
}

HttpAPI.login = async function (homeServerUrl, options) {
  const defaults = {
    refresh_token: true
  }     
  const body = {...defaults, ...options}

  const loginResult = await got.post('v3/login', {
    prefixUrl: new URL('/_matrix/client', homeServerUrl),
    json: body,
    retry: {
      limit: 3
    },
    timeout: {
      connect: 2500,
      send: 2500,
      response: 10000
    }
  }).json()

  loginResult.home_server_url = homeServerUrl
  return loginResult
}

HttpAPI.prototype.logout = async function () {
  await this.client.post('v3/logout')
  if (this.refreshTokenJob) {
    clearTimeout(this.refreshTokenJob)
    delete this.refreshTokenJob
  }
  delete this.credentials
}

HttpAPI.prototype.getRoomHierarchy = async function (roomId) {
  return this.client.get(`v1/rooms/${encodeURIComponent(roomId)}/hierarchy`, {
    searchParams: {
      limit: 1000,
      max_depth: 1,
      suggested_only: false
    }
  }).json()
}

HttpAPI.prototype.getRoomId = async function (alias) {
  return this.client.get(`v3/directory/room/${encodeURIComponent(alias)}`).json()
}

HttpAPI.prototype.getRoom = async function (roomId) {
  const state = await this.client.get(`v3/rooms/${encodeURIComponent(roomId)}/state`).json()
  const room = state.reduce(roomStateReducer, { room_id: roomId })
  return room
}

/**
 * 
 * @param {createRoomOptions} options 
 * @returns 
 */
HttpAPI.prototype.createRoom = async function (options) {
  return this.client.post('v3/createRoom', { json: options }).json()
}

/**
 * 
 * @param {string} roomId 
 * @param {string} userId 
 * @returns {Promise.<void>} no return value
 */
HttpAPI.prototype.invite = async function (roomId, userId) {
  return this.client.post(`v3/rooms/${encodeURIComponent(roomId)}/invite`, { json: { user_id: userId }}).json()
}

/**
 * 
 * @param {string} id - id can either be the roomId OR an alias 
 * @returns 
 */
HttpAPI.prototype.join = async function (id) {
  /*
    13jan23/HAL
    The documentation for this API call (https://spec.matrix.org/v1.4/client-server-api/#post_matrixclientv3joinroomidoralias)
    does not mention that it is mandatory to append a query parameter "server_name=..." in order to join rooms whows origin
    is not the user's home server.
  */
  const host = id.split(':')[1]
  const queryParam = (host === this.credentials.home_server) ? '' : `?server_name=${host}`
  const url = `v3/join/${encodeURIComponent(id)}${queryParam}`
  return this.client.post(url).json()
}

HttpAPI.prototype.leave = async function (roomId) {
  return this.client.post(`v3/rooms/${roomId}/leave`).json()
}

HttpAPI.prototype.forget = async function (roomId) {
  return this.client.post(`v3/rooms/${roomId}/forget`).json()
}

HttpAPI.prototype.joinedRooms = async function () {
  return this.client.get('v3/joined_rooms').json()
}


HttpAPI.prototype.sendStateEvent = async function (roomId, eventType, content, stateKey) {
  return this.client.put(`v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}${stateKey ? '/' + encodeURIComponent(stateKey) : '' }`, {
    json: content
  }).json()
}

HttpAPI.prototype.sendMessageEvent = async function (roomId, eventType, content, txnId = randomUUID()) {
  return this.client.put(`v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`, {
    json: content
  }).json()
}

HttpAPI.prototype.getRelations = async function (roomId, eventId) {
  return this.client.get(`v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(eventId)}`).json()
}

HttpAPI.prototype.getEvent = async function (roomId, eventId) {
  return this.client.get(`v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`).json()
}

/**
 * @typedef GetMessageQueryParameters
 * @type {object}
 * @property {Direction} dir - directon of movement on the timeline.
 * @property {RoomEventFilter} filter - filter.
 * @property {StreamKeyToken} from - the token to start.
 * @property {StreamKeyToken} to - the token to end.
*/


/**
 * 
 * @param {string} roomId 
 * @param {GetMessageQueryParameters} options
 * @returns 
 */
HttpAPI.prototype.getMessages = async function (roomId, options) {
  const searchParams = {...options}
  if (searchParams.filter) {
    searchParams.filter = effectiveFilter(searchParams.filter)
  }
  return this.client.get(`v3/rooms/${roomId}/messages`, { searchParams }).json()
}

HttpAPI.prototype.sendToDevice = async function (deviceId, eventType, content = {}, txnId = randomUUID()) {
  const toDeviceMessage = {}
  toDeviceMessage[deviceId] = content

  const body = {
    messages: {}
  }

  body.messages[this.credentials.user_id] = toDeviceMessage

  return this.client.put(`v3/sendToDevice/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`, {
    json: body
  }).json()
}

HttpAPI.prototype.sync = async function (since, filter, timeout = POLL_TIMEOUT, signal = (new AbortController()).signal) {
  const buildSearchParams = (since, filter, timeout) => {
    const params = {
      timeout
    }
    if (since) params.since = since
    const f = effectiveFilter(filter)
    if (f) params.filter = f
    return params
  }
  return this.client.get('v3/sync', {
    searchParams: buildSearchParams(since, filter, timeout),
    signal
  }).json()
}

export {
  HttpAPI,
  roomStateReducer
}
