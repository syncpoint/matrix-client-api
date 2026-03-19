/**
 * E2E Test: Sync-gated content after join.
 *
 * Verifies that waiting for a room to appear in the sync response
 * before calling content() reliably delivers all events — both
 * with and without E2EE.
 *
 * Compares:
 *   1. Immediate content() after join (current behavior, may be empty)
 *   2. Sync-gated content() (wait for room in sync, then fetch)
 *
 * Prerequisites:
 *   cd test-e2e && docker compose up -d
 *
 * Run:
 *   npm run test:e2e -- --grep "Sync-Gated Content"
 */

import { describe, it, before, after } from 'mocha'
import assert from 'assert'
import { HttpAPI } from '../src/http-api.mjs'
import { StructureAPI } from '../src/structure-api.mjs'
import { TimelineAPI } from '../src/timeline-api.mjs'
import { CryptoManager } from '../src/crypto.mjs'
import { CryptoFacade } from '../src/crypto-facade.mjs'
import { setLogger } from '../src/logger.mjs'
import { Base64 } from 'js-base64'

const HOMESERVER_URL = process.env.HOMESERVER_URL || 'http://localhost:8008'
const ODIN_OP_TYPE = 'io.syncpoint.odin.operation'
const suffix = Date.now().toString(36)

if (!process.env.E2E_DEBUG) {
  setLogger({
    info: (...args) => console.log('[INFO]', ...args),
    debug: () => {},
    warn: (...args) => console.warn('[WARN]', ...args),
    error: (...args) => console.error('[ERROR]', ...args)
  })
} else {
  setLogger({
    info: (...args) => console.log('[INFO]', ...args),
    debug: (...args) => console.log('[DEBUG]', ...args),
    warn: (...args) => console.warn('[WARN]', ...args),
    error: (...args) => console.error('[ERROR]', ...args)
  })
}

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

function buildAPIs (credentials, crypto = null) {
  const httpAPI = new HttpAPI(credentials)
  const structureAPI = new StructureAPI(httpAPI)
  let timelineAPI
  if (crypto) {
    const facade = new CryptoFacade(crypto, httpAPI)
    timelineAPI = new TimelineAPI(httpAPI, {
      onSyncResponse: (data) => facade.processSyncResponse(data),
      decryptEvent: (event, roomId) => facade.decryptEvent(event, roomId)
    })
  } else {
    timelineAPI = new TimelineAPI(httpAPI)
  }
  return { httpAPI, structureAPI, timelineAPI }
}

async function processOutgoingRequests (httpAPI, crypto) {
  const requests = await crypto.outgoingRequests()
  for (const request of requests) {
    const response = await httpAPI.sendOutgoingCryptoRequest(request)
    await crypto.markRequestAsSent(request.id, request.type, response)
  }
}

/**
 * Post ODIN operations to a room. If crypto is provided, encrypts the event.
 */
async function postOperations (httpAPI, roomId, operations, crypto = null, memberUserIds = []) {
  const encoded = Base64.encode(JSON.stringify(operations))
  const eventContent = { content: encoded }

  if (crypto) {
    // shareRoomKey creates the Megolm session and produces to_device requests
    // for sharing the key with room members. Must be called before encryptRoomEvent.
    const shareRequests = await crypto.shareRoomKey(roomId, memberUserIds)
    for (const req of shareRequests) {
      const resp = await httpAPI.sendOutgoingCryptoRequest(req)
      await crypto.markRequestAsSent(req.id, req.type, resp)
    }
    const encrypted = await crypto.encryptRoomEvent(roomId, ODIN_OP_TYPE, eventContent)
    await httpAPI.sendMessageEvent(roomId, 'm.room.encrypted', encrypted)
    await processOutgoingRequests(httpAPI, crypto)
  } else {
    await httpAPI.sendMessageEvent(roomId, ODIN_OP_TYPE, eventContent)
  }
}

/**
 * Do a sync cycle: call /sync, feed crypto if available.
 */
async function doSync (httpAPI, crypto, since, timeout = 0) {
  const syncResult = await httpAPI.sync(since, undefined, timeout)
  if (crypto) {
    await crypto.receiveSyncChanges(
      syncResult.to_device?.events || [],
      syncResult.device_lists || {},
      syncResult.device_one_time_keys_count || {},
      syncResult.device_unused_fallback_key_types || []
    )
    await processOutgoingRequests(httpAPI, crypto)
  }
  return syncResult
}

/**
 * Wait until a room appears in the sync join block.
 * Returns the sync result that contains the room.
 */
