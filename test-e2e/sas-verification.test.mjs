/**
 * Test: SAS (emoji) device verification between two users.
 *
 * Verifies the full verification flow:
 *   1. Alice requests verification of Bob's device
 *   2. Bob accepts the request
 *   3. Alice starts SAS
 *   4. Both see the same 7 emojis
 *   5. Both confirm → devices are verified
 *
 * Prerequisites:
 *   cd test-e2e && docker compose up -d
 *
 * Run:
 *   npm run test:e2e -- --grep "SAS Verification"
 */

import { describe, it, before, after } from 'mocha'
import assert from 'assert'
import { HttpAPI } from '../src/http-api.mjs'
import { CryptoManager, RequestType } from '../src/crypto.mjs'
import { setLogger } from '../src/logger.mjs'

const HOMESERVER_URL = process.env.HOMESERVER_URL || 'http://localhost:8008'
const suffix = Date.now().toString(36)

setLogger({
  info: (...args) => console.log('[INFO]', ...args),
  debug: () => {},
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args)
})

async function processOutgoingRequests (httpAPI, crypto) {
  const requests = await crypto.outgoingRequests()
  for (const request of requests) {
    const response = await httpAPI.sendOutgoingCryptoRequest(request)
    await crypto.markRequestAsSent(request.id, request.type, response)
  }
}

