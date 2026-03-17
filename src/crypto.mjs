import {
  initAsync,
  OlmMachine,
  StoreHandle,
  UserId,
  DeviceId,
  DeviceLists,
  RequestType,
  RoomId,
  RoomSettings,
  EncryptionAlgorithm,
  DecryptionSettings,
  TrustRequirement,
  VerificationMethod,
  VerificationRequestPhase,
  EncryptionSettings
} from '@matrix-org/matrix-sdk-crypto-wasm'
import { getLogger } from './logger.mjs'

class CryptoManager {
  constructor () {
    this.olmMachine = null
    this.storeHandle = null
  }

  /**
   * Initialize with an in-memory store (no persistence).
   * Use initializeWithStore() for persistent crypto state.
   * @param {string} userId
   * @param {string} deviceId
   */
  async initialize (userId, deviceId) {
    const log = getLogger()
    await initAsync()
    this.olmMachine = await OlmMachine.initialize(
      new UserId(userId),
      new DeviceId(deviceId)
    )
    log.info('OlmMachine initialized (in-memory) for', userId, deviceId)
  }

  /**
   * Initialize with a persistent IndexedDB-backed store.
   * Crypto state (Olm/Megolm sessions, device keys) survives restarts.
   * @param {string} userId
   * @param {string} deviceId
   * @param {string} storeName - IndexedDB database name (e.g. 'crypto-<projectUUID>')
   * @param {string} [passphrase] - Optional passphrase to encrypt the store
   */
  async initializeWithStore (userId, deviceId, storeName, passphrase) {
    const log = getLogger()
    await initAsync()

    if (passphrase) {
      this.storeHandle = await StoreHandle.open(storeName, passphrase)
    } else {
      this.storeHandle = await StoreHandle.open(storeName)
    }

    this.olmMachine = await OlmMachine.initFromStore(
      new UserId(userId),
      new DeviceId(deviceId),
      this.storeHandle
    )
    log.info('OlmMachine initialized (persistent) for', userId, deviceId, 'store:', storeName)
  }

  /**
   * Process outgoing requests (key uploads, key queries, key claims, to-device messages).
   * Returns array of request objects that the caller must execute via HTTP.
   */
  async outgoingRequests () {
    if (!this.olmMachine) throw new Error('CryptoManager not initialized')
    return this.olmMachine.outgoingRequests()
  }

  /**
   * Mark an outgoing request as sent (after HTTP call succeeded).
   * @param {string} requestId
   * @param {RequestType} requestType
   * @param {string} responseBody - JSON-encoded response body
   */
  async markRequestAsSent (requestId, requestType, responseBody) {
    if (!this.olmMachine) throw new Error('CryptoManager not initialized')
    await this.olmMachine.markRequestAsSent(requestId, requestType, responseBody)
  }

  /**
   * Feed sync response data into the OlmMachine.
   * @param {Array} toDeviceEvents - to_device.events from sync response
   * @param {Object} changedDeviceLists - device_lists from sync response
   * @param {Object} oneTimeKeyCounts - device_one_time_keys_count from sync response
   * @param {Array} unusedFallbackKeys - device_unused_fallback_key_types from sync response
   */
  async receiveSyncChanges (toDeviceEvents, changedDeviceLists, oneTimeKeyCounts, unusedFallbackKeys) {
    if (!this.olmMachine) throw new Error('CryptoManager not initialized')
    const log = getLogger()

    const changed = (changedDeviceLists?.changed || []).map(id => new UserId(id))
    const left = (changedDeviceLists?.left || []).map(id => new UserId(id))
    const deviceLists = new DeviceLists(changed, left)

    const otkeyCounts = new Map(Object.entries(oneTimeKeyCounts || {}))
    const fallbackKeys = unusedFallbackKeys
      ? new Set(unusedFallbackKeys)
      : null

    const result = await this.olmMachine.receiveSyncChanges(
      JSON.stringify(toDeviceEvents || []),
      deviceLists,
      otkeyCounts,
      fallbackKeys
    )

    // Check for Olm-decrypted ODIN historical key sharing events.
    // These are sent as m.room.encrypted to_device events with inner type
    // io.syncpoint.odin.room_keys. After Olm decryption, the OlmMachine
    // returns them as DecryptedToDeviceEvent with rawEvent containing
    // the decrypted payload.
    try {
      const processed = Array.isArray(result) ? result : []
      for (const item of processed) {
        if (!item.rawEvent) continue
        const raw = JSON.parse(item.rawEvent)
        if (raw.type === 'io.syncpoint.odin.room_keys') {
          // content is a JSON string (from encryptToDeviceEvent), parse it
          const content = typeof raw.content === 'string' ? JSON.parse(raw.content) : raw.content
          const keys = content?.keys
          const roomId = content?.room_id
          if (keys && keys.length > 0) {
            log.info(`Received ${keys.length} historical room keys for room ${roomId}`)
            await this.importRoomKeys(JSON.stringify(keys))
          }
        }
      }
    } catch (err) {
      log.debug('Error processing to_device events:', err.message)
    }

    log.debug('Sync changes processed')
    return result
  }

