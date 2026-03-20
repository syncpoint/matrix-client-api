import { getLogger } from './logger.mjs'

/**
 * High-level facade that encapsulates all crypto orchestration.
 *
 * Owns the CryptoManager and HttpAPI references. No other module should
 * import or interact with CryptoManager directly — they receive narrow
 * callback functions wired through this facade at composition time.
 *
 * Responsibilities:
 *  - Feed sync response data into the OlmMachine
 *  - Decrypt room events
 *  - Register rooms as encrypted
 *  - Full encrypt ceremony (track → queryKeys → claimSessions → shareRoomKey → encrypt → processOutgoing)
 *  - Share historical Megolm session keys with specific users
 *  - Process pending outgoing crypto requests
 */
class CryptoFacade {
  /**
   * @param {import('./crypto.mjs').CryptoManager} cryptoManager
   * @param {import('./http-api.mjs').HttpAPI} httpAPI
   */
  constructor (cryptoManager, httpAPI) {
    this.cryptoManager = cryptoManager
    this.httpAPI = httpAPI
  }

  /**
   * Process all pending outgoing crypto requests from the OlmMachine.
   * Each request is sent via the appropriate HTTP endpoint, then marked as sent.
   */
  async processOutgoingRequests () {
    const log = getLogger()
    const requests = await this.cryptoManager.outgoingRequests()
    for (const request of requests) {
      try {
        const response = await this.httpAPI.sendOutgoingCryptoRequest(request)
        await this.cryptoManager.markRequestAsSent(request.id, request.type, response)
      } catch (error) {
        log.error('Failed to process outgoing crypto request:', error.message)
      }
    }
  }

  /**
   * Feed sync response data into the OlmMachine and process outgoing requests.
   *
   * @param {Object} syncData
   * @param {Array}  syncData.toDeviceEvents  - to_device.events from sync response
   * @param {Object} syncData.deviceLists     - device_lists from sync response
   * @param {Object} syncData.oneTimeKeyCounts - device_one_time_keys_count from sync response
   * @param {Array}  [syncData.unusedFallbackKeys] - device_unused_fallback_key_types from sync response
   */
  async processSyncResponse ({ toDeviceEvents, deviceLists, oneTimeKeyCounts, unusedFallbackKeys }) {
    await this.cryptoManager.receiveSyncChanges(toDeviceEvents, deviceLists, oneTimeKeyCounts, unusedFallbackKeys)
    await this.processOutgoingRequests()
  }

  /**
   * Decrypt a single room event.
   *
   * Returns a transformed event with the decrypted type and content merged
   * onto the original envelope, or null if decryption fails.
   *
   * @param {Object} event  - The raw m.room.encrypted event
   * @param {string} roomId
   * @returns {Promise<Object|null>} The decrypted event or null
   */
  async decryptEvent (event, roomId) {
    const decrypted = await this.cryptoManager.decryptRoomEvent(event, roomId)
    if (decrypted) {
      return {
        ...event,
        type: decrypted.event.type,
        content: decrypted.event.content,
        decrypted: true
      }
    }
    getLogger().warn('Could not decrypt event in room', roomId, event.event_id)
    return null
  }

  /**
   * Register a room as encrypted with the OlmMachine.
   *
   * @param {string} roomId
   */
  async registerRoom (roomId) {
    await this.cryptoManager.setRoomEncryption(roomId)
  }