async function registerUser (username, deviceId) {
  const res = await fetch(`${HOMESERVER_URL}/_matrix/client/v3/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username, password: `pass_${username}`, device_id: deviceId,
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

/** Helper: sync and feed results to crypto + send outgoing requests */
async function syncAndProcess (httpAPI, crypto, since) {
  const params = new URLSearchParams({ timeout: '0' })
  if (since) params.set('since', since)
  const syncResult = await httpAPI.client.get(`v3/sync?${params}`).json()

  await crypto.receiveSyncChanges(
    syncResult.to_device?.events || [],
    syncResult.device_lists || {},
    syncResult.device_one_time_keys_count || {},
    syncResult.device_unused_fallback_key_types || []
  )
  await processOutgoingRequests(httpAPI, crypto)
  return syncResult.next_batch
}

/** Helper: send an outgoing crypto/verification request via HTTP */
async function sendRequest (httpAPI, request) {
  if (!request) return
  const response = await httpAPI.sendOutgoingCryptoRequest(request)
  if (request.id && request.type !== undefined) {
    await httpAPI.crypto?.markRequestAsSent?.(request.id, request.type, response)
  }
  return response
}

describe('SAS Verification', function () {
  this.timeout(30000)

  let aliceCreds, bobCreds
  let aliceHTTP, bobHTTP
  let aliceCrypto, bobCrypto
  let aliceSince, bobSince

  before(async function () {
    try {
      const res = await fetch(`${HOMESERVER_URL}/_matrix/client/versions`)
      if (!(await res.json()).versions) throw new Error()
    } catch { this.skip() }

    aliceCreds = await registerUser(`alice_${suffix}`, `ALICE_${suffix}`)
    bobCreds = await registerUser(`bob_${suffix}`, `BOB_${suffix}`)

    aliceHTTP = new HttpAPI(aliceCreds)
    bobHTTP = new HttpAPI(bobCreds)

    aliceCrypto = new CryptoManager()
    await aliceCrypto.initialize(aliceCreds.user_id, aliceCreds.device_id)
    await processOutgoingRequests(aliceHTTP, aliceCrypto)

    bobCrypto = new CryptoManager()
    await bobCrypto.initialize(bobCreds.user_id, bobCreds.device_id)
    await processOutgoingRequests(bobHTTP, bobCrypto)

    // Create a shared room so they discover each other's devices
    const room = await aliceHTTP.createRoom({
      name: 'verification-test',
      invite: [bobCreds.user_id]
    })
    await bobHTTP.join(room.room_id)

    // Initial sync for device discovery
    aliceSince = await syncAndProcess(aliceHTTP, aliceCrypto)
    bobSince = await syncAndProcess(bobHTTP, bobCrypto)

    // Track each other
    await aliceCrypto.updateTrackedUsers([bobCreds.user_id])
    const aliceQuery = await aliceCrypto.queryKeysForUsers([bobCreds.user_id])
    if (aliceQuery) {
      const resp = await aliceHTTP.sendOutgoingCryptoRequest(aliceQuery)
      await aliceCrypto.markRequestAsSent(aliceQuery.id, aliceQuery.type, resp)
    }

    await bobCrypto.updateTrackedUsers([aliceCreds.user_id])
    const bobQuery = await bobCrypto.queryKeysForUsers([aliceCreds.user_id])
    if (bobQuery) {
      const resp = await bobHTTP.sendOutgoingCryptoRequest(bobQuery)
      await bobCrypto.markRequestAsSent(bobQuery.id, bobQuery.type, resp)
    }

    // Claim one-time keys for Olm sessions
    const aliceClaim = await aliceCrypto.getMissingSessions([bobCreds.user_id])
    if (aliceClaim) {
      const resp = await aliceHTTP.sendOutgoingCryptoRequest(aliceClaim)
      await aliceCrypto.markRequestAsSent(aliceClaim.id, aliceClaim.type, resp)
    }
  })

  after(async function () {
    if (aliceCrypto) await aliceCrypto.close()
    if (bobCrypto) await bobCrypto.close()
  })

  it('should complete full SAS emoji verification between Alice and Bob', async function () {

    // === Step 1: Alice requests verification of Bob's device ===
    console.log('\n--- Step 1: Alice requests verification ---')
    const { request: aliceRequest, toDeviceRequest } = await aliceCrypto.requestVerification(
      bobCreds.user_id, bobCreds.device_id
    )
    assert.ok(aliceRequest, 'should create a verification request')
    assert.ok(toDeviceRequest, 'should produce a to_device request')

    // Send the verification request
    const resp = await aliceHTTP.sendOutgoingCryptoRequest(toDeviceRequest)
    if (toDeviceRequest.id && toDeviceRequest.type !== undefined) {
      await aliceCrypto.markRequestAsSent(toDeviceRequest.id, toDeviceRequest.type, resp)
    }
    console.log('Alice sent verification request, phase:', aliceCrypto.getVerificationPhase(aliceRequest))

    // === Step 2: Bob syncs and receives the request ===
    console.log('\n--- Step 2: Bob receives verification request ---')
    bobSince = await syncAndProcess(bobHTTP, bobCrypto, bobSince)

    const bobRequests = bobCrypto.getVerificationRequests(aliceCreds.user_id)
    console.log(`Bob has ${bobRequests.length} verification request(s)`)
    assert.ok(bobRequests.length > 0, 'Bob should have a verification request')

    const bobRequest = bobRequests[0]
    console.log('Bob request phase:', bobCrypto.getVerificationPhase(bobRequest))

    // === Step 3: Bob accepts the request ===
    console.log('\n--- Step 3: Bob accepts ---')
    const acceptResponse = bobCrypto.acceptVerification(bobRequest)
    if (acceptResponse) {
      const r = await bobHTTP.sendOutgoingCryptoRequest(acceptResponse)
      if (acceptResponse.id && acceptResponse.type !== undefined) {
        await bobCrypto.markRequestAsSent(acceptResponse.id, acceptResponse.type, r)
      }
    }
    console.log('Bob accepted, phase:', bobCrypto.getVerificationPhase(bobRequest))

    // === Step 4: Alice syncs to see the acceptance ===
    console.log('\n--- Step 4: Alice syncs ---')
    aliceSince = await syncAndProcess(aliceHTTP, aliceCrypto, aliceSince)
    console.log('Alice request phase:', aliceCrypto.getVerificationPhase(aliceRequest))

    // === Step 5: Alice starts SAS ===
    console.log('\n--- Step 5: Alice starts SAS ---')
    const sasResult = await aliceCrypto.startSas(aliceRequest)
    assert.ok(sasResult, 'should start SAS')
    const { sas: aliceSas, request: sasRequest } = sasResult

    // Send the SAS start event
    const sasResp = await aliceHTTP.sendOutgoingCryptoRequest(sasRequest)
    if (sasRequest.id && sasRequest.type !== undefined) {
      await aliceCrypto.markRequestAsSent(sasRequest.id, sasRequest.type, sasResp)
    }
    console.log('Alice started SAS')

    // === Step 6: Bob syncs and gets the SAS start ===
    console.log('\n--- Step 6: Bob syncs for SAS ---')
    bobSince = await syncAndProcess(bobHTTP, bobCrypto, bobSince)

    const bobSas = bobCrypto.getSas(bobRequest)
    assert.ok(bobSas, 'Bob should have a SAS verification')

    // Bob accepts SAS
    const bobSasAccept = bobSas.accept()
    if (bobSasAccept) {
      const r = await bobHTTP.sendOutgoingCryptoRequest(bobSasAccept)
      if (bobSasAccept.id && bobSasAccept.type !== undefined) {
        await bobCrypto.markRequestAsSent(bobSasAccept.id, bobSasAccept.type, r)
      }
    }
    console.log('Bob accepted SAS')

    // === Step 7: Alice syncs to receive Bob's accept + key ===
    console.log('\n--- Step 7: Alice syncs for SAS key ---')
    aliceSince = await syncAndProcess(aliceHTTP, aliceCrypto, aliceSince)

    // === Step 8: Bob syncs to receive Alice's key ===
    console.log('\n--- Step 8: Bob syncs for Alice key ---')
    bobSince = await syncAndProcess(bobHTTP, bobCrypto, bobSince)

    // Extra sync round: Alice may need Bob's SAS key exchange
    aliceSince = await syncAndProcess(aliceHTTP, aliceCrypto, aliceSince)
    bobSince = await syncAndProcess(bobHTTP, bobCrypto, bobSince)

    // === Step 9: Compare emojis ===
    console.log('\n--- Step 9: Compare emojis ---')
    const aliceEmojis = aliceCrypto.getEmojis(aliceSas)
    const bobEmojis = bobCrypto.getEmojis(bobSas)

    console.log('Alice emojis:', aliceEmojis?.map(e => e.symbol).join(' '))
    console.log('Bob emojis:  ', bobEmojis?.map(e => e.symbol).join(' '))

    assert.ok(aliceEmojis, 'Alice should have emojis')
    assert.ok(bobEmojis, 'Bob should have emojis')
    assert.strictEqual(aliceEmojis.length, 7, 'Should have 7 emojis')
    assert.strictEqual(bobEmojis.length, 7, 'Should have 7 emojis')

    // Emojis must match!
    for (let i = 0; i < 7; i++) {
      assert.strictEqual(aliceEmojis[i].symbol, bobEmojis[i].symbol,
        `Emoji ${i} should match: ${aliceEmojis[i].symbol} vs ${bobEmojis[i].symbol}`)
    }
    console.log('✅ Emojis match!')

    // === Step 10: Both confirm ===
    console.log('\n--- Step 10: Both confirm ---')
    const aliceConfirmRequests = await aliceCrypto.confirmSas(aliceSas)
    for (const req of aliceConfirmRequests) {
      const r = await aliceHTTP.sendOutgoingCryptoRequest(req)
      if (req.id && req.type !== undefined) {
        await aliceCrypto.markRequestAsSent(req.id, req.type, r)
      }
    }
    console.log('Alice confirmed')

    const bobConfirmRequests = await bobCrypto.confirmSas(bobSas)
    for (const req of bobConfirmRequests) {
      const r = await bobHTTP.sendOutgoingCryptoRequest(req)
      if (req.id && req.type !== undefined) {
        await bobCrypto.markRequestAsSent(req.id, req.type, r)
      }
    }
    console.log('Bob confirmed')

    // Final sync rounds for done/MAC events (may need multiple rounds)
    for (let i = 0; i < 3; i++) {
      aliceSince = await syncAndProcess(aliceHTTP, aliceCrypto, aliceSince)
      bobSince = await syncAndProcess(bobHTTP, bobCrypto, bobSince)
    }

    // === Step 11: Verify the verification status ===
    console.log('\n--- Step 11: Check verification status ---')
    const bobVerified = await aliceCrypto.isDeviceVerified(bobCreds.user_id, bobCreds.device_id)
    const aliceVerified = await bobCrypto.isDeviceVerified(aliceCreds.user_id, aliceCreds.device_id)

    console.log(`Alice sees Bob as verified: ${bobVerified}`)
    console.log(`Bob sees Alice as verified: ${aliceVerified}`)

    // Check detailed status
    const bobDeviceStatus = await aliceCrypto.getDeviceVerificationStatus(bobCreds.user_id)
    console.log('Bob device status from Alice perspective:', JSON.stringify(bobDeviceStatus))

    const aliceDeviceStatus = await bobCrypto.getDeviceVerificationStatus(aliceCreds.user_id)
    console.log('Alice device status from Bob perspective:', JSON.stringify(aliceDeviceStatus))

    assert.ok(bobVerified || bobDeviceStatus[0]?.locallyTrusted,
      'Bob should be verified or locally trusted by Alice')
    assert.ok(aliceVerified || aliceDeviceStatus[0]?.locallyTrusted,
      'Alice should be verified or locally trusted by Bob')

    console.log('\n✅ SAS verification complete!')
  })
})