  /**
   * Encrypt a room event.
   * @param {string} roomId
   * @param {string} eventType
   * @param {Object} content
   * @returns {Object} encrypted content to send as m.room.encrypted
   */
  async encryptRoomEvent (roomId, eventType, content) {
    if (!this.olmMachine) throw new Error('CryptoManager not initialized')
    const encrypted = await this.olmMachine.encryptRoomEvent(
      new RoomId(roomId),
      eventType,
      JSON.stringify(content)
    )
    return JSON.parse(encrypted)
  }

  /**
   * Decrypt a room event.
   * @param {Object} event - the raw event object
   * @param {string} roomId
   * @returns {Object|null} decrypted event info or null on failure
   */
  async decryptRoomEvent (event, roomId) {
    if (!this.olmMachine) throw new Error('CryptoManager not initialized')
    const log = getLogger()
    try {
      const decryptionSettings = new DecryptionSettings(TrustRequirement.Untrusted)
      const decrypted = await this.olmMachine.decryptRoomEvent(
        JSON.stringify(event),
        new RoomId(roomId),
        decryptionSettings
      )
      return {
        event: JSON.parse(decrypted.event),
        senderCurve25519Key: decrypted.senderCurve25519Key,
        senderClaimedEd25519Key: decrypted.senderClaimedEd25519Key
      }
    } catch (error) {
      log.error('Failed to decrypt event in room', roomId, error.message)
      return null
    }
  }

  /**
   * Share room keys with the given users so they can decrypt messages.
   * Returns an array of outgoing requests (ToDeviceRequests) to send.
   * @param {string} roomId
   * @param {string[]} userIds
   */
  async shareRoomKey (roomId, userIds) {
    if (!this.olmMachine) throw new Error('CryptoManager not initialized')
    const settings = new EncryptionSettings()
    const users = userIds.map(id => new UserId(id))
    return this.olmMachine.shareRoomKey(new RoomId(roomId), users, settings)
  }

  /**
   * Get missing Olm sessions for the given users.
   * @param {string[]} userIds
   * @returns {KeysClaimRequest|undefined}
   */
  async getMissingSessions (userIds) {
    if (!this.olmMachine) throw new Error('CryptoManager not initialized')
    const users = userIds.map(id => new UserId(id))
    return this.olmMachine.getMissingSessions(users)
  }

  /**
   * Update tracked users (needed for key queries).
   * @param {string[]} userIds
   */
  async updateTrackedUsers (userIds) {
    if (!this.olmMachine) throw new Error('CryptoManager not initialized')
    await this.olmMachine.updateTrackedUsers(userIds.map(id => new UserId(id)))
  }

  /**
   * Explicitly query device keys for users.
   * Returns a KeysQueryRequest that must be sent via HTTP.
   * @param {string[]} userIds
   * @returns {Object|undefined} KeysQueryRequest or undefined
   */
  async queryKeysForUsers (userIds) {
    if (!this.olmMachine) throw new Error('CryptoManager not initialized')
    return this.olmMachine.queryKeysForUsers(userIds.map(id => new UserId(id)))
  }

  /**
   * Register a room as encrypted with the OlmMachine.
   * Must be called when a room with m.room.encryption state is discovered.
   * @param {string} roomId
   * @param {Object} [encryptionContent] - Content of the m.room.encryption state event
   */
  async setRoomEncryption (roomId, encryptionContent = {}) {
    if (!this.olmMachine) throw new Error('CryptoManager not initialized')
    const log = getLogger()
    const settings = new RoomSettings(EncryptionAlgorithm.MegolmV1AesSha2, false, false)
    await this.olmMachine.setRoomSettings(new RoomId(roomId), settings)
    log.debug('Room encryption registered:', roomId)
  }

  /**
   * Export all Megolm session keys for a specific room.
   * Returns a JSON-encoded array of ExportedRoomKey objects.
   * @param {string} roomId
   * @returns {string} JSON-encoded exported keys
   */
  async exportRoomKeys (roomId) {
    if (!this.olmMachine) throw new Error('CryptoManager not initialized')
    const targetRoomId = roomId
    const exported = await this.olmMachine.exportRoomKeys(
      (session) => session.roomId.toString() === targetRoomId
    )
    return exported
  }

