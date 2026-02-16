// import { got } from 'got'
import ky, { HTTPError } from 'ky'
import { randomUUID } from 'crypto'
import { effectiveFilter, roomStateReducer } from './convenience.mjs'
import { getLogger } from './logger.mjs'
import { RequestType } from './crypto.mjs'

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
    device_id: credentials.device_id,
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
              if (body.errcode === 'M_UNKNOWN_TOKEN' && this.credentials.refresh_token) {
                getLogger().info('Access token expired, attempting refresh...')
                try {
                  const tokens = await this.refreshAccessToken(this.credentials.refresh_token)            
                  this.credentials.refresh_token = tokens.refresh_token
                  /* beforeRequest hook will pick up the access_token and set the Authorization header accordingly */
                  this.credentials.access_token = tokens.access_token
                  if (this.handler?.tokenRefreshed && typeof this.handler?.tokenRefreshed === 'function') this.handler.tokenRefreshed(this.credentials)
                  return
                } catch (refreshError) {
                  getLogger().error('Token refresh failed:', refreshError.message)
                  throw new Error(`Token refresh failed: ${refreshError.message}`)
                }
              }
              getLogger().error('Authentication rejected:', body.errcode, body.error)
              throw new Error(`${body.errcode}: ${body.error}`)
            }
          }

          throw error
        }
      ]
    },
    timeout: 1.1 * POLL_TIMEOUT * RETRY_LIMIT
  }

  this.client = ky.create(clientOptions)

}

/*
  static functions
*/
HttpAPI.loginWithPassword = async function ({ home_server_url, user_id, password, device_id }) {
  const options = {
    type: 'm.login.password',
    identifier: {
      type: 'm.id.user',
      user: user_id
    },
    password,
    device_id
  }

  return this.login(home_server_url, options)
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
      limit: 3,
      maxRetryAfter: 5 * 60 * 1000,
      statusCodes: [ 429 ],
      methods: ['post']
    },
    hooks: {
      afterResponse: [
        async (request, options, response) => {
          if (response.status !== 429) {
            return response
          }

          const body = await response.json()
          const { retry_after_ms: retryAfter } = body
          if (!retryAfter) return response

          const headers = { 'Retry-After': Math.ceil(1.05 * retryAfter / 1000)}
          response.headers.forEach((v, k) => headers[k] = v)

          const retryAfterResponse = new Response(null, {
            headers: new Headers(headers),
            status: 429,
            statusText: response.statusText,
            type: response.type,
            url: response.url
          })
          getLogger().info(`Rate limited, retrying at ${(new Date(Date.now() + retryAfter)).toISOString()}`)
          return retryAfterResponse          

        }
      ]
    }
  }).json()

  loginResult.home_server_url = homeServerUrl
  return loginResult
}

HttpAPI.getWellKnownClientInfo = async function (homeServerUrl) {
  return ky.get('.well-known/matrix/client', {
    prefixUrl: homeServerUrl,
    retry: {
      limit: 1
    },
    throwHttpErrors: false
  })
}

HttpAPI.getWellKnownServerInfo = async function (homeServerUrl) {
  return ky.get('.well-known/matrix/server', {
    prefixUrl: homeServerUrl,
    retry: {
      limit: 1
    },
    throwHttpErrors: false
  })
}

/**
 * 
 * @param {*} homeServerUrl 
 * @returns An object that lists the supported versions of the [matrix] specification.
 */
HttpAPI.getVersions = async function (homeServerUrl) {
  return ky.get('_matrix/client/versions', {
    prefixUrl: homeServerUrl,
    retry: {
      limit: 1
    },
    throwHttpErrors: false
  })
}

/*
  Instance functions
*/

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

HttpAPI.prototype.kick = async function (roomId, userId) {
  return this.client.post(`v3/rooms/${encodeURIComponent(roomId)}/kick`, {
    json: {
      user_id: userId
    }
  }).json()
}

