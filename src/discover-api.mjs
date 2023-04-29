import { HttpAPI } from './http-api.mjs'

const errors = {
  IGNORE: 'IGNORE',
  FAIL_PROMPT: 'FAIL_PROMPT',
  FAIL_ERROR: 'FAIL_ERROR',
  ERROR: 'ERROR'
}

const discover =  async ({ home_server_url, user_id }) => {
  
  const serverUrl = home_server_url ? home_server_url : `https://${user_id.split(':')[1]}`

  const response = await HttpAPI.getWellKnownClientInfo(serverUrl)
  
  /*
    See implementation rules https://spec.matrix.org/v1.6/client-server-api/#well-known-uri
  */
  if (!response) return errors.FAIL_PROMPT
  if (response.status === 404) return errors.IGNORE
  try {
    const body = JSON.parse(response.body)
    const baseUrl = body['m.homeserver']?.base_url
    if (!baseUrl) return errors.FAIL_PROMPT
    return baseUrl
  } catch {
    return errors.FAIL_ERROR
  }
  
}


export {
  discover
}
