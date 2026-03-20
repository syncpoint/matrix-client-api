import { describe, it, before } from 'mocha'
import assert from 'assert'
import { initAsync, RequestType } from '@matrix-org/matrix-sdk-crypto-wasm'
import { CryptoManager } from '../src/crypto.mjs'

before(async function () {
  this.timeout(10000)
  await initAsync()
})

describe('CryptoManager Lifecycle', function () {
  this.timeout(10000)

  it('should create an OlmMachine on initialize()', async () => {
    const crypto = new CryptoManager()
    await crypto.initialize('@alice:test', 'DEVICE_A')
    assert.ok(crypto.olmMachine, 'OlmMachine should exist after initialize')
  })

  it('should expose userId after initialization', async () => {
    const crypto = new CryptoManager()
    await crypto.initialize('@alice:test', 'DEVICE_A')
    assert.ok(crypto.userId)
    assert.strictEqual(crypto.userId.toString(), '@alice:test')
  })

  it('should expose deviceId after initialization', async () => {
    const crypto = new CryptoManager()
    await crypto.initialize('@alice:test', 'DEVICE_A')
    assert.ok(crypto.deviceId)
    assert.strictEqual(crypto.deviceId.toString(), 'DEVICE_A')
  })

  it('should expose identityKeys after initialization', async () => {
    const crypto = new CryptoManager()
    await crypto.initialize('@alice:test', 'DEVICE_A')
    const keys = crypto.identityKeys
    assert.ok(keys, 'identityKeys should be available')
    assert.ok(keys.ed25519, 'ed25519 key should exist')
    assert.ok(keys.curve25519, 'curve25519 key should exist')
  })

  it('should overwrite the previous machine on double initialize()', async () => {
    const crypto = new CryptoManager()
    await crypto.initialize('@alice:test', 'DEVICE_A')
    const firstKeys = crypto.identityKeys.ed25519.toBase64()
    await crypto.initialize('@alice:test', 'DEVICE_B')
    const secondKeys = crypto.identityKeys.ed25519.toBase64()
    assert.notStrictEqual(firstKeys, secondKeys, 'keys should differ after re-init with different device')
  })

  it('should throw on encryptRoomEvent() before initialize()', async () => {
    const crypto = new CryptoManager()
    await assert.rejects(
      () => crypto.encryptRoomEvent('!room:test', 'm.room.message', { body: 'hello' }),
      { message: 'CryptoManager not initialized' }
    )
  })

  it('should throw on decryptRoomEvent() before initialize()', async () => {
    const crypto = new CryptoManager()
    await assert.rejects(
      () => crypto.decryptRoomEvent({}, '!room:test'),
      { message: 'CryptoManager not initialized' }
    )
  })

  it('should throw on shareRoomKey() before initialize()', async () => {
    const crypto = new CryptoManager()
    await assert.rejects(
      () => crypto.shareRoomKey('!room:test', ['@alice:test']),
      { message: 'CryptoManager not initialized' }
    )
  })
})

describe('CryptoManager Persistent Store', function () {
  this.timeout(10000)

  it('should have initializeWithStore() method', () => {
    const crypto = new CryptoManager()
    assert.strictEqual(typeof crypto.initializeWithStore, 'function')
  })

  it('should report isPersistent=false for in-memory init', async () => {
    const crypto = new CryptoManager()
    await crypto.initialize('@alice:test', 'DEVICE_A')
    assert.strictEqual(crypto.isPersistent, false)
  })

  it('should fail initializeWithStore() in Node.js (no IndexedDB)', async () => {
    const crypto = new CryptoManager()
    await assert.rejects(
      () => crypto.initializeWithStore('@alice:test', 'DEVICE_A', 'crypto-test', 'passphrase'),
      /indexedDB/i,
      'should fail because IndexedDB is not available in Node.js'
    )
  })

  it('should have close() method that cleans up', async () => {
    const crypto = new CryptoManager()
    await crypto.initialize('@alice:test', 'DEVICE_A')
    assert.ok(crypto.olmMachine)
    await crypto.close()
    assert.strictEqual(crypto.olmMachine, null)
    assert.strictEqual(crypto.storeHandle, null)
  })

  it('should throw on operations after close()', async () => {
    const crypto = new CryptoManager()
    await crypto.initialize('@alice:test', 'DEVICE_A')
    await crypto.close()
    await assert.rejects(
      () => crypto.encryptRoomEvent('!room:test', 'm.room.message', { body: 'test' }),
      { message: 'CryptoManager not initialized' }
    )
  })
})