HttpAPI.prototype.ban = async function (roomId, userId) {
  return this.client.post(`v3/rooms/${encodeURIComponent(roomId)}/ban`, {
    json: {
      user_id: userId
    }
  }).json()
}

HttpAPI.prototype.joinedRooms = async function () {
  return this.client.get('v3/joined_rooms').json()
}

HttpAPI.prototype.members = async function (roomId, exclude = 'leave') {
  return this.client.get(`v3/rooms/${encodeURIComponent(roomId)}/members?not_membership=${exclude}`).json()
}

HttpAPI.prototype.searchInUserDirectory = async function (term) {
  return this.client.post('v3/user_directory/search', {
    json: {
      limit: 5,
      search_term: term
    }
  }).json()
}

HttpAPI.prototype.getProfile = async function (userId) {
  return this.client.get(`v3/profile/${encodeURIComponent(userId)}`).json()
}

HttpAPI.prototype.getMediaContentUrl = function (url) {
  const mxcUrl = url.replace('mxc://','') 
  return (new URL(`/_matrix/media/v3/download/${mxcUrl}`, this.credentials.home_server_url)).toString()  
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
  Object.entries(options).forEach(([key, value]) => {
    if (!value) delete searchParams[key]
  })
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

/**
 * Execute an outgoing crypto request against the appropriate Matrix endpoint.
 * @param {Object} request - An outgoing request from OlmMachine (KeysUpload, KeysQuery, KeysClaim, ToDevice, SignatureUpload, RoomMessage)
 * @returns {string} JSON-encoded response body
 */
HttpAPI.prototype.sendOutgoingCryptoRequest = async function (request) {
  const log = getLogger()
  const body = request.body

  switch (request.type) {
    case RequestType.KeysUpload: {
      log.debug('Sending keys/upload request')
      const response = await this.client.post('v3/keys/upload', { body, headers: { 'Content-Type': 'application/json' } }).text()
      return response
    }

    case RequestType.KeysQuery: {
      log.debug('Sending keys/query request')
      const response = await this.client.post('v3/keys/query', { body, headers: { 'Content-Type': 'application/json' } }).text()
      return response
    }

    case RequestType.KeysClaim: {
      log.debug('Sending keys/claim request')
      const response = await this.client.post('v3/keys/claim', { body, headers: { 'Content-Type': 'application/json' } }).text()
      return response
    }

    case RequestType.ToDevice: {
      const eventType = request.event_type
      const txnId = request.txn_id
      log.debug('Sending to-device request:', eventType)
      const response = await this.client.put(
        `v3/sendToDevice/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`,
        { body, headers: { 'Content-Type': 'application/json' } }
      ).text()
      return response
    }

    case RequestType.SignatureUpload: {
      log.debug('Sending signature upload request')
      const response = await this.client.post('v3/keys/signatures/upload', { body, headers: { 'Content-Type': 'application/json' } }).text()
      return response
    }

    case RequestType.RoomMessage: {
      const roomId = request.room_id
      const eventType = request.event_type
      const txnId = request.txn_id
      log.debug('Sending room message request:', eventType, 'to', roomId)
      const content = JSON.parse(body)
      const result = await this.sendMessageEvent(roomId, eventType, content, txnId)
      return JSON.stringify(result)
    }

    default:
      log.warn('Unknown outgoing request type:', request.type)
      return '{}'
  }
}

/**
 * Process all outgoing requests from the CryptoManager.
 * @param {import('./crypto.mjs').CryptoManager} cryptoManager
 */
HttpAPI.prototype.processOutgoingCryptoRequests = async function (cryptoManager) {
  const requests = await cryptoManager.outgoingRequests()
  for (const request of requests) {
    try {
      const response = await this.sendOutgoingCryptoRequest(request)
      await cryptoManager.markRequestAsSent(request.id, request.type, response)
    } catch (error) {
      getLogger().error('Failed to process outgoing crypto request:', error.message)
    }
  }
}

export {
  HttpAPI
}