async function waitForRoomInSync (httpAPI, crypto, roomId, since, maxAttempts = 20) {
  let token = since
  for (let i = 0; i < maxAttempts; i++) {
    const syncResult = await doSync(httpAPI, crypto, token, 1000)
    token = syncResult.next_batch
    if (syncResult.rooms?.join?.[roomId]) {
      return { syncResult, since: token }
    }
  }
  throw new Error(`Room ${roomId} never appeared in sync after ${maxAttempts} attempts`)
}

const contentFilter = {
  lazy_load_members: true,
  limit: 1000,
  types: [ODIN_OP_TYPE]
}

describe('Sync-Gated Content (E2E)', function () {
  this.timeout(60000)

  let aliceCreds, bobCreds
  let aliceCrypto, bobCrypto
  let alice, bob

  before(async function () {
    // Check if Tuwunel is running
    try {
      const res = await fetch(`${HOMESERVER_URL}/_matrix/client/versions`)
      const data = await res.json()
      if (!data.versions) throw new Error('not a Matrix server')
    } catch {
      this.skip()
    }

    // Register users
    aliceCreds = await registerUser(`alice_sgc_${suffix}`, `ALICE_SGC_${suffix}`)
    bobCreds = await registerUser(`bob_sgc_${suffix}`, `BOB_SGC_${suffix}`)

    // Init crypto for both
    aliceCrypto = new CryptoManager()
    await aliceCrypto.initialize(aliceCreds.user_id, aliceCreds.device_id)
    bobCrypto = new CryptoManager()
    await bobCrypto.initialize(bobCreds.user_id, bobCreds.device_id)

    alice = buildAPIs(aliceCreds, aliceCrypto)
    bob = buildAPIs(bobCreds, bobCrypto)

    // Initial key upload
    await processOutgoingRequests(alice.httpAPI, aliceCrypto)
    await processOutgoingRequests(bob.httpAPI, bobCrypto)
  })

  after(async function () {
    if (aliceCrypto) await aliceCrypto.close()
    if (bobCrypto) await bobCrypto.close()
  })

  describe('Without E2EE', function () {
    let layerRoomId

    before(async function () {
      // Alice creates a plain (unencrypted) room with some content
      const project = await alice.structureAPI.createProject(
        `sgc-plain-${suffix}`, 'Plain Project', ''
      )
      await alice.httpAPI.invite(project.globalId, bobCreds.user_id)
      await bob.httpAPI.join(project.globalId)

      const layer = await alice.structureAPI.createLayer(
        `sgc-plain-layer-${suffix}`, 'Plain Layer', ''
      )
      layerRoomId = layer.globalId
      await alice.structureAPI.addLayerToProject(project.globalId, layerRoomId)

      // Post 5 operations
      const ops = Array.from({ length: 5 }, (_, i) => ({
        type: 'put', key: `feature:plain-${i}`, value: { name: `Unit ${i}` }
      }))
      await alice.httpAPI.sendMessageEvent(layerRoomId, ODIN_OP_TYPE, {
        content: Base64.encode(JSON.stringify(ops))
      })
    })

    it('immediate content() after join may return empty (demonstrates the problem)', async function () {
      // Bob joins and immediately calls content() — no sync wait
      await bob.httpAPI.join(layerRoomId)
      const content = await bob.timelineAPI.content(layerRoomId, contentFilter)

      const eventCount = content.events.length
      console.log(`  Immediate content(): ${eventCount} events`)

      // We document the result but don't assert failure — it may or may not work
      // depending on server timing. The point is to show it's unreliable.
      if (eventCount === 0) {
        console.log('  ⚠️  Confirmed: immediate content() returned 0 events (race condition)')
      } else {
        console.log('  ℹ️  Server was fast enough this time, but this is not guaranteed')
      }
    })

    it('sync-gated content() after join reliably returns all events', async function () {
      // Fresh room for a clean test
      const layer2 = await alice.structureAPI.createLayer(
        `sgc-plain-gated-${suffix}`, 'Gated Layer', ''
      )
      const roomId = layer2.globalId
      await alice.structureAPI.addLayerToProject(
        (await alice.structureAPI.createProject(`sgc-plain2-${suffix}`, 'P2', '')).globalId,
        roomId
      )

      // Alice invites Bob to the project so he can join the layer
      // (for simplicity, just invite directly to the layer room)
      await alice.httpAPI.invite(roomId, bobCreds.user_id)

      const ops = Array.from({ length: 5 }, (_, i) => ({
        type: 'put', key: `feature:gated-${i}`, value: { name: `Vehicle ${i}` }
      }))
      await alice.httpAPI.sendMessageEvent(roomId, ODIN_OP_TYPE, {
        content: Base64.encode(JSON.stringify(ops))
      })

      // Get Bob's current sync token
      const bobSync = await doSync(bob.httpAPI, null, undefined, 0)

      // Bob joins
      await bob.httpAPI.join(roomId)

      // Wait for the room to appear in sync
      const { since: newToken } = await waitForRoomInSync(
        bob.httpAPI, null, roomId, bobSync.next_batch
      )
      console.log('  Room appeared in sync')

      // NOW fetch content — should be reliable
      const content = await bob.timelineAPI.content(roomId, contentFilter)
      console.log(`  Sync-gated content(): ${content.events.length} events`)

      assert.ok(content.events.length > 0, 'Sync-gated content() should return events')

      const operations = content.events
        .filter(e => e.type === ODIN_OP_TYPE)
        .map(e => JSON.parse(Base64.decode(e.content.content)))
        .flat()
      assert.strictEqual(operations.length, 5, 'Should have all 5 operations')
    })
  })

  describe('With E2EE', function () {
    let layerRoomId
    let bobSyncToken

    before(async function () {
      // Alice creates an encrypted room with content
      const project = await alice.structureAPI.createProject(
        `sgc-e2ee-${suffix}`, 'E2EE Project', '', undefined, { encrypted: true }
      )
      await alice.httpAPI.invite(project.globalId, bobCreds.user_id)
      await bob.httpAPI.join(project.globalId)

      const layer = await alice.structureAPI.createLayer(
        `sgc-e2ee-layer-${suffix}`, 'E2EE Layer', '', undefined, { encrypted: true }
      )
      layerRoomId = layer.globalId
      await alice.structureAPI.addLayerToProject(project.globalId, layerRoomId)
      await aliceCrypto.setRoomEncryption(layerRoomId, { algorithm: 'm.megolm.v1.aes-sha2' })

      // Sync both sides for device discovery
      await doSync(alice.httpAPI, aliceCrypto, undefined, 0)
      await doSync(bob.httpAPI, bobCrypto, undefined, 0)

      // Post encrypted operations
      const ops = Array.from({ length: 5 }, (_, i) => ({
        type: 'put', key: `feature:e2ee-${i}`, value: { name: `Secret Unit ${i}` }
      }))
      await postOperations(alice.httpAPI, layerRoomId, ops, aliceCrypto, [aliceCreds.user_id])

      // Alice shares historical keys with Bob
      await aliceCrypto.updateTrackedUsers([bobCreds.user_id])
      const keysQuery = await aliceCrypto.queryKeysForUsers([bobCreds.user_id])
      if (keysQuery) {
        const resp = await alice.httpAPI.sendOutgoingCryptoRequest(keysQuery)
        await aliceCrypto.markRequestAsSent(keysQuery.id, keysQuery.type, resp)
      }
      const claimReq = await aliceCrypto.getMissingSessions([bobCreds.user_id])
      if (claimReq) {
        const resp = await alice.httpAPI.sendOutgoingCryptoRequest(claimReq)
        await aliceCrypto.markRequestAsSent(claimReq.id, claimReq.type, resp)
      }

      const { toDeviceMessages, keyCount } = await aliceCrypto.shareHistoricalRoomKeys(layerRoomId, bobCreds.user_id)
      if (keyCount > 0) {
        await alice.httpAPI.sendToDevice('m.room.encrypted', `ks_${Date.now()}`, toDeviceMessages)
      }

      // Bob syncs to receive historical keys (before joining the layer)
      const bSync = await doSync(bob.httpAPI, bobCrypto, undefined, 0)
      bobSyncToken = bSync.next_batch
      await bobCrypto.setRoomEncryption(layerRoomId, { algorithm: 'm.megolm.v1.aes-sha2' })
    })

    it('sync-gated content() decrypts all events after join', async function () {
      // Bob joins the layer
      await bob.httpAPI.join(layerRoomId)

      // Wait for the room to appear in Bob's sync
      const { since: newToken } = await waitForRoomInSync(
        bob.httpAPI, bobCrypto, layerRoomId, bobSyncToken
      )
      console.log('  Room appeared in sync (E2EE)')

      // Fetch content — keys should already be available from the earlier sync
      const content = await bob.timelineAPI.content(layerRoomId, contentFilter)
      console.log(`  Sync-gated content() (E2EE): ${content.events.length} events`)

      const odinEvents = content.events.filter(e => e.type === ODIN_OP_TYPE)
      assert.ok(odinEvents.length > 0, 'Should have ODIN operation events')
      assert.ok(odinEvents[0].decrypted, 'Events should be decrypted')

      const operations = odinEvents
        .map(e => JSON.parse(Base64.decode(e.content.content)))
        .flat()

      assert.strictEqual(operations.length, 5, 'Should have all 5 operations')
      assert.strictEqual(operations[0].value.name, 'Secret Unit 0')
      console.log('  ✅ All 5 encrypted operations decrypted after sync-gated join')
    })
  })
})
