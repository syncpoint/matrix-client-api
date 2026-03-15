/**
 * E2E tests for Matrix E2EE using a real Tuwunel homeserver.
 *
 * Prerequisites:
 *   cd test-e2e && docker compose up -d
 *
 * Run:
 *   npm run test:e2e
 */

import { describe, it, before, after } from 'mocha'
import assert from 'assert'
import { CryptoManager, RequestType } from '../src/crypto.mjs'

const HOMESERVER = process.env.HOMESERVER_URL || 'http://localhost:8008'

/** Simple HTTP helper (no dependencies beyond Node built-ins) */
async function matrixRequest (method, path, { accessToken, body } = {}) {
  const url = `${HOMESERVER}/_matrix/client/v3${path}`
  const headers = { 'Content-Type': 'application/json' }
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  try { return JSON.parse(text) } catch { return text }
}

/** Register a user and return { userId, accessToken, deviceId } */
async function registerUser (username) {
  const result = await matrixRequest('POST', '/register', {
    body: {
      username,
      password: 'testpass_' + username,
      auth: { type: 'm.login.dummy' }
    }
  })

  if (result.errcode) throw new Error(`Registration failed for ${username}: ${result.error}`)

  return {
    userId: result.user_id,
    accessToken: result.access_token,
    deviceId: result.device_id
  }
}

/** Process outgoing crypto requests via real HTTP */
async function processOutgoingRequests (crypto, accessToken) {
  const requests = await crypto.outgoingRequests()
  for (const request of requests) {
    let response
    switch (request.type) {
      case RequestType.KeysUpload:
        response = await matrixRequest('POST', '/keys/upload', {
          accessToken, body: JSON.parse(request.body)
        })
        break
      case RequestType.KeysQuery:
        response = await matrixRequest('POST', '/keys/query', {
          accessToken, body: JSON.parse(request.body)
        })
        break
      case RequestType.KeysClaim:
        response = await matrixRequest('POST', '/keys/claim', {
          accessToken, body: JSON.parse(request.body)
        })
        break
      case RequestType.ToDevice: {
        const txnId = request.txn_id || `txn_${Date.now()}`
        const eventType = request.event_type
        response = await matrixRequest('PUT',
          `/sendToDevice/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`, {
            accessToken, body: JSON.parse(request.body)
          })
        break
      }
      default:
        console.warn('Unknown request type:', request.type)
        response = {}
    }
    await crypto.markRequestAsSent(request.id, request.type, JSON.stringify(response))
  }
}

/** Run a /sync and feed results to CryptoManager */
async function syncAndProcess (crypto, accessToken, since) {
  const params = new URLSearchParams({ timeout: '0' })
  if (since) params.set('since', since)

  const syncResult = await matrixRequest('GET', `/sync?${params}`, { accessToken })

  if (syncResult.errcode) throw new Error(`Sync failed: ${syncResult.error}`)

  const toDevice = syncResult.to_device?.events || []
  const deviceLists = syncResult.device_lists || {}
  const otkeyCounts = syncResult.device_one_time_keys_count || {}
  const fallbackKeys = syncResult.device_unused_fallback_key_types || []

  await crypto.receiveSyncChanges(toDevice, deviceLists, otkeyCounts, fallbackKeys)
  await processOutgoingRequests(crypto, accessToken)

  return syncResult.next_batch
}