  /**
   * Import previously exported room keys.
   * @param {string} exportedKeys - JSON-encoded array of ExportedRoomKey objects
   * @returns {Object} import result with total_count and imported_count
   */
  async importRoomKeys (exportedKeys) {
    if (!this.olmMachine) throw new Error('CryptoManager not initialized')
    const log = getLogger()
    const result = await this.olmMachine.importRoomKeys(exportedKeys, (progress, total) => {
      log.debug(`Importing room keys: ${progress}/${total}`)
    })
    const parsed = JSON.parse(result)
    log.info(`Imported ${parsed.imported_count}/${parsed.total_count} room keys`)
    return parsed
  }

  /**
   * Share all historical Megolm session keys for a room with a specific user.
   * Keys are Olm-encrypted per-device and sent as m.room.encrypted to_device.
   * After Olm decryption on the receiving side, the inner event type is
   * io.syncpoint.odin.room_keys with the exported session keys as content.
   *
   * @param {string} roomId
   * @param {string} userId - the target user
   * @returns {{ toDeviceMessages: Object, keyCount: number }}
   */
  async shareHistoricalRoomKeys (roomId, userId) {
    if (!this.olmMachine) throw new Error('CryptoManager not initialized')
    const log = getLogger()

    const exported = await this.exportRoomKeys(roomId)
    const keys = JSON.parse(exported)
    if (keys.length === 0) {
      log.info(`No session keys to share for room ${roomId}`)
      return { toDeviceMessages: {}, keyCount: 0 }
    }

    log.info(`Sharing ${keys.length} historical session keys for room ${roomId} with ${userId}`)

    const userDevices = await this.olmMachine.getUserDevices(new UserId(userId))
    const devices = userDevices.devices()

    if (devices.length === 0) {
      log.warn(`No devices found for ${userId}, cannot share historical keys`)
      return { toDeviceMessages: {}, keyCount: 0 }
    }

    // Olm-encrypt the key bundle for each device
    const messages = {}
    for (const device of devices) {
      try {
        const payload = JSON.stringify({ keys, room_id: roomId })
        const encrypted = await device.encryptToDeviceEvent(
          'io.syncpoint.odin.room_keys',
          payload
        )
        messages[device.deviceId.toString()] = JSON.parse(encrypted)
      } catch (err) {
        log.warn(`Failed to encrypt keys for device ${device.deviceId}: ${err.message}`)
      }
    }

    return { toDeviceMessages: { [userId]: messages }, keyCount: keys.length }
  }

  // ─── Device Verification (SAS) ─────────────────────────────────────

  /**
   * Request interactive SAS verification with a specific user's device.
   * Sends an m.key.verification.request to_device event.
   *
   * @param {string} userId - the user to verify
   * @param {string} deviceId - the device to verify
   * @returns {{ request: VerificationRequest, toDeviceRequest: Object }} the request object and outgoing to_device message
   */
  async requestVerification (userId, deviceId) {
    if (!this.olmMachine) throw new Error('CryptoManager not initialized')
    const log = getLogger()
    const userDevices = await this.olmMachine.getUserDevices(new UserId(userId))
    const device = userDevices.get(new DeviceId(deviceId))
    if (!device) throw new Error(`Device ${deviceId} not found for ${userId}`)

    const [request, toDeviceRequest] = device.requestVerification(
      [VerificationMethod.SasV1]
    )
    log.info(`Verification requested for ${userId} device ${deviceId}`)
    return { request, toDeviceRequest }
  }

  /**
   * Get a pending verification request for a user.
   *
   * @param {string} userId
   * @param {string} flowId - the verification flow id
   * @returns {VerificationRequest|undefined}
   */
  getVerificationRequest (userId, flowId) {
    if (!this.olmMachine) throw new Error('CryptoManager not initialized')
    return this.olmMachine.getVerificationRequest(new UserId(userId), flowId)
  }

  /**
   * Get all pending verification requests for a user.
   *
   * @param {string} userId
   * @returns {VerificationRequest[]}
   */
  getVerificationRequests (userId) {
    if (!this.olmMachine) throw new Error('CryptoManager not initialized')
    return this.olmMachine.getVerificationRequests(new UserId(userId))
  }

  /**
   * Accept an incoming verification request and signal support for SAS.
   * Returns an outgoing request to send.
   *
   * @param {VerificationRequest} request
   * @returns {Object|undefined} outgoing ToDeviceRequest or RoomMessageRequest
   */
  acceptVerification (request) {
    return request.acceptWithMethods([VerificationMethod.SasV1])
  }

