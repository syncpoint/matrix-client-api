import { FIFO } from './queue.mjs'
import { getLogger } from './logger.mjs'

class CommandAPI {
  /**
   * @param {import('./http-api.mjs').HttpAPI} httpAPI
   * @param {import('./crypto.mjs').CryptoManager} [cryptoManager] - Optional CryptoManager for E2EE
   */
  constructor (httpAPI, cryptoManager) {
    this.httpAPI = httpAPI
    this.cryptoManager = cryptoManager || null
    this.scheduledCalls = new FIFO()
  }

  /**
   * @param {FunctionCall} functionCall
   * @description A functionCall is an array of parameters. The first is the name of the function that will be called. 
   * All other params (0..n) must meet the signature of that function.
   * 
   * There is no way to retrieve the returning result of that function.
   */
  schedule (functionCall) {
    const [functionName] = functionCall
    // Allow scheduling async callback functions directly
    if (typeof functionName === 'function') {
      this.scheduledCalls.enqueue(functionCall)
      return
    }
    if (!this.httpAPI[functionName]) throw new Error(`HttpAPI: property ${functionName} does not exist`)
    if (typeof this.httpAPI[functionName] !== 'function') throw new Error(`HttpAPI: ${functionName} is not a function`)
    this.scheduledCalls.enqueue(functionCall)
  }


  async run () {

      /**
   * @param {Number} retryCounter 
   * @returns A promise that resolves after a calculated time depending on the retryCounter using an exponential back-off algorithm. The max. delay is 30s.
   */
    const chill = retryCounter => new Promise(resolve => {
      const BACKOFF_FACTOR = 0.5
      const BACKOFF_LIMIT = 30_000
      const delay = Math.min(BACKOFF_LIMIT, (retryCounter === 0 ? 0 : BACKOFF_FACTOR * (2 ** (retryCounter)) * 1000))
      setTimeout(() => {
        resolve()
      }, delay)
    })

    if (this.controller) return
    this.controller = new AbortController()
    
    let retryCounter = 0
    let functionCall

    while (!this.controller.signal.aborted) {
      try {
        await chill(retryCounter)

        functionCall = await this.scheduledCalls.dequeue()
        let [functionName, ...params] = functionCall

        // Execute callback functions scheduled in the queue
        if (typeof functionName === 'function') {
          await functionName(...params)
          retryCounter = 0
          continue
        }

        // Encrypt outgoing message events if crypto is available
        if (this.cryptoManager && functionName === 'sendMessageEvent') {
          const [roomId, eventType, content, ...rest] = params
          const log = getLogger()
          try {
            // 1. Get room members
            const members = await this.httpAPI.members(roomId)
            const memberIds = (members.chunk || [])
              .filter(e => e.content?.membership === 'join')
              .map(e => e.state_key)
              .filter(Boolean)
            log.debug('E2EE: room members:', memberIds)

            // 2. Track users and explicitly query their device keys
            await this.cryptoManager.updateTrackedUsers(memberIds)
            const keysQueryRequest = await this.cryptoManager.queryKeysForUsers(memberIds)
            if (keysQueryRequest) {
              log.debug('E2EE: querying device keys for', memberIds.length, 'users')
              const queryResponse = await this.httpAPI.sendOutgoingCryptoRequest(keysQueryRequest)
              await this.cryptoManager.markRequestAsSent(keysQueryRequest.id, keysQueryRequest.type, queryResponse)
            }

            // 3. Process any other pending outgoing requests
            await this.httpAPI.processOutgoingCryptoRequests(this.cryptoManager)

            // 4. Claim missing Olm sessions
            const claimRequest = await this.cryptoManager.getMissingSessions(memberIds)
            if (claimRequest) {
              log.debug('E2EE: claiming missing Olm sessions')
              const claimResponse = await this.httpAPI.sendOutgoingCryptoRequest(claimRequest)
              await this.cryptoManager.markRequestAsSent(claimRequest.id, claimRequest.type, claimResponse)
            }

            // 5. Share Megolm session key with all room members' devices
            const shareRequests = await this.cryptoManager.shareRoomKey(roomId, memberIds)
            log.debug('E2EE: shareRoomKey returned', shareRequests.length, 'to_device requests')
            for (const req of shareRequests) {
              // Log which devices receive keys vs withheld
              try {
                const body = JSON.parse(req.body)
                const eventType = req.event_type || req.eventType || 'unknown'
                log.debug(`E2EE: to_device type=${eventType}`)
                if (body.messages) {
                  for (const [userId, devices] of Object.entries(body.messages)) {
                    for (const [deviceId, content] of Object.entries(devices)) {
                      log.debug(`E2EE:   → ${userId} / ${deviceId}`)
                    }
                  }
                }
              } catch { /* ignore parse errors */ }
              const resp = await this.httpAPI.sendOutgoingCryptoRequest(req)
              await this.cryptoManager.markRequestAsSent(req.id, req.type, resp)
            }

            // 6. Process any remaining outgoing requests
            await this.httpAPI.processOutgoingCryptoRequests(this.cryptoManager)

            // 7. Encrypt the actual message
            const encrypted = await this.cryptoManager.encryptRoomEvent(roomId, eventType, content)
            log.debug('E2EE: message encrypted for room', roomId)
            params = [roomId, 'm.room.encrypted', encrypted, ...rest]
          } catch (encryptError) {
            log.warn('Encryption failed, sending unencrypted:', encryptError.message)
          }
        }

        await this.httpAPI[functionName].apply(this.httpAPI, params)
        const log = getLogger()
        log.debug('Command sent:', functionName)
        retryCounter = 0
      } catch (error) {
        const log = getLogger()
        log.warn('Command failed:', error.message)
        if (error.response?.statusCode === 403) {
          log.error('Command forbidden:', functionCall[0], error.response.body)
        }
        
        /*
          In most cases we will have to deal with socket errors. The users computer may
          be offline or the server might be unreachable.
        */
        this.scheduledCalls.requeue(functionCall)
        retryCounter++
      }
    }    
  }

  async stop () {
    this.controller?.abort()
    delete this.controller
  }
}

export {
  CommandAPI
}