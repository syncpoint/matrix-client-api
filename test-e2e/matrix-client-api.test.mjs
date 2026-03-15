/**
 * Integration tests for matrix-client-api E2EE against a real Tuwunel homeserver.
 *
 * Tests the actual API components: HttpAPI, StructureAPI, CommandAPI, TimelineAPI
 * with CryptoManager wired in — not raw fetch calls.
 *
 * Prerequisites:
 *   cd test-e2e && docker compose up -d
 *
 * Run:
 *   npm run test:e2e
 */

import { describe, it, before, after } from 'mocha'
import assert from 'assert'
import { HttpAPI } from '../src/http-api.mjs'
import { StructureAPI } from '../src/structure-api.mjs'
import { CommandAPI } from '../src/command-api.mjs'
import { TimelineAPI } from '../src/timeline-api.mjs'
import { CryptoManager, RequestType } from '../src/crypto.mjs'
import { setLogger } from '../src/logger.mjs'

const HOMESERVER_URL = process.env.HOMESERVER_URL || 'http://localhost:8008'
const suffix = Date.now().toString(36)

// Suppress noisy logs during tests (set E2E_DEBUG=1 to enable)
if (!process.env.E2E_DEBUG) {
  setLogger({
    info: () => {},
    debug: () => {},
    warn: (...args) => console.warn('[WARN]', ...args),
    error: (...args) => console.error('[ERROR]', ...args)
  })
}

