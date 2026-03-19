import { HttpAPI } from './src/http-api.mjs'
import { StructureAPI } from './src/structure-api.mjs'
import { TimelineAPI } from './src/timeline-api.mjs'
import { CommandAPI } from './src/command-api.mjs'
import { ProjectList } from './src/project-list.mjs'
import { Project } from './src/project.mjs'
import { discover, errors } from './src/discover-api.mjs'
import { setLogger, LEVELS, consoleLogger, noopLogger } from './src/logger.mjs'
import { chill } from './src/convenience.mjs'
import { CryptoManager, TrustRequirement, VerificationMethod, VerificationRequestPhase } from './src/crypto.mjs'
import { CryptoFacade } from './src/crypto-facade.mjs'

/*
  connect() resolves if the home_server can be connected. It does
  not fail but tries to connect endlessly
*/
const connect = (home_server_url) => async (controller) => {
  const MAX_CHILL_FACTOR = 64
  let chillFactor = 0
  let connected = false
  while (!connected || controller?.signal?.aborted) {
    await chill(chillFactor, controller?.signal)
    try {
      await discover({ home_server_url })
      connected = true
    } catch (error) {
      if (error.name === 'AbortError') throw error
      if (error.code === errors.FAIL_PROMPT) {
        connected = true
        continue
      }
      if (chillFactor < MAX_CHILL_FACTOR) chillFactor++
    }
  }
}

/**
 * @typedef {Object} LoginData
 * @property {String} user_id
 * @property {String} password
 * @property {String} home_server_url
 * @property {Object} [encryption] - Optional encryption configuration
 * @property {boolean} [encryption.enabled=false] - Enable E2EE
 * @property {string} [encryption.storeName] - IndexedDB store name for persistent crypto state (e.g. 'crypto-<projectUUID>')
 * @property {string} [encryption.passphrase] - Passphrase to encrypt the IndexedDB store
 * @property {Object} db - A levelup-compatible database instance for the persistent command queue
 *
 * @param {LoginData} loginData
 * @returns {Object} matrixClient
 */
const MatrixClient = (loginData) => {

  const encryption = loginData.encryption || null

  // Shared CryptoFacade instance – initialized once, reused across projectList/project calls
  let sharedFacade = null
  let cryptoInitialized = false

  /**
   * Get or create the shared CryptoFacade.
   * If encryption.storeName is provided, uses IndexedDB-backed persistent store.
   * Otherwise, uses in-memory store (keys lost on restart).
   * @param {HttpAPI} httpAPI
   * @returns {Promise<CryptoFacade|null>}
   */
  const getCrypto = async (httpAPI) => {
    if (!encryption?.enabled) return null
    if (sharedFacade) {
      // Reuse existing facade, just process any pending outgoing requests
      if (!cryptoInitialized) {
        await sharedFacade.processOutgoingRequests()
        cryptoInitialized = true
      }
      return sharedFacade
    }
    const credentials = httpAPI.credentials
    if (!credentials.device_id) {
      throw new Error('E2EE requires a device_id in credentials. Ensure a fresh login (delete .state.json if reusing saved credentials).')
    }
    const cryptoManager = new CryptoManager()

    if (encryption.storeName) {
      // Persistent store: crypto state survives restarts (requires IndexedDB, i.e. Electron/browser)
      await cryptoManager.initializeWithStore(
        credentials.user_id,
        credentials.device_id,
        encryption.storeName,
        encryption.passphrase
      )
    } else {
      // In-memory: keys are lost on restart (for testing or non-browser environments)
      await cryptoManager.initialize(credentials.user_id, credentials.device_id)
    }

    sharedFacade = new CryptoFacade(cryptoManager, httpAPI)
    await sharedFacade.processOutgoingRequests()
    cryptoInitialized = true
    return sharedFacade
  }

  return {
    connect: connect(loginData.home_server_url),

    projectList: async mostRecentCredentials => {
      const credentials = mostRecentCredentials ? mostRecentCredentials : (await HttpAPI.loginWithPassword(loginData))
      const httpAPI = new HttpAPI(credentials)
      const facade = await getCrypto(httpAPI)
      const projectListParames = {
        structureAPI: new StructureAPI(httpAPI),
        timelineAPI: new TimelineAPI(httpAPI, facade ? {
          onSyncResponse: (data) => facade.processSyncResponse(data),
          decryptEvent: (event, roomId) => facade.decryptEvent(event, roomId)
        } : {})
      }
      const projectList = new ProjectList(projectListParames)
      projectList.tokenRefreshed = handler => httpAPI.tokenRefreshed(handler)
      projectList.credentials = () => (httpAPI.credentials)
      return projectList
    },

    project: async mostRecentCredentials => {
      const credentials = mostRecentCredentials ? mostRecentCredentials : (await HttpAPI.loginWithPassword(loginData))
      const httpAPI = new HttpAPI(credentials)
      const facade = await getCrypto(httpAPI)
      const projectParams = {
        structureAPI: new StructureAPI(httpAPI),
        timelineAPI: new TimelineAPI(httpAPI, facade ? {
          onSyncResponse: (data) => facade.processSyncResponse(data),
          decryptEvent: (event, roomId) => facade.decryptEvent(event, roomId)
        } : {}),
        commandAPI: new CommandAPI(httpAPI, {
          encryptEvent: facade
            ? (roomId, type, content, memberIds) => facade.encryptEvent(roomId, type, content, memberIds)
            : null,
          db: loginData.db
        }),
        crypto: facade ? {
          isEnabled: true,
          registerRoom: (roomId, enc) => facade.registerRoom(roomId, enc),
          shareHistoricalKeys: (roomId, userIds) => facade.shareHistoricalKeys(roomId, userIds)
        } : { isEnabled: false }
      }
      const project = new Project(projectParams)
      project.tokenRefreshed = handler => httpAPI.tokenRefreshed(handler)
      project.credentials = () => (httpAPI.credentials)
      return project
    }
  }
}

export {
  MatrixClient,
  CryptoManager,
  TrustRequirement,
  VerificationMethod,
  VerificationRequestPhase,
  connect,
  discover,
  setLogger,
  LEVELS,
  consoleLogger,
  noopLogger
}
