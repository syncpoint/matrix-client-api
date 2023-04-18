// import { got } from 'got'
import ky, { HTTPError } from 'ky'
import { randomUUID } from 'crypto'
import { effectiveFilter, roomStateReducer } from './convenience.mjs'

const POLL_TIMEOUT = 30000
const RETRY_LIMIT = 2

/**
 * @readonly
 * @enum {string}
 */
const Direction = {
  backward: 'b',
  forward: 'f'
}
function HttpAPI (credentials) {

  this.credentials = {
    user_id: credentials.user_id,
    home_server: credentials.home_server,
    home_server_url: credentials.home_server_url,
    refresh_token: credentials.refresh_token,
    access_token: credentials.access_token
  }

  this.handler = { tokenRefreshed: () => {} }
 
  const clientOptions = {
    prefixUrl: new URL('/_matrix/client', credentials.home_server_url),
    headers: {
      'User-Agent': 'ODIN/v2'
    },
    retry: {
      limit: RETRY_LIMIT,
      statusCodes: [401, 408, 413, 429, 500, 502, 503, 504]
    },
    hooks: {
      beforeRequest: [
        request => { 
          request.headers.set('Authorization', `Bearer ${this.credentials.access_token}`)
        }
      ],
      beforeRetry: [
        async ({ error }) => {
          // TODO: check type of Error
          // instanceof HttpError vs TypeError?
          if (error instanceof HTTPError) {

            if (error.response.status === 403) {
              throw error
            } else if (error.response.status === 401) {
              const body = await error.response.json()
              if (body.errcode !== 'M_UNKNOWN_TOKEN' || !body.soft_logout) {
                console.error('MATRIX server does not like us anymore :-(', body.error)
                throw new Error(`${body.errcode}: ${body.error}`)
              }
              
              const tokens = await this.refreshAccessToken(this.credentials.refresh_token)            
              this.credentials.refresh_token = tokens.refresh_token
              /* beforeRequest hook will pick up the access_token and set the Authorization header accordingly */
              this.credentials.access_token = tokens.access_token
              if (this.handler?.tokenRefreshed && typeof this.handler?.tokenRefreshed === 'function') this.handler.tokenRefreshed(this.credentials) // notify the outside world about the new tokens
              return
            }
          }

          throw error
        }
      ]
    },
    timeout: 1.1 * POLL_TIMEOUT * RETRY_LIMIT
  }

  this.client = ky.extend(clientOptions)

}


HttpAPI.prototype.refreshAccessToken = async function (refreshToken) {
    return this.client.post('v3/refresh', { // v1 vs v3 !!
      json: {
        refresh_token: refreshToken
      }
    }).json()
}

HttpAPI.prototype.tokenRefreshed = function (handler) {
  this.handler.tokenRefreshed = handler
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

  const loginResult = await ky.post('v3/login', {
    prefixUrl: new URL('/_matrix/client', homeServerUrl),
    json: body,
    retry: {
      limit: 3
    }
  }).json()

  loginResult.home_server_url = homeServerUrl
  return loginResult
}

HttpAPI.prototype.logout = async function () {
  await this.client.post('v3/logout')
  delete this.credentials
}

HttpAPI.prototype.getRoomHierarchy = async function (roomId) {
  return this.client.get(`v1/rooms/${encodeURIComponent(roomId)}/hierarchy`, {
    searchParams: {
      suggested_only: false
    }
  }).json()
}

HttpAPI.prototype.getRoomId = async function (alias) {
  return this.client.get(`v3/directory/room/${encodeURIComponent(alias)}`).json()
}

HttpAPI.prototype.getRoom = async function (roomId) {
  const state = await this.getState(roomId)
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

HttpAPI.prototype.getState = async function (roomId) {
  return this.client.get(`v3/rooms/${encodeURIComponent(roomId)}/state`).json()
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

HttpAPI.prototype.sync = async function (since, filter, timeout = POLL_TIMEOUT) {
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
    searchParams: buildSearchParams(since, filter, timeout)
  }).json()
}

export {
  HttpAPI
}
