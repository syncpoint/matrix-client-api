/**
 * Test: Bob can load layer content after joining an encrypted room.
 *
 * This reproduces the exact ODIN flow:
 *   1. Alice creates an encrypted project + layer
 *   2. Alice posts content (ODIN operations) to the layer
 *   3. Alice shares historical keys with project members
 *   4. Bob joins the layer
 *   5. Bob calls content() to load all existing operations
 *
 * Prerequisites:
 *   cd test-e2e && docker compose up -d
 *
 * Run:
 *   npm run test:e2e -- --grep "Content after Join"
 */

import { describe, it, before, after } from 'mocha'
import assert from 'assert'
import { HttpAPI } from '../src/http-api.mjs'
import { StructureAPI } from '../src/structure-api.mjs'
import { CommandAPI } from '../src/command-api.mjs'
import { TimelineAPI } from '../src/timeline-api.mjs'
import { CryptoManager } from '../src/crypto.mjs'
import { CryptoFacade } from '../src/crypto-facade.mjs'
import { Project } from '../src/project.mjs'
import { ProjectList } from '../src/project-list.mjs'
import { setLogger } from '../src/logger.mjs'
import { Base64 } from 'js-base64'

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

// Enable debug logging with E2E_DEBUG=1
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
    home_server: 'odin.battlefield',
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

async function buildStack (credentials) {
  const httpAPI = new HttpAPI(credentials)
  const crypto = new CryptoManager()
  await crypto.initialize(credentials.user_id, credentials.device_id)
  await processOutgoingRequests(httpAPI, crypto)

  const structureAPI = new StructureAPI(httpAPI)
  const db = createDB()
  const facade = new CryptoFacade(crypto, httpAPI)
  const getMemberIds = async (roomId) => {
    const members = await httpAPI.members(roomId)
    return (members.chunk || [])
      .filter(e => e.content?.membership === 'join')
      .map(e => e.state_key)
      .filter(Boolean)
  }
  const commandAPI = new CommandAPI(httpAPI, getMemberIds, {
    encryptEvent: (roomId, type, content, memberIds) => facade.encryptEvent(roomId, type, content, memberIds),
    db
  })
  const timelineAPI = new TimelineAPI(httpAPI, {
    onSyncResponse: (data) => facade.processSyncResponse(data),
    decryptEvent: (event, roomId) => facade.decryptEvent(event, roomId)
  })

  return { httpAPI, crypto, structureAPI, commandAPI, timelineAPI }
}

function waitForCommandQueue (commandAPI, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const check = () => {
      if (commandAPI.scheduledCalls.isBlocked()) {
        setTimeout(resolve, 500)
      } else if (Date.now() > deadline) {
        reject(new Error('CommandAPI queue did not drain in time'))
      } else {
        setTimeout(check, 100)
      }
    }
    setTimeout(check, 100)
  })
}