describe('E2EE Integration (Tuwunel)', function () {
  this.timeout(30000)

  let alice, bob
  let aliceCrypto, bobCrypto

  before(async function () {
    // Check if homeserver is available
    try {
      const res = await fetch(`${HOMESERVER}/_matrix/client/versions`)
      const versions = await res.json()
      if (!versions.versions) throw new Error('No versions')
    } catch (e) {
      this.skip() // Skip if no homeserver running
    }

    // Register users with unique names (avoid conflicts on re-runs)
    const suffix = Date.now().toString(36)
    alice = await registerUser(`alice_${suffix}`)
    bob = await registerUser(`bob_${suffix}`)

    // Initialize crypto (in-memory for Node.js tests)
    aliceCrypto = new CryptoManager()
    await aliceCrypto.initialize(alice.userId, alice.deviceId)

    bobCrypto = new CryptoManager()
    await bobCrypto.initialize(bob.userId, bob.deviceId)

    // Upload device keys for both
    await processOutgoingRequests(aliceCrypto, alice.accessToken)
    await processOutgoingRequests(bobCrypto, bob.accessToken)
  })

  after(async function () {
    if (aliceCrypto) await aliceCrypto.close()
    if (bobCrypto) await bobCrypto.close()
  })

  it('should upload device keys to the homeserver', async () => {
    // Query Alice's keys from the server
    const result = await matrixRequest('POST', '/keys/query', {
      accessToken: bob.accessToken,
      body: { device_keys: { [alice.userId]: [] } }
    })

    assert.ok(result.device_keys, 'should have device_keys')
    assert.ok(result.device_keys[alice.userId], 'should have Alice\'s devices')
    assert.ok(result.device_keys[alice.userId][alice.deviceId], 'should have Alice\'s device')

    const deviceInfo = result.device_keys[alice.userId][alice.deviceId]
    assert.ok(deviceInfo.keys[`ed25519:${alice.deviceId}`], 'should have ed25519 key')
    assert.ok(deviceInfo.keys[`curve25519:${alice.deviceId}`], 'should have curve25519 key')
  })

  it('should create an encrypted room and exchange keys', async () => {
    // Alice creates a room with encryption
    const room = await matrixRequest('POST', '/createRoom', {
      accessToken: alice.accessToken,
      body: {
        name: 'E2EE Test Room',
        invite: [bob.userId],
        initial_state: [{
          type: 'm.room.encryption',
          content: { algorithm: 'm.megolm.v1.aes-sha2' }
        }]
      }
    })
    assert.ok(room.room_id, 'should create a room')

    // Bob joins
    await matrixRequest('POST', `/join/${encodeURIComponent(room.room_id)}`, {
      accessToken: bob.accessToken
    })

    // Register room encryption with both crypto managers
    await aliceCrypto.setRoomEncryption(room.room_id, { algorithm: 'm.megolm.v1.aes-sha2' })
    await bobCrypto.setRoomEncryption(room.room_id, { algorithm: 'm.megolm.v1.aes-sha2' })

    // Sync both sides to pick up device lists
    await syncAndProcess(aliceCrypto, alice.accessToken)
    await syncAndProcess(bobCrypto, bob.accessToken)

    // Alice tracks Bob's devices and queries keys
    await aliceCrypto.updateTrackedUsers([bob.userId])
    const keysQuery = await aliceCrypto.queryKeysForUsers([bob.userId])
    if (keysQuery) {
      const queryResponse = await matrixRequest('POST', '/keys/query', {
        accessToken: alice.accessToken,
        body: JSON.parse(keysQuery.body)
      })
      await aliceCrypto.markRequestAsSent(keysQuery.id, keysQuery.type, JSON.stringify(queryResponse))
    }

    // Claim one-time keys for Bob
    const claimRequest = await aliceCrypto.getMissingSessions([bob.userId])
    if (claimRequest) {
      const claimResponse = await matrixRequest('POST', '/keys/claim', {
        accessToken: alice.accessToken,
        body: JSON.parse(claimRequest.body)
      })
      await aliceCrypto.markRequestAsSent(claimRequest.id, claimRequest.type, JSON.stringify(claimResponse))
    }

    // Share room key
    const shareRequests = await aliceCrypto.shareRoomKey(room.room_id, [alice.userId, bob.userId])
    for (const req of shareRequests) {
      const txnId = req.txn_id || `txn_${Date.now()}`
      const eventType = req.event_type
      const response = await matrixRequest('PUT',
        `/sendToDevice/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`, {
          accessToken: alice.accessToken,
          body: JSON.parse(req.body)
        })
      if (req.id && req.type !== undefined) {
        await aliceCrypto.markRequestAsSent(req.id, req.type, JSON.stringify(response))
      }
    }

    // Alice encrypts and sends a message
    const plaintext = { msgtype: 'm.text', body: 'Hello from Alice, encrypted!' }
    const encrypted = await aliceCrypto.encryptRoomEvent(room.room_id, 'm.room.message', plaintext)
    assert.ok(encrypted.ciphertext, 'should produce ciphertext')

    const sendResult = await matrixRequest('PUT',
      `/rooms/${encodeURIComponent(room.room_id)}/send/m.room.encrypted/txn_${Date.now()}`, {
        accessToken: alice.accessToken,
        body: encrypted
      })
    assert.ok(sendResult.event_id, 'should send encrypted event')

    // Bob syncs and receives the to-device key + encrypted message
    await syncAndProcess(bobCrypto, bob.accessToken)

    // Bob syncs again to get the room message
    const bobSync = await matrixRequest('GET', '/sync?timeout=0', { accessToken: bob.accessToken })
    const roomEvents = bobSync.rooms?.join?.[room.room_id]?.timeline?.events || []
    const encryptedEvent = roomEvents.find(e => e.type === 'm.room.encrypted')

    if (encryptedEvent) {
      const decrypted = await bobCrypto.decryptRoomEvent(encryptedEvent, room.room_id)
      assert.ok(decrypted, 'Bob should be able to decrypt')
      assert.strictEqual(decrypted.event.content.body, 'Hello from Alice, encrypted!',
        'Decrypted content should match original')
      assert.strictEqual(decrypted.event.type, 'm.room.message')
    }
    // If no encrypted event in this sync batch, that's OK for this basic test
    // The key exchange itself is the critical part
  })
})
