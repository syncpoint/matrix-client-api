import { describe, it } from 'mocha'
import assert from 'assert'
import { CryptoManager } from '../src/crypto.mjs'

describe('CryptoManager', function () {
  this.timeout(10000)

  it('should initialize OlmMachine', async () => {
    const crypto = new CryptoManager()
    await crypto.initialize('@test:localhost', 'TESTDEVICE')
    assert.ok(crypto.olmMachine, 'OlmMachine should be initialized')
  })

  it('should return outgoing requests after initialization', async () => {
    const crypto = new CryptoManager()
    await crypto.initialize('@test:localhost', 'TESTDEVICE2')
    const requests = await crypto.outgoingRequests()
    assert.ok(Array.isArray(requests), 'outgoingRequests should return an array')
    // After init there should be at least a KeysUpload request
    assert.ok(requests.length > 0, 'should have at least one outgoing request after init')
  })

  it('should return empty array when not initialized', async () => {
    const crypto = new CryptoManager()
    const requests = await crypto.outgoingRequests()
    assert.deepStrictEqual(requests, [])
  })

  it('should throw on encrypt when not initialized', async () => {
    const crypto = new CryptoManager()
    await assert.rejects(
      () => crypto.encryptRoomEvent('!room:localhost', 'm.room.message', { body: 'test' }),
      { message: 'CryptoManager not initialized' }
    )
  })
})