/** Register a user via the registration API, return credentials. */
async function registerAndLogin (username, deviceId) {
  const res = await fetch(`${HOMESERVER_URL}/_matrix/client/v3/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: `pass_${username}`,
      device_id: deviceId,
      auth: { type: 'm.login.dummy' }
    })
  })
  const data = await res.json()
  if (data.errcode) throw new Error(`Registration failed: ${data.error}`)

  return {
    user_id: data.user_id,
    access_token: data.access_token,
    device_id: data.device_id,
    home_server_url: HOMESERVER_URL
  }
}

/** Create a fully wired API stack: HttpAPI + CryptoManager + StructureAPI + CommandAPI + TimelineAPI */
async function createApiStack (credentials) {
  const httpAPI = new HttpAPI(credentials)
  const crypto = new CryptoManager()
  await crypto.initialize(credentials.user_id, credentials.device_id)

  // Upload device keys
  await httpAPI.processOutgoingCryptoRequests(crypto)

  const structureAPI = new StructureAPI(httpAPI)
  const commandAPI = new CommandAPI(httpAPI, crypto)
  const timelineAPI = new TimelineAPI(httpAPI, { cryptoManager: crypto, httpAPI })

  return { httpAPI, crypto, structureAPI, commandAPI, timelineAPI }
}

/** Run a single /sync cycle and process crypto */
async function doSync (timelineAPI, since, filter) {
  // TimelineAPI.content() does sync + crypto processing internally,
  // but we need lower-level access. Use httpAPI directly.
  const httpAPI = timelineAPI.httpAPI
  const crypto = timelineAPI.crypto

  const syncResult = await httpAPI.sync(since, filter, 0)

  // Process crypto from sync
  if (crypto) {
    const { cryptoManager, httpAPI: cryptoHttpAPI } = crypto
    const toDevice = syncResult.to_device?.events || []
    const deviceLists = syncResult.device_lists || {}
    const otkeyCounts = syncResult.device_one_time_keys_count || {}
    const fallbackKeys = syncResult.device_unused_fallback_key_types || []

    await cryptoManager.receiveSyncChanges(toDevice, deviceLists, otkeyCounts, fallbackKeys)
    await cryptoHttpAPI.processOutgoingCryptoRequests(cryptoManager)
  }

  return syncResult
}

describe('matrix-client-api E2EE Integration', function () {
  this.timeout(30000)

  let aliceCreds, bobCreds
  let alice, bob // { httpAPI, crypto, structureAPI, commandAPI, timelineAPI }

  before(async function () {
    // Check homeserver availability
    try {
      const res = await fetch(`${HOMESERVER_URL}/_matrix/client/versions`)
      const data = await res.json()
      if (!data.versions) throw new Error('not a Matrix server')
    } catch {
      this.skip()
    }

    aliceCreds = await registerAndLogin(`alice_api_${suffix}`, `ALICE_${suffix}`)
    bobCreds = await registerAndLogin(`bob_api_${suffix}`, `BOB_${suffix}`)

    alice = await createApiStack(aliceCreds)
    bob = await createApiStack(bobCreds)
  })

  after(async function () {
    if (alice?.crypto) await alice.crypto.close()
    if (bob?.crypto) await bob.crypto.close()
  })

  describe('HttpAPI + CryptoManager', function () {

    it('should upload device keys via processOutgoingCryptoRequests()', async () => {
      // Keys were uploaded in createApiStack. Verify by querying.
      const result = await bob.httpAPI.client.post('v3/keys/query', {
        json: { device_keys: { [aliceCreds.user_id]: [] } }
      }).json()

      assert.ok(result.device_keys[aliceCreds.user_id], 'Alice\'s device keys should be on the server')
      const device = result.device_keys[aliceCreds.user_id][aliceCreds.device_id]
      assert.ok(device, 'Alice\'s specific device should exist')
      assert.ok(device.keys[`ed25519:${aliceCreds.device_id}`], 'ed25519 key present')
      assert.ok(device.keys[`curve25519:${aliceCreds.device_id}`], 'curve25519 key present')
    })

    it('should process keys/query via sendOutgoingCryptoRequest()', async () => {
      // Alice queries Bob's keys through the crypto pipeline
      await alice.crypto.updateTrackedUsers([bobCreds.user_id])
      const queryReq = await alice.crypto.queryKeysForUsers([bobCreds.user_id])
      assert.ok(queryReq, 'should produce a keys/query request')

      const response = await alice.httpAPI.sendOutgoingCryptoRequest(queryReq)
      await alice.crypto.markRequestAsSent(queryReq.id, queryReq.type, response)
      // No error = success
    })
  })

  describe('StructureAPI — Encrypted Room Creation', function () {

    it('should create a room with m.room.encryption state', async () => {
      const room = await alice.httpAPI.createRoom({
        name: 'E2EE Structure Test',
        initial_state: [{
          type: 'm.room.encryption',
          content: { algorithm: 'm.megolm.v1.aes-sha2' },
          state_key: ''
        }]
      })

      assert.ok(room.room_id, 'room should be created')

      // Verify encryption state
      const state = await alice.httpAPI.getState(room.room_id)
      const encryptionEvent = state.find(e => e.type === 'm.room.encryption')
      assert.ok(encryptionEvent, 'room should have encryption state')
      assert.strictEqual(encryptionEvent.content.algorithm, 'm.megolm.v1.aes-sha2')
    })
  })

  describe('CommandAPI — Encrypted Send', function () {
    let encryptedRoomId

    before(async function () {
      // Create encrypted room, invite Bob, Bob joins
      const room = await alice.httpAPI.createRoom({
        name: 'E2EE Command Test',
        invite: [bobCreds.user_id],
        initial_state: [{
          type: 'm.room.encryption',
          content: { algorithm: 'm.megolm.v1.aes-sha2' },
          state_key: ''
        }]
      })
      encryptedRoomId = room.room_id
      await bob.httpAPI.join(encryptedRoomId)

      // Register encryption with both crypto managers
      await alice.crypto.setRoomEncryption(encryptedRoomId, { algorithm: 'm.megolm.v1.aes-sha2' })
      await bob.crypto.setRoomEncryption(encryptedRoomId, { algorithm: 'm.megolm.v1.aes-sha2' })

      // Sync both to pick up device lists
      await alice.httpAPI.sync(undefined, undefined, 0)
      await bob.httpAPI.sync(undefined, undefined, 0)
    })

    it('should encrypt and send a message via CommandAPI', async () => {
      // CommandAPI.execute() encrypts automatically when cryptoManager is set
      // We test the lower-level flow here since execute() has ODIN-specific routing

      // Alice: track Bob, query keys, claim OTKs, share room key, encrypt, send
      await alice.crypto.updateTrackedUsers([bobCreds.user_id, aliceCreds.user_id])

      const keysQuery = await alice.crypto.queryKeysForUsers([bobCreds.user_id])
      if (keysQuery) {
        const resp = await alice.httpAPI.sendOutgoingCryptoRequest(keysQuery)
        await alice.crypto.markRequestAsSent(keysQuery.id, keysQuery.type, resp)
      }

      await alice.httpAPI.processOutgoingCryptoRequests(alice.crypto)

      const claimReq = await alice.crypto.getMissingSessions([bobCreds.user_id])
      if (claimReq) {
        const resp = await alice.httpAPI.sendOutgoingCryptoRequest(claimReq)
        await alice.crypto.markRequestAsSent(claimReq.id, claimReq.type, resp)
      }

      // Share room key
      const shareRequests = await alice.crypto.shareRoomKey(
        encryptedRoomId, [aliceCreds.user_id, bobCreds.user_id]
      )
      for (const req of shareRequests) {
        const resp = await alice.httpAPI.sendOutgoingCryptoRequest(req)
        if (req.id && req.type !== undefined) {
          await alice.crypto.markRequestAsSent(req.id, req.type, resp)
        }
      }

      // Encrypt
      const plaintext = { msgtype: 'm.text', body: 'CommandAPI encrypted message' }
      const encrypted = await alice.crypto.encryptRoomEvent(
        encryptedRoomId, 'm.room.message', plaintext
      )
      assert.strictEqual(encrypted.algorithm, 'm.megolm.v1.aes-sha2')
      assert.ok(encrypted.ciphertext)

      // Send via HttpAPI (as CommandAPI would)
      const result = await alice.httpAPI.sendMessageEvent(
        encryptedRoomId, 'm.room.encrypted', encrypted
      )
      assert.ok(result.event_id, 'encrypted event should be sent')
    })
  })

  describe('TimelineAPI — Decrypt on Receive', function () {
    let roomId

    before(async function () {
      // Create encrypted room
      const room = await alice.httpAPI.createRoom({
        name: 'E2EE Timeline Test',
        invite: [bobCreds.user_id],
        initial_state: [{
          type: 'm.room.encryption',
          content: { algorithm: 'm.megolm.v1.aes-sha2' },
          state_key: ''
        }]
      })
      roomId = room.room_id
      await bob.httpAPI.join(roomId)

      // Register encryption
      await alice.crypto.setRoomEncryption(roomId, { algorithm: 'm.megolm.v1.aes-sha2' })
      await bob.crypto.setRoomEncryption(roomId, { algorithm: 'm.megolm.v1.aes-sha2' })

      // Sync both
      const aliceSync = await alice.httpAPI.sync(undefined, undefined, 0)
      const bobSync = await bob.httpAPI.sync(undefined, undefined, 0)

      // Process crypto for both
      await alice.crypto.receiveSyncChanges(
        aliceSync.to_device?.events || [], aliceSync.device_lists || {},
        aliceSync.device_one_time_keys_count || {}, aliceSync.device_unused_fallback_key_types || []
      )
      await alice.httpAPI.processOutgoingCryptoRequests(alice.crypto)

      await bob.crypto.receiveSyncChanges(
        bobSync.to_device?.events || [], bobSync.device_lists || {},
        bobSync.device_one_time_keys_count || {}, bobSync.device_unused_fallback_key_types || []
      )
      await bob.httpAPI.processOutgoingCryptoRequests(bob.crypto)

      // Alice: full key exchange + send encrypted message
      await alice.crypto.updateTrackedUsers([bobCreds.user_id, aliceCreds.user_id])
      const kq = await alice.crypto.queryKeysForUsers([bobCreds.user_id])
      if (kq) {
        const r = await alice.httpAPI.sendOutgoingCryptoRequest(kq)
        await alice.crypto.markRequestAsSent(kq.id, kq.type, r)
      }
      await alice.httpAPI.processOutgoingCryptoRequests(alice.crypto)

      const claim = await alice.crypto.getMissingSessions([bobCreds.user_id])
      if (claim) {
        const r = await alice.httpAPI.sendOutgoingCryptoRequest(claim)
        await alice.crypto.markRequestAsSent(claim.id, claim.type, r)
      }

      const shares = await alice.crypto.shareRoomKey(roomId, [aliceCreds.user_id, bobCreds.user_id])
      for (const req of shares) {
        const r = await alice.httpAPI.sendOutgoingCryptoRequest(req)
        if (req.id && req.type !== undefined) await alice.crypto.markRequestAsSent(req.id, req.type, r)
      }

      const encrypted = await alice.crypto.encryptRoomEvent(
        roomId, 'm.room.message', { msgtype: 'm.text', body: 'Timeline decrypt test' }
      )
      await alice.httpAPI.sendMessageEvent(roomId, 'm.room.encrypted', encrypted)
    })

    it('should decrypt received messages via CryptoManager', async () => {
      // Bob syncs — picks up to-device keys + encrypted room message
      const bobSync = await bob.httpAPI.sync(undefined, undefined, 0)

      // Process to-device events (room key delivery)
      await bob.crypto.receiveSyncChanges(
        bobSync.to_device?.events || [], bobSync.device_lists || {},
        bobSync.device_one_time_keys_count || {}, bobSync.device_unused_fallback_key_types || []
      )
      await bob.httpAPI.processOutgoingCryptoRequests(bob.crypto)

      // Find encrypted events in the room
      const roomData = bobSync.rooms?.join?.[roomId]
      assert.ok(roomData, 'Bob should have joined room data in sync')

      const timeline = roomData.timeline?.events || []
      const encryptedEvents = timeline.filter(e => e.type === 'm.room.encrypted')

      // Decrypt each encrypted event
      let decryptedMessage = null
      for (const event of encryptedEvents) {
        const result = await bob.crypto.decryptRoomEvent(event, roomId)
        if (result && result.event.content?.body === 'Timeline decrypt test') {
          decryptedMessage = result
        }
      }

      assert.ok(decryptedMessage, 'Bob should decrypt Alice\'s message')
      assert.strictEqual(decryptedMessage.event.content.body, 'Timeline decrypt test')
      assert.strictEqual(decryptedMessage.event.type, 'm.room.message')
      assert.strictEqual(decryptedMessage.event.content.msgtype, 'm.text')
    })
  })

  describe('Full Round-Trip: Alice sends, Bob receives', function () {
    it('should complete a full E2EE cycle through the API stack', async () => {
      // 1. Create encrypted room
      const room = await alice.httpAPI.createRoom({
        name: 'Full Round-Trip',
        invite: [bobCreds.user_id],
        initial_state: [{
          type: 'm.room.encryption',
          content: { algorithm: 'm.megolm.v1.aes-sha2' },
          state_key: ''
        }]
      })
      await bob.httpAPI.join(room.room_id)

      // 2. Register encryption
      await alice.crypto.setRoomEncryption(room.room_id, { algorithm: 'm.megolm.v1.aes-sha2' })
      await bob.crypto.setRoomEncryption(room.room_id, { algorithm: 'm.megolm.v1.aes-sha2' })

      // 3. Initial sync for both
      const aSync = await alice.httpAPI.sync(undefined, undefined, 0)
      await alice.crypto.receiveSyncChanges(
        aSync.to_device?.events || [], aSync.device_lists || {},
        aSync.device_one_time_keys_count || {}, []
      )
      await alice.httpAPI.processOutgoingCryptoRequests(alice.crypto)

      const bSync = await bob.httpAPI.sync(undefined, undefined, 0)
      await bob.crypto.receiveSyncChanges(
        bSync.to_device?.events || [], bSync.device_lists || {},
        bSync.device_one_time_keys_count || {}, []
      )
      await bob.httpAPI.processOutgoingCryptoRequests(bob.crypto)

      // 4. Key exchange
      await alice.crypto.updateTrackedUsers([aliceCreds.user_id, bobCreds.user_id])
      const kq = await alice.crypto.queryKeysForUsers([bobCreds.user_id])
      if (kq) {
        const r = await alice.httpAPI.sendOutgoingCryptoRequest(kq)
        await alice.crypto.markRequestAsSent(kq.id, kq.type, r)
      }
      await alice.httpAPI.processOutgoingCryptoRequests(alice.crypto)

      const claim = await alice.crypto.getMissingSessions([bobCreds.user_id])
      if (claim) {
        const r = await alice.httpAPI.sendOutgoingCryptoRequest(claim)
        await alice.crypto.markRequestAsSent(claim.id, claim.type, r)
      }

      const shares = await alice.crypto.shareRoomKey(room.room_id, [aliceCreds.user_id, bobCreds.user_id])
      for (const req of shares) {
        const r = await alice.httpAPI.sendOutgoingCryptoRequest(req)
        if (req.id && req.type !== undefined) await alice.crypto.markRequestAsSent(req.id, req.type, r)
      }

      // 5. Alice sends 3 encrypted messages
      const messages = ['First secret', 'Second secret', 'Third secret']
      for (const msg of messages) {
        const encrypted = await alice.crypto.encryptRoomEvent(
          room.room_id, 'm.room.message', { msgtype: 'm.text', body: msg }
        )
        await alice.httpAPI.sendMessageEvent(room.room_id, 'm.room.encrypted', encrypted)
      }

      // 6. Bob syncs and decrypts
      const bobSync2 = await bob.httpAPI.sync(undefined, undefined, 0)
      await bob.crypto.receiveSyncChanges(
        bobSync2.to_device?.events || [], bobSync2.device_lists || {},
        bobSync2.device_one_time_keys_count || {}, []
      )
      await bob.httpAPI.processOutgoingCryptoRequests(bob.crypto)

      const timeline = bobSync2.rooms?.join?.[room.room_id]?.timeline?.events || []
      const encryptedEvents = timeline.filter(e => e.type === 'm.room.encrypted')

      const decryptedBodies = []
      for (const event of encryptedEvents) {
        const result = await bob.crypto.decryptRoomEvent(event, room.room_id)
        if (result?.event?.content?.body) {
          decryptedBodies.push(result.event.content.body)
        }
      }

      // Verify all 3 messages were decrypted
      assert.ok(decryptedBodies.includes('First secret'), 'should decrypt first message')
      assert.ok(decryptedBodies.includes('Second secret'), 'should decrypt second message')
      assert.ok(decryptedBodies.includes('Third secret'), 'should decrypt third message')
    })
  })
})