  /**
   * Transition a ready verification request into SAS verification.
   * Both sides must have accepted before calling this.
   *
   * @param {VerificationRequest} request
   * @returns {{ sas: Sas, request: Object }|undefined} the SAS state machine and outgoing request
   */
  async startSas (request) {
    if (!request.isReady()) return undefined
    const result = await request.startSas()
    if (!result) return undefined
    const [sas, outgoingRequest] = result
    getLogger().info('SAS verification started')
    return { sas, request: outgoingRequest }
  }

  /**
   * Get the SAS object from a transitioned verification request.
   *
   * @param {VerificationRequest} request
   * @returns {Sas|undefined}
   */
  getSas (request) {
    return request.getVerification()
  }

  /**
   * Get the 7 emojis for SAS comparison.
   * Both sides display these emojis — if they match, the verification is genuine.
   *
   * @param {Sas} sas
   * @returns {Array<{symbol: string, description: string}>|undefined}
   */
  getEmojis (sas) {
    if (!sas.canBePresented()) return undefined
    const emojis = sas.emoji()
    if (!emojis) return undefined
    return emojis.map(e => ({ symbol: e.symbol, description: e.description }))
  }

  /**
   * Confirm that the SAS emojis match.
   * This marks the other device as verified.
   *
   * @param {Sas} sas
   * @returns {Object[]} array of outgoing requests to send (signatures, done events)
   */
  async confirmSas (sas) {
    const requests = await sas.confirm()
    getLogger().info('SAS verification confirmed')
    return requests || []
  }

  /**
   * Cancel a SAS verification.
   *
   * @param {Sas} sas
   * @returns {Object|undefined} outgoing cancel request
   */
  cancelSas (sas) {
    return sas.cancel()
  }

  /**
   * Cancel a verification request (before SAS has started).
   *
   * @param {VerificationRequest} request
   * @returns {Object|undefined} outgoing cancel request
   */
  cancelVerification (request) {
    return request.cancel()
  }

  /**
   * Check if a specific device is verified (cross-signed or locally trusted).
   *
   * @param {string} userId
   * @param {string} deviceId
   * @returns {boolean}
   */
  async isDeviceVerified (userId, deviceId) {
    if (!this.olmMachine) throw new Error('CryptoManager not initialized')
    const userDevices = await this.olmMachine.getUserDevices(new UserId(userId))
    const device = userDevices.get(new DeviceId(deviceId))
    if (!device) return false
    return device.isCrossSigningTrusted() || device.isLocallyTrusted()
  }

  /**
   * Get verification status for all devices of a user.
   *
   * @param {string} userId
   * @returns {Array<{deviceId: string, verified: boolean, locallyTrusted: boolean, crossSigningTrusted: boolean}>}
   */
  async getDeviceVerificationStatus (userId) {
    if (!this.olmMachine) throw new Error('CryptoManager not initialized')
    const userDevices = await this.olmMachine.getUserDevices(new UserId(userId))
    const devices = userDevices.devices()
    return devices.map(d => ({
      deviceId: d.deviceId.toString(),
      verified: d.isCrossSigningTrusted() || d.isLocallyTrusted(),
      locallyTrusted: d.isLocallyTrusted(),
      crossSigningTrusted: d.isCrossSigningTrusted()
    }))
  }

  /**
   * Get the current phase of a verification request.
   *
   * @param {VerificationRequest} request
   * @returns {string} phase name: 'Created', 'Requested', 'Ready', 'Transitioned', 'Done', 'Cancelled'
   */
  getVerificationPhase (request) {
    const phase = request.phase()
    const names = { 0: 'Created', 1: 'Requested', 2: 'Ready', 3: 'Transitioned', 4: 'Done', 5: 'Cancelled' }
    return names[phase] || `Unknown(${phase})`
  }

  /**
   * Close the crypto store and release resources.
   * After closing, the CryptoManager must be re-initialized before use.
   */
  async close () {
    const log = getLogger()
    if (this.storeHandle) {
      this.storeHandle.free()
      this.storeHandle = null
      log.debug('Crypto store handle released')
    }
    this.olmMachine = null
  }

  /**
   * Whether this CryptoManager uses a persistent store.
   */
  get isPersistent () {
    return this.storeHandle !== null
  }

  get identityKeys () {
    return this.olmMachine?.identityKeys
  }

  get deviceId () {
    return this.olmMachine?.deviceId
  }

  get userId () {
    return this.olmMachine?.userId
  }
}

export { CryptoManager, RequestType, VerificationMethod, VerificationRequestPhase }
