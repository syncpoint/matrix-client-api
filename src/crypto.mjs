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
  TrustRequirement
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
    if (!this.olmMachine) return []
    return this.olmMachine.outgoingRequests()
  }

  /**
   * Mark an outgoing request as sent (after HTTP call succeeded).
   * @param {string} requestId
   * @param {RequestType} requestType
   * @param {string} responseBody - JSON-encoded response body
   */
  async markRequestAsSent (requestId, requestType, responseBody) {
    if (!this.olmMachine) return
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
    if (!this.olmMachine) return
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

    // Check for ODIN historical key sharing events in the decrypted to_device result.
    // These are Olm-encrypted events that the OlmMachine has decrypted for us.
    try {
      const processed = JSON.parse(result)
      const keyEvents = (processed || []).filter(e =>
        e.type === 'io.syncpoint.odin.room_keys' ||
        (e.content?.type === 'io.syncpoint.odin.room_keys')
      )
      for (const event of keyEvents) {
        const content = event.content || event
        const keys = content.keys
        const roomId = content.room_id
        if (keys && keys.length > 0) {
          log.info(`Received ${keys.length} historical room keys for room ${roomId}`)
          await this.importRoomKeys(JSON.stringify(keys))
        }
      }
    } catch (err) {
      // Result parsing may fail if it's not JSON array – that's fine, no key events
      log.debug('No ODIN key events in sync result')
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
    const { EncryptionSettings } = await import('@matrix-org/matrix-sdk-crypto-wasm')
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
    if (!this.olmMachine) return undefined
    const users = userIds.map(id => new UserId(id))
    return this.olmMachine.getMissingSessions(users)
  }

  /**
   * Update tracked users (needed for key queries).
   * @param {string[]} userIds
   */
  async updateTrackedUsers (userIds) {
    if (!this.olmMachine) return
    await this.olmMachine.updateTrackedUsers(userIds.map(id => new UserId(id)))
  }

  /**
   * Explicitly query device keys for users.
   * Returns a KeysQueryRequest that must be sent via HTTP.
   * @param {string[]} userIds
   * @returns {Object|undefined} KeysQueryRequest or undefined
   */
  async queryKeysForUsers (userIds) {
    if (!this.olmMachine) return undefined
    return this.olmMachine.queryKeysForUsers(userIds.map(id => new UserId(id)))
  }

  /**
   * Register a room as encrypted with the OlmMachine.
   * Must be called when a room with m.room.encryption state is discovered.
   * @param {string} roomId
   * @param {Object} [encryptionContent] - Content of the m.room.encryption state event
   */
  async setRoomEncryption (roomId, encryptionContent = {}) {
    if (!this.olmMachine) return
    const log = getLogger()
    const algorithm = encryptionContent.algorithm === 'm.megolm.v1.aes-sha2'
      ? EncryptionAlgorithm.MegolmV1AesSha2
      : EncryptionAlgorithm.MegolmV1AesSha2 // default to Megolm
    const settings = new RoomSettings(algorithm, false, false)
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
   * Keys are Olm-encrypted per-device and returned as to_device payloads.
   *
   * Used when inviting a user to an encrypted room so they can decrypt
   * existing content during replay/catch-up.
   *
   * Requires that the target user's devices are already tracked (call
   * updateTrackedUsers + queryKeysForUsers first) and Olm sessions are
   * established (call getMissingSessions first).
   *
   * @param {string} roomId
   * @param {string} userId - the invited user
   * @returns {{ toDeviceMessages: Object, keyCount: number }} messages keyed by device_id, and count of keys shared
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

    // Get the user's devices
    const userDevices = await this.olmMachine.getUserDevices(new UserId(userId))
    const devices = userDevices.devices()

    if (devices.length === 0) {
      log.warn(`No devices found for ${userId}, cannot share historical keys`)
      return { toDeviceMessages: {}, keyCount: 0 }
    }

    // Encrypt the key bundle for each device using Olm
    const messages = {}
    for (const device of devices) {
      try {
        const content = { keys, room_id: roomId }
        const encrypted = await device.encryptToDeviceEvent(
          'io.syncpoint.odin.room_keys',
          JSON.stringify(content)
        )
        messages[device.deviceId.toString()] = JSON.parse(encrypted)
      } catch (err) {
        log.warn(`Failed to encrypt keys for device ${device.deviceId}: ${err.message}`)
      }
    }

    return { toDeviceMessages: { [userId]: messages }, keyCount: keys.length }
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

export { CryptoManager, RequestType }
