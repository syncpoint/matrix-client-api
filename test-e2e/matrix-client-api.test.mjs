/**
 * Integration tests for matrix-client-api E2EE against a real Tuwunel homeserver.
 *
 * Tests the actual API layers as they are used in ODIN:
 *   HttpAPI → CryptoManager → StructureAPI → CommandAPI → TimelineAPI
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
import { RoomMemberCache } from '../src/room-members.mjs'
import { TimelineAPI } from '../src/timeline-api.mjs'
import { CryptoManager } from '../src/crypto.mjs'
import { CryptoFacade } from '../src/crypto-facade.mjs'
import { setLogger } from '../src/logger.mjs'

import levelup from 'levelup'
import memdown from 'memdown'
import subleveldown from 'subleveldown'

const createDB = () => {
  const db = levelup(memdown())
  const s = subleveldown(db, 'command-queue', { valueEncoding: 'json' })
  return s
}


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

/** Register a user and return credentials compatible with HttpAPI constructor. */
async function registerUser (username, deviceId) {
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

async function processOutgoingRequests (httpAPI, crypto) {
  const requests = await crypto.outgoingRequests()
  for (const request of requests) {
    const response = await httpAPI.sendOutgoingCryptoRequest(request)
    await crypto.markRequestAsSent(request.id, request.type, response)
  }
}

/** Build the full API stack as ODIN does it. */
async function buildStack (credentials) {
  const httpAPI = new HttpAPI(credentials)
  const crypto = new CryptoManager()
  await crypto.initialize(credentials.user_id, credentials.device_id)

  // Upload device keys (same as ODIN does on project open)
  await processOutgoingRequests(httpAPI, crypto)

  const structureAPI = new StructureAPI(httpAPI)
  const facade = new CryptoFacade(crypto, httpAPI)
  const memberCache = new RoomMemberCache(async (roomId) => {
    const members = await httpAPI.members(roomId)
    return (members.chunk || [])
      .filter(e => e.content?.membership === 'join')
      .map(e => e.state_key)
      .filter(Boolean)
  })
  const commandAPI = new CommandAPI(httpAPI, memberCache, {
    encryptEvent: (roomId, type, content, memberIds) => facade.encryptEvent(roomId, type, content, memberIds),
    db: createDB()
  })
  const timelineAPI = new TimelineAPI(httpAPI, {
    onSyncResponse: (data) => facade.processSyncResponse(data),
    decryptEvent: (event, roomId) => facade.decryptEvent(event, roomId)
  })

  return { httpAPI, crypto, structureAPI, commandAPI, timelineAPI }
}

/**
 * Wait for CommandAPI to process scheduled items.
 * The FIFO queue blocks on dequeue() when empty, so we can't check length.
 * Instead, we wait until the queue is blocked (waiting for new items),
 * which means all scheduled items have been processed.
 */
function waitForCommandQueue (commandAPI, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const check = () => {
      if (commandAPI.scheduledCalls.isBlocked()) {
        // Queue is waiting for new items = all scheduled items processed
        // Small grace period for the HTTP response to complete
        setTimeout(resolve, 500)
      } else if (Date.now() > deadline) {
        reject(new Error('CommandAPI queue did not drain in time'))
      } else {
        setTimeout(check, 100)
      }
    }
    // Start checking after a brief delay to let run() pick up items
    setTimeout(check, 100)
  })
}

