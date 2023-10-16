import { HttpAPI } from './http-api.mjs'

const errors = {
  IGNORE: 'IGNORE',
  FAIL_PROMPT: 'FAIL_PROMPT',
  FAIL_ERROR: 'FAIL_ERROR',
  ERROR: 'ERROR'
}

class DiscoveryError extends Error {
  constructor (message, errorCode) {
    super(message)
    this.code = errorCode
  }
}

const discover =  async ({ home_server_url, user_id }) => {
  
  const serverUrl = home_server_url ? home_server_url : `https://${user_id.split(':')[1]}`

  let supported
  let clientInfo

  try {
    clientInfo = await HttpAPI.getWellKnownClientInfo(serverUrl)
    const baseUrl = clientInfo['m.homeserver']?.base_url
    supported = await HttpAPI.getVersions(baseUrl)
    return baseUrl
  } catch (error) {
    /*
      See implementation rules https://spec.matrix.org/v1.7/client-server-api/#well-known-uri
    */
    if (!supported) throw new DiscoveryError(`No matrix server found at ${serverUrl}`, errors.FAIL_ERROR)
    if (!clientInfo) throw new DiscoveryError(`No well-known client information`, errors.FAIL_PROMPT)
  }
}


export {
  discover,
  errors
}