  /**
   * Full encrypt ceremony for a room event.
   *
   * Performs the complete sequence: track users → query device keys →
   * process outgoing → claim missing Olm sessions → share Megolm room key →
   * process outgoing → encrypt the event.
   *
   * The caller provides memberIds (fetched from the Matrix API). The facade
   * does NOT fetch members itself — that is the caller's responsibility.
   *
   * @param {string}   roomId
   * @param {string}   eventType
   * @param {Object}   content
   * @param {string[]} memberIds - Room members' user IDs
   * @returns {Promise<Object>} Encrypted content to send as m.room.encrypted
   */
  async encryptEvent (roomId, eventType, content, memberIds) {
    const log = getLogger()

    // 1. Track users and explicitly query their device keys
    await this.cryptoManager.updateTrackedUsers(memberIds)
    const keysQueryRequest = await this.cryptoManager.queryKeysForUsers(memberIds)
    if (keysQueryRequest) {
      log.debug('E2EE: querying device keys for', memberIds.length, 'users')
      const queryResponse = await this.httpAPI.sendOutgoingCryptoRequest(keysQueryRequest)
      await this.cryptoManager.markRequestAsSent(keysQueryRequest.id, keysQueryRequest.type, queryResponse)
    }

    // 2. Process any other pending outgoing requests
    await this.processOutgoingRequests()

    // 3. Claim missing Olm sessions
    const claimRequest = await this.cryptoManager.getMissingSessions(memberIds)
    if (claimRequest) {
      log.debug('E2EE: claiming missing Olm sessions')
      const claimResponse = await this.httpAPI.sendOutgoingCryptoRequest(claimRequest)
      await this.cryptoManager.markRequestAsSent(claimRequest.id, claimRequest.type, claimResponse)
    }

    // 4. Share Megolm session key with all room members' devices
    const shareRequests = await this.cryptoManager.shareRoomKey(roomId, memberIds)
    log.debug('E2EE: shareRoomKey returned', shareRequests.length, 'to_device requests')
    for (const req of shareRequests) {
      try {
        const body = JSON.parse(req.body)
        const reqEventType = req.event_type || req.eventType || 'unknown'
        log.debug(`E2EE: to_device type=${reqEventType}`)
        if (body.messages) {
          for (const [userId, devices] of Object.entries(body.messages)) {
            for (const [deviceId] of Object.entries(devices)) {
              log.debug(`E2EE:   → ${userId} / ${deviceId}`)
            }
          }
        }
      } catch { /* ignore parse errors */ }
      const resp = await this.httpAPI.sendOutgoingCryptoRequest(req)
      await this.cryptoManager.markRequestAsSent(req.id, req.type, resp)
    }

    // 5. Process any remaining outgoing requests
    await this.processOutgoingRequests()

    // 6. Encrypt the actual message
    const encrypted = await this.cryptoManager.encryptRoomEvent(roomId, eventType, content)
    log.debug('E2EE: message encrypted for room', roomId)
    return encrypted
  }

  /**
   * Share historical Megolm session keys for a room with specific users.
   *
   * Fully self-contained: handles track → queryKeys → claimSessions →
   * export → olm-encrypt → sendToDevice for each target user.
   *
   * @param {string}   roomId
   * @param {string[]} userIds - Target users to share keys with
   */
  async shareHistoricalKeys (roomId, userIds) {
    const log = getLogger()

    try {
      for (const userId of userIds) {
        try {
          // Ensure we have the user's device keys
          await this.cryptoManager.updateTrackedUsers([userId])
          const keysQueryRequest = await this.cryptoManager.queryKeysForUsers([userId])
          if (keysQueryRequest) {
            const queryResponse = await this.httpAPI.sendOutgoingCryptoRequest(keysQueryRequest)
            await this.cryptoManager.markRequestAsSent(keysQueryRequest.id, keysQueryRequest.type, queryResponse)
          }

          // Establish Olm sessions if needed
          const claimRequest = await this.cryptoManager.getMissingSessions([userId])
          if (claimRequest) {
            const claimResponse = await this.httpAPI.sendOutgoingCryptoRequest(claimRequest)
            await this.cryptoManager.markRequestAsSent(claimRequest.id, claimRequest.type, claimResponse)
          }

          // Export and share historical keys
          const { toDeviceMessages, keyCount } = await this.cryptoManager.shareHistoricalRoomKeys(roomId, userId)
          if (keyCount > 0) {
            const txnId = `odin_keyshare_${Date.now()}_${Math.random().toString(36).slice(2)}`
            await this.httpAPI.sendToDevice('m.room.encrypted', txnId, toDeviceMessages)
            log.info(`Shared ${keyCount} historical keys with ${userId} for room ${roomId}`)
          }
        } catch (err) {
          log.warn(`Failed to share historical keys with ${userId}: ${err.message}`)
        }
      }
    } catch (err) {
      log.warn(`Failed to share historical keys for room ${roomId}: ${err.message}`)
    }
  }
}

export { CryptoFacade }