describe('matrix-client-api E2EE Integration', function () {
  this.timeout(30000)

  let aliceCreds, bobCreds
  let alice, bob

  before(async function () {
    // Check homeserver availability
    try {
      const res = await fetch(`${HOMESERVER_URL}/_matrix/client/versions`)
      const data = await res.json()
      if (!data.versions) throw new Error('not a Matrix server')
    } catch {
      this.skip()
    }

    aliceCreds = await registerUser(`alice_${suffix}`, `ALICE_${suffix}`)
    bobCreds = await registerUser(`bob_${suffix}`, `BOB_${suffix}`)

    alice = await buildStack(aliceCreds)
    bob = await buildStack(bobCreds)
  })

  after(async function () {
    if (alice?.commandAPI) await alice.commandAPI.stop()
    if (bob?.commandAPI) await bob.commandAPI.stop()
    if (alice?.crypto) await alice.crypto.close()
    if (bob?.crypto) await bob.crypto.close()
  })

  // ─── Layer 1: HttpAPI + CryptoManager ───────────────────────────────

  describe('Layer 1: HttpAPI + CryptoManager', function () {

    it('device keys should be on the server after processOutgoingRequests()', async () => {
      // Bob queries Alice's keys — verifies that processOutgoingRequests() worked
      const result = await bob.httpAPI.client.post('v3/keys/query', {
        json: { device_keys: { [aliceCreds.user_id]: [] } }
      }).json()

      const device = result.device_keys[aliceCreds.user_id][aliceCreds.device_id]
      assert.ok(device, 'Alice\'s device should exist on the server')
      assert.ok(device.keys[`curve25519:${aliceCreds.device_id}`])
      assert.ok(device.keys[`ed25519:${aliceCreds.device_id}`])
    })

    it('sendOutgoingCryptoRequest() should handle KeysQuery', async () => {
      await alice.crypto.updateTrackedUsers([bobCreds.user_id])
      const queryReq = await alice.crypto.queryKeysForUsers([bobCreds.user_id])
      assert.ok(queryReq, 'should produce a KeysQuery request')

      const response = await alice.httpAPI.sendOutgoingCryptoRequest(queryReq)
      await alice.crypto.markRequestAsSent(queryReq.id, queryReq.type, response)
      // Success = no error
    })
  })

  // ─── Layer 2: StructureAPI ──────────────────────────────────────────

  describe('Layer 2: StructureAPI', function () {

    it('createProject({ encrypted: true }) should set m.room.encryption state', async () => {
      const project = await alice.structureAPI.createProject(
        'e2ee-test-project', 'E2EE Test Project', 'Testing encryption',
        undefined, { encrypted: true }
      )
      assert.ok(project.globalId, 'project should be created')

      // Verify encryption state on the room
      const state = await alice.httpAPI.getState(project.globalId)
      const encEvent = state.find(e => e.type === 'm.room.encryption')
      assert.ok(encEvent, 'project room should have m.room.encryption state')
      assert.strictEqual(encEvent.content.algorithm, 'm.megolm.v1.aes-sha2')
    })

    it('createLayer({ encrypted: true }) should set m.room.encryption state', async () => {
      const layer = await alice.structureAPI.createLayer(
        'e2ee-test-layer', 'E2EE Test Layer', 'Testing encryption',
        undefined, { encrypted: true }
      )
      assert.ok(layer.globalId, 'layer should be created')

      const state = await alice.httpAPI.getState(layer.globalId)
      const encEvent = state.find(e => e.type === 'm.room.encryption')
      assert.ok(encEvent, 'layer room should have m.room.encryption state')
      assert.strictEqual(encEvent.content.algorithm, 'm.megolm.v1.aes-sha2')
    })

    it('createProject() without encrypted option should NOT set encryption', async () => {
      const project = await alice.structureAPI.createProject(
        'plain-project', 'Plain Project', 'No encryption'
      )
      const state = await alice.httpAPI.getState(project.globalId)
      const encEvent = state.find(e => e.type === 'm.room.encryption')
      assert.strictEqual(encEvent, undefined, 'should not have encryption state')
    })
  })

  // ─── Layer 3: CommandAPI (encrypted send) ───────────────────────────

  describe('Layer 3: CommandAPI', function () {
    let roomId

    before(async function () {
      // Create encrypted room via StructureAPI, invite Bob
      const layer = await alice.structureAPI.createLayer(
        'cmd-test-layer', 'CommandAPI Test', '',
        undefined, { encrypted: true }
      )
      roomId = layer.globalId

      // Invite and join Bob
      await alice.httpAPI.invite(roomId, bobCreds.user_id)
      await bob.httpAPI.join(roomId)

      // Register encryption with both CryptoManagers
      await alice.crypto.setRoomEncryption(roomId, { algorithm: 'm.megolm.v1.aes-sha2' })
      await bob.crypto.setRoomEncryption(roomId, { algorithm: 'm.megolm.v1.aes-sha2' })

      // Initial sync for both to discover device lists
      const aSync = await alice.httpAPI.sync(undefined, undefined, 0)
      await alice.crypto.receiveSyncChanges(
        aSync.to_device?.events || [], aSync.device_lists || {},
        aSync.device_one_time_keys_count || {}, []
      )
      await processOutgoingRequests(alice.httpAPI, alice.crypto)

      const bSync = await bob.httpAPI.sync(undefined, undefined, 0)
      await bob.crypto.receiveSyncChanges(
        bSync.to_device?.events || [], bSync.device_lists || {},
        bSync.device_one_time_keys_count || {}, []
      )
      await processOutgoingRequests(bob.httpAPI, bob.crypto)
    })

    it('should encrypt and send via schedule() + run()', async () => {
      // Schedule a message through CommandAPI (as ODIN does)
      alice.commandAPI.schedule([
        'sendMessageEvent', roomId, 'io.syncpoint.odin.operation',
        { content: 'dGVzdCBvcGVyYXRpb24=' } // base64 "test operation"
      ])

      // Start the command runner
      alice.commandAPI.run()

      // Wait for the queue to drain
      await waitForCommandQueue(alice.commandAPI)

      // Verify: the event on the server should be m.room.encrypted (not plaintext)
      const sync = await bob.httpAPI.sync(undefined, undefined, 0)
      const roomEvents = sync.rooms?.join?.[roomId]?.timeline?.events || []

      // There should be at least one m.room.encrypted event
      const encrypted = roomEvents.filter(e => e.type === 'm.room.encrypted')
      assert.ok(encrypted.length > 0, 'CommandAPI should have sent an encrypted event')
      assert.strictEqual(encrypted[0].content.algorithm, 'm.megolm.v1.aes-sha2')

      // The original ODIN event type should NOT appear in plaintext
      const plaintext = roomEvents.filter(e => e.type === 'io.syncpoint.odin.operation')
      assert.strictEqual(plaintext.length, 0, 'original event type should not be visible')

      await alice.commandAPI.stop()
    })
  })

  // ─── Layer 4: TimelineAPI (transparent decrypt) ─────────────────────

  describe('Layer 4: TimelineAPI', function () {
    let roomId
    let aliceSyncToken

    before(async function () {
      // Create encrypted room, invite Bob, join
      const layer = await alice.structureAPI.createLayer(
        'timeline-test-layer', 'TimelineAPI Test', '',
        undefined, { encrypted: true }
      )
      roomId = layer.globalId

      await alice.httpAPI.invite(roomId, bobCreds.user_id)
      await bob.httpAPI.join(roomId)

      await alice.crypto.setRoomEncryption(roomId, { algorithm: 'm.megolm.v1.aes-sha2' })
      await bob.crypto.setRoomEncryption(roomId, { algorithm: 'm.megolm.v1.aes-sha2' })

      // Initial sync for both
      const aSync = await alice.httpAPI.sync(undefined, undefined, 0)
      await alice.crypto.receiveSyncChanges(
        aSync.to_device?.events || [], aSync.device_lists || {},
        aSync.device_one_time_keys_count || {}, []
      )
      await processOutgoingRequests(alice.httpAPI, alice.crypto)
      aliceSyncToken = aSync.next_batch

      const bSync = await bob.httpAPI.sync(undefined, undefined, 0)
      await bob.crypto.receiveSyncChanges(
        bSync.to_device?.events || [], bSync.device_lists || {},
        bSync.device_one_time_keys_count || {}, []
      )
      await processOutgoingRequests(bob.httpAPI, bob.crypto)

      // Alice sends an encrypted message via CommandAPI
      alice.commandAPI.schedule([
        'sendMessageEvent', roomId, 'io.syncpoint.odin.operation',
        { content: 'dGltZWxpbmUgdGVzdA==' } // base64 "timeline test"
      ])
      alice.commandAPI.run()
      await waitForCommandQueue(alice.commandAPI)
      await alice.commandAPI.stop()
    })

    it('syncTimeline() should transparently decrypt m.room.encrypted events', async () => {
      // Bob uses TimelineAPI.syncTimeline() — the way ODIN consumes events
      const result = await bob.timelineAPI.syncTimeline(null, undefined, 0)

      assert.ok(result.next_batch, 'should return a sync token')
      assert.ok(result.events, 'should return events')

      // Find events for our room
      const roomEvents = result.events[roomId] || []

      // Look for decrypted ODIN operation events
      const odinEvents = roomEvents.filter(e => e.type === 'io.syncpoint.odin.operation')

      assert.ok(odinEvents.length > 0,
        'TimelineAPI should have transparently decrypted the event back to io.syncpoint.odin.operation')

      // Verify the decrypted flag is set
      const decryptedEvent = odinEvents.find(e => e.decrypted === true)
      assert.ok(decryptedEvent, 'decrypted events should have decrypted=true flag')
      assert.deepStrictEqual(decryptedEvent.content, { content: 'dGltZWxpbmUgdGVzdA==' })
    })
  })

  // ─── Full Stack: StructureAPI → CommandAPI → TimelineAPI ────────────

  describe('Full Stack Round-Trip', function () {

    it('Alice creates encrypted layer via StructureAPI, sends via CommandAPI, Bob receives via TimelineAPI', async () => {
      // 1. StructureAPI: Create encrypted layer
      const layer = await alice.structureAPI.createLayer(
        `roundtrip-${suffix}`, 'Full Stack Test', 'E2EE round-trip',
        undefined, { encrypted: true }
      )

      // 2. Invite + Join
      await alice.httpAPI.invite(layer.globalId, bobCreds.user_id)
      await bob.httpAPI.join(layer.globalId)

      // 3. Register encryption
      await alice.crypto.setRoomEncryption(layer.globalId, { algorithm: 'm.megolm.v1.aes-sha2' })
      await bob.crypto.setRoomEncryption(layer.globalId, { algorithm: 'm.megolm.v1.aes-sha2' })

      // 4. Initial sync both
      const aSync = await alice.httpAPI.sync(undefined, undefined, 0)
      await alice.crypto.receiveSyncChanges(
        aSync.to_device?.events || [], aSync.device_lists || {},
        aSync.device_one_time_keys_count || {}, []
      )
      await processOutgoingRequests(alice.httpAPI, alice.crypto)

      const bSync = await bob.httpAPI.sync(undefined, undefined, 0)
      await bob.crypto.receiveSyncChanges(
        bSync.to_device?.events || [], bSync.device_lists || {},
        bSync.device_one_time_keys_count || {}, []
      )
      await processOutgoingRequests(bob.httpAPI, bob.crypto)

      // 5. CommandAPI: Alice sends 2 ODIN operations
      alice.commandAPI.schedule([
        'sendMessageEvent', layer.globalId, 'io.syncpoint.odin.operation',
        { content: 'b3BlcmF0aW9uIDE=' } // "operation 1"
      ])
      alice.commandAPI.schedule([
        'sendMessageEvent', layer.globalId, 'io.syncpoint.odin.operation',
        { content: 'b3BlcmF0aW9uIDI=' } // "operation 2"
      ])
      alice.commandAPI.run()
      await waitForCommandQueue(alice.commandAPI)
      await alice.commandAPI.stop()

      // 6. TimelineAPI: Bob receives and decrypts
      const result = await bob.timelineAPI.syncTimeline(null, undefined, 0)
      const roomEvents = result.events[layer.globalId] || []
      const odinOps = roomEvents.filter(e => e.type === 'io.syncpoint.odin.operation' && e.decrypted)

      assert.strictEqual(odinOps.length, 2, 'Bob should receive 2 decrypted ODIN operations')
      assert.deepStrictEqual(odinOps[0].content, { content: 'b3BlcmF0aW9uIDE=' })
      assert.deepStrictEqual(odinOps[1].content, { content: 'b3BlcmF0aW9uIDI=' })
    })
  })
})