describe('Room Encryption Registration', function () {
  this.timeout(10000)

  it('should register a room for encryption without error', async () => {
    const crypto = new CryptoManager()
    await crypto.initialize('@alice:test', 'DEVICE_A')
    await crypto.setRoomEncryption('!room:test')
    // No error means success
  })

  it('should allow setRoomEncryption() and subsequent shareRoomKey() without error', async () => {
    const crypto = new CryptoManager()
    await crypto.initialize('@alice:test', 'DEVICE_A')

    // Process initial outgoing requests (keys upload)
    const requests = await crypto.outgoingRequests()
    for (const req of requests) {
      if (req.type === RequestType.KeysUpload) {
        await crypto.markRequestAsSent(req.id, req.type, '{"one_time_key_counts":{"signed_curve25519":50}}')
      }
    }

    await crypto.setRoomEncryption('!room:test')
    await crypto.updateTrackedUsers(['@alice:test'])

    // After room registration, shareRoomKey should be callable
    const shareResult = await crypto.shareRoomKey('!room:test', ['@alice:test'])
    assert.ok(Array.isArray(shareResult), 'shareRoomKey should return an array')
  })
})

describe('Outgoing Requests', function () {
  this.timeout(10000)

  it('should contain a KeysUpload request after initialization', async () => {
    const crypto = new CryptoManager()
    await crypto.initialize('@test:localhost', 'TESTDEVICE')
    const requests = await crypto.outgoingRequests()
    assert.ok(Array.isArray(requests), 'should return an array')
    assert.ok(requests.length > 0, 'should have at least one request')

    const keysUpload = requests.find(r => r.type === RequestType.KeysUpload)
    assert.ok(keysUpload, 'should contain a KeysUpload request')
  })

  it('should have type, id, and body properties on requests', async () => {
    const crypto = new CryptoManager()
    await crypto.initialize('@test:localhost', 'TESTDEVICE2')
    const requests = await crypto.outgoingRequests()
    for (const req of requests) {
      assert.ok(req.type !== undefined, 'request should have type')
      assert.ok(req.id, 'request should have id')
      assert.ok(req.body, 'request should have body')
    }
  })

  it('should accept markRequestAsSent() without error', async () => {
    const crypto = new CryptoManager()
    await crypto.initialize('@test:localhost', 'TESTDEVICE3')
    const requests = await crypto.outgoingRequests()
    const keysUpload = requests.find(r => r.type === RequestType.KeysUpload)
    assert.ok(keysUpload)

    await crypto.markRequestAsSent(
      keysUpload.id,
      keysUpload.type,
      '{"one_time_key_counts":{"signed_curve25519":50}}'
    )
    // No error means success
  })

  it('should throw when not initialized', async () => {
    const crypto = new CryptoManager()
    await assert.rejects(
      () => crypto.outgoingRequests(),
      { message: 'CryptoManager not initialized' }
    )
  })
})

describe('Error Cases', function () {
  this.timeout(10000)

  it('should throw on encryptRoomEvent() before initialize()', async () => {
    const crypto = new CryptoManager()
    await assert.rejects(
      () => crypto.encryptRoomEvent('!room:test', 'm.room.message', { body: 'test' }),
      { message: 'CryptoManager not initialized' }
    )
  })

  it('should return null on decryptRoomEvent() with invalid event', async () => {
    const crypto = new CryptoManager()
    await crypto.initialize('@alice:test', 'DEVICE_A')
    const result = await crypto.decryptRoomEvent(
      { type: 'm.room.encrypted', content: { algorithm: 'invalid', ciphertext: 'garbage' } },
      '!room:test'
    )
    assert.strictEqual(result, null, 'should return null for undecryptable events')
  })

  it('should throw on shareRoomKey() before initialize()', async () => {
    const crypto = new CryptoManager()
    await assert.rejects(
      () => crypto.shareRoomKey('!room:test', ['@alice:test']),
      { message: 'CryptoManager not initialized' }
    )
  })
})

