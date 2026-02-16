import {
  initAsync,
  OlmMachine,
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
  }

  async initialize (userId, deviceId) {
    const log = getLogger()
    await initAsync()
    this.olmMachine = await OlmMachine.initialize(
      new UserId(userId),
      new DeviceId(deviceId)
    )
    log.info('OlmMachine initialized for', userId, deviceId)
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