describe('Content after Join', function () {
  this.timeout(60000)

  let aliceCreds, bobCreds
  let alice, bob

  before(async function () {
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

  it('Bob should decrypt layer content after joining (full ODIN flow)', async function () {
    // === Step 1: Alice creates encrypted project ===
    console.log('\n--- Step 1: Alice creates encrypted project ---')
    const project = await alice.structureAPI.createProject(
      `project-${suffix}`, 'Test Project', 'E2EE content test',
      undefined, { encrypted: true }
    )
    console.log('Project created:', project.globalId)

    // Alice invites Bob to the project
    await alice.httpAPI.invite(project.globalId, bobCreds.user_id)
    console.log('Bob invited to project')

    // Bob joins the project
    await bob.httpAPI.join(project.globalId)
    console.log('Bob joined project')

    // === Step 2: Alice creates encrypted layer ===
    console.log('\n--- Step 2: Alice creates encrypted layer ---')
    const layer = await alice.structureAPI.createLayer(
      `layer-${suffix}`, 'Test Layer', '',
      undefined, { encrypted: true }
    )
    console.log('Layer created:', layer.globalId)

    // Add layer to project (space child)
    await alice.structureAPI.addLayerToProject(project.globalId, layer.globalId)
    console.log('Layer added to project')

    // Register encryption
    await alice.crypto.setRoomEncryption(layer.globalId, { algorithm: 'm.megolm.v1.aes-sha2' })

    // === Step 3: Initial sync for both (device discovery) ===
    console.log('\n--- Step 3: Sync both sides ---')
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

    // === Step 4: Alice posts content to the layer ===
    console.log('\n--- Step 4: Alice posts content ---')
    const testOperations = [
      { type: 'put', key: 'feature:1', value: { name: 'Tank', sidc: 'SFGPUCA---' } },
      { type: 'put', key: 'feature:2', value: { name: 'HQ', sidc: 'SFGPUH----' } }
    ]
    const encoded = Base64.encode(JSON.stringify(testOperations))

    alice.commandAPI.schedule([
      'sendMessageEvent', layer.globalId, 'io.syncpoint.odin.operation',
      { content: encoded }
    ])
    alice.commandAPI.run()
    await waitForCommandQueue(alice.commandAPI)
    console.log('Content posted and encrypted')

    // === Step 5: Alice shares historical keys with Bob ===
    console.log('\n--- Step 5: Alice shares historical keys ---')
    await alice.crypto.updateTrackedUsers([bobCreds.user_id])
    const keysQuery = await alice.crypto.queryKeysForUsers([bobCreds.user_id])
    if (keysQuery) {
      const resp = await alice.httpAPI.sendOutgoingCryptoRequest(keysQuery)
      await alice.crypto.markRequestAsSent(keysQuery.id, keysQuery.type, resp)
    }
    const claimReq = await alice.crypto.getMissingSessions([bobCreds.user_id])
    if (claimReq) {
      const resp = await alice.httpAPI.sendOutgoingCryptoRequest(claimReq)
      await alice.crypto.markRequestAsSent(claimReq.id, claimReq.type, resp)
    }

    const { toDeviceMessages, keyCount } = await alice.crypto.shareHistoricalRoomKeys(layer.globalId, bobCreds.user_id)
    console.log(`Exported ${keyCount} session keys for sharing`)

    if (keyCount > 0) {
      const txnId = `keyshare_${Date.now()}`
      await alice.httpAPI.sendToDevice('m.room.encrypted', txnId, toDeviceMessages)
      console.log('Historical keys sent to Bob via to_device')
    }

    // === Step 6: Bob syncs to receive the keys ===
    console.log('\n--- Step 6: Bob syncs to receive keys ---')
    const bSync2 = await bob.httpAPI.sync(bSync.next_batch, undefined, 0)
    await bob.crypto.receiveSyncChanges(
      bSync2.to_device?.events || [], bSync2.device_lists || {},
      bSync2.device_one_time_keys_count || {}, []
    )
    await processOutgoingRequests(bob.httpAPI, bob.crypto)
    console.log('Bob synced and processed to_device events')

    // Register encryption for Bob
    await bob.crypto.setRoomEncryption(layer.globalId, { algorithm: 'm.megolm.v1.aes-sha2' })

    // === Step 7: Bob joins the layer and loads content ===
    console.log('\n--- Step 7: Bob joins layer and loads content ---')
    await bob.httpAPI.join(layer.globalId)
    console.log('Bob joined layer')

    // Bob loads content via TimelineAPI.content() — same as ODIN's Project.content()
    const filter = {
      lazy_load_members: true,
      limit: 1000,
      types: ['io.syncpoint.odin.operation'],
      not_senders: [bobCreds.user_id]
    }
    const content = await bob.timelineAPI.content(layer.globalId, filter)
    console.log(`Content loaded: ${content.events.length} events`)

    // === Assertions ===
    assert.ok(content.events.length > 0, 'Bob should have received events')

    const odinEvents = content.events.filter(e => e.type === 'io.syncpoint.odin.operation')
    assert.strictEqual(odinEvents.length, 1, 'Should have 1 ODIN operation event')
    assert.ok(odinEvents[0].decrypted, 'Event should be decrypted')

    const operations = JSON.parse(Base64.decode(odinEvents[0].content.content))
    assert.strictEqual(operations.length, 2, 'Should contain 2 operations')
    assert.strictEqual(operations[0].value.name, 'Tank')
    assert.strictEqual(operations[1].value.name, 'HQ')

    console.log('\n✅ Bob successfully decrypted all layer content after join!')
  })

  it('Bob should load content even WITHOUT E2EE (baseline)', async function () {
    // === Same flow but without encryption — verifies the basic pipeline ===
    console.log('\n--- Baseline test: no encryption ---')

    const project = await alice.structureAPI.createProject(
      `plain-project-${suffix}`, 'Plain Project', 'No encryption'
    )
    await alice.httpAPI.invite(project.globalId, bobCreds.user_id)
    await bob.httpAPI.join(project.globalId)

    const layer = await alice.structureAPI.createLayer(
      `plain-layer-${suffix}`, 'Plain Layer', ''
    )
    await alice.structureAPI.addLayerToProject(project.globalId, layer.globalId)

    // Alice posts content (unencrypted) — use httpAPI directly to isolate the test
    const testOps = [{ type: 'put', key: 'feature:plain', value: { name: 'Jeep' } }]
    const encoded = Base64.encode(JSON.stringify(testOps))
    await alice.httpAPI.sendMessageEvent(
      layer.globalId, 'io.syncpoint.odin.operation',
      { content: encoded }
    )

    // Bob joins and loads content
    await bob.httpAPI.join(layer.globalId)

    const filter = {
      lazy_load_members: true,
      limit: 1000,
      types: ['io.syncpoint.odin.operation'],
      not_senders: [bobCreds.user_id]
    }
    const content = await bob.timelineAPI.content(layer.globalId, filter)
    console.log(`Plain content loaded: ${content.events.length} events`)

    assert.ok(content.events.length > 0, 'Bob should have received unencrypted events')
    const ops = JSON.parse(Base64.decode(content.events[0].content.content))
    assert.strictEqual(ops[0].value.name, 'Jeep')

    console.log('✅ Baseline (no E2EE) works!')
  })
})
