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

const discover =  async function ({ home_server_url, user_id }) {
  
  const serverUrl = home_server_url ? home_server_url : `https://${user_id.split(':')[1]}`  

  try {
    /*
      See implementation rules https://spec.matrix.org/v1.7/client-server-api/#well-known-uri
    */
    let response
    response = await HttpAPI.getWellKnownClientInfo(serverUrl)

    const clientInfoStatusCodes = [200, 404]

    if (!clientInfoStatusCodes.includes(response.status)) throw new DiscoveryError('Well-Known client info URL not found', errors.FAIL_PROMPT)
    const clientInfo = response.status === 200 ? await response.json() : undefined
    const baseUrl =  (clientInfo) ? clientInfo['m.homeserver']?.base_url : serverUrl

    response = await HttpAPI.getVersions(baseUrl)
    if (response.status !== 200) throw new DiscoveryError('Matrix versions URL not found', errors.FAIL_PROMPT)
    const supported = await response.json()
    if (supported?.versions?.length > 0) return baseUrl
    else throw new DiscoveryError(`No meaningful response`, errors.ERROR)
  } catch (error) {
    if (error instanceof DiscoveryError) throw error
    throw new DiscoveryError(error.cause ? error.cause.message : error.message, error.ERROR)
  }
}


export {
  discover,
  errors,
  DiscoveryError
}