describe('Encrypt / Decrypt Round-Trip (self)', function () {
  this.timeout(30000)

  it('should have correct request types from outgoingRequests()', async () => {
    const alice = new CryptoManager()
    await alice.initialize('@alice:test', 'DEVICE_A')
    const requests = await alice.outgoingRequests()

    const types = requests.map(r => r.type)
    assert.ok(types.includes(RequestType.KeysUpload), 'should include KeysUpload')
  })

  it('should produce KeysUpload for both Alice and Bob', async () => {
    const alice = new CryptoManager()
    const bob = new CryptoManager()
    await alice.initialize('@alice:test', 'DEVICE_A')
    await bob.initialize('@bob:test', 'DEVICE_B')

    const aliceReqs = await alice.outgoingRequests()
    const bobReqs = await bob.outgoingRequests()

    assert.ok(aliceReqs.find(r => r.type === RequestType.KeysUpload), 'Alice should have KeysUpload')
    assert.ok(bobReqs.find(r => r.type === RequestType.KeysUpload), 'Bob should have KeysUpload')
  })

  it('should self-encrypt and decrypt a room event', async () => {
    const alice = new CryptoManager()
    await alice.initialize('@alice:test', 'DEVICE_A')

    // Mark keys upload as sent
    const requests = await alice.outgoingRequests()
    for (const req of requests) {
      if (req.type === RequestType.KeysUpload) {
        await alice.markRequestAsSent(req.id, req.type, '{"one_time_key_counts":{"signed_curve25519":50}}')
      }
    }

    await alice.setRoomEncryption('!room:test')
    await alice.updateTrackedUsers(['@alice:test'])

    // Query own keys
    const keysQueryReqs = await alice.outgoingRequests()
    const keysQuery = keysQueryReqs.find(r => r.type === RequestType.KeysQuery)

    if (keysQuery) {
      // Simulate keys/query response with Alice's own device
      const body = JSON.parse(keysQuery.body)
      const deviceKeys = {}
      const ed25519Key = alice.identityKeys.ed25519.toBase64()
      const curve25519Key = alice.identityKeys.curve25519.toBase64()

      deviceKeys['@alice:test'] = {
        DEVICE_A: {
          user_id: '@alice:test',
          device_id: 'DEVICE_A',
          algorithms: ['m.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'],
          keys: {
            [`curve25519:DEVICE_A`]: curve25519Key,
            [`ed25519:DEVICE_A`]: ed25519Key
          },
          signatures: {}
        }
      }

      await alice.markRequestAsSent(
        keysQuery.id,
        keysQuery.type,
        JSON.stringify({ device_keys: deviceKeys, failures: {} })
      )
    }

    // Share room key with self
    const shareRequests = await alice.shareRoomKey('!room:test', ['@alice:test'])

    // Process to-device messages (deliver to self)
    if (shareRequests && shareRequests.length > 0) {
      for (const toDeviceReq of shareRequests) {
        // Extract the to-device events and feed them back
        const body = JSON.parse(toDeviceReq.body)
        const messages = body.messages || {}
        const toDeviceEvents = []
        for (const [userId, devices] of Object.entries(messages)) {
          for (const [deviceId, content] of Object.entries(devices)) {
            toDeviceEvents.push({
              sender: '@alice:test',
              type: content.type || 'm.room.encrypted',
              content
            })
          }
        }

        if (toDeviceEvents.length > 0) {
          await alice.receiveSyncChanges(toDeviceEvents, {}, { signed_curve25519: 50 }, [])
        }

        // Mark to-device request as sent
        if (toDeviceReq.id && toDeviceReq.type !== undefined) {
          await alice.markRequestAsSent(toDeviceReq.id, toDeviceReq.type, '{}')
        }
      }
    }

    // Now encrypt
    const originalContent = { msgtype: 'm.text', body: 'Hello, encrypted world!' }
    const encrypted = await alice.encryptRoomEvent('!room:test', 'm.room.message', originalContent)

    assert.ok(encrypted, 'encrypted content should exist')
    assert.strictEqual(encrypted.algorithm, 'm.megolm.v1.aes-sha2', 'should use megolm algorithm')
    assert.ok(encrypted.ciphertext, 'should have ciphertext')
    assert.ok(encrypted.sender_key, 'should have sender_key')
    assert.ok(encrypted.session_id, 'should have session_id')

    // Decrypt
    const encryptedEvent = {
      type: 'm.room.encrypted',
      event_id: '$test_event',
      room_id: '!room:test',
      sender: '@alice:test',
      origin_server_ts: Date.now(),
      content: encrypted
    }

    const decrypted = await alice.decryptRoomEvent(encryptedEvent, '!room:test')
    assert.ok(decrypted, 'decrypted result should not be null')
    assert.deepStrictEqual(decrypted.event.content, originalContent, 'decrypted content should match original')
    assert.strictEqual(decrypted.event.type, 'm.room.message', 'decrypted event type should match')
  })
})
