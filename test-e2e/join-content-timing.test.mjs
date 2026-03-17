/**
 * Test: Does /messages return content immediately after /join?
 *
 * Scenario:
 *   1. Alice creates a room with history_visibility: shared
 *   2. Alice posts several messages
 *   3. Bob joins the room
 *   4. Bob immediately calls /messages (no from token, dir=f)
 *   5. Verify Bob receives all messages
 *
 * This isolates whether the server delivers historical messages
 * immediately after a successful join, or whether a delay exists.
 *
 * Prerequisites:
 *   cd test-e2e && docker compose up -d
 *
 * Run:
 *   npm run test:e2e -- --grep "Join content timing"
 */

import { describe, it, before } from 'mocha'
import assert from 'assert'
import { setLogger } from '../src/logger.mjs'

const HOMESERVER_URL = process.env.HOMESERVER_URL || 'http://localhost:8008'
const suffix = Date.now().toString(36)

setLogger({
  info: (...args) => console.log('[INFO]', ...args),
  debug: () => {},
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args)
})

async function registerUser (username) {
  const res = await fetch(`${HOMESERVER_URL}/_matrix/client/v3/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: `pass_${username}`,
      auth: { type: 'm.login.dummy' }
    })
  })
  const data = await res.json()
  if (data.errcode) throw new Error(`Registration failed: ${data.error}`)
  return data
}

async function createRoom (accessToken, name) {
  const res = await fetch(`${HOMESERVER_URL}/_matrix/client/v3/createRoom`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      name,
      visibility: 'private',
      initial_state: [{
        type: 'm.room.history_visibility',
        content: { history_visibility: 'shared' },
        state_key: ''
      }]
    })
  })
  return res.json()
}

async function invite (accessToken, roomId, userId) {
  await fetch(`${HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({ user_id: userId })
  })
}

async function join (accessToken, roomId) {
  const res = await fetch(`${HOMESERVER_URL}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: '{}'
  })
  return res.json()
}

async function sendMessage (accessToken, roomId, body, txnId) {
  const res = await fetch(
    `${HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({ msgtype: 'm.text', body })
    }
  )
  return res.json()
}

async function getMessages (accessToken, roomId, dir = 'f', limit = 100) {
  const url = `${HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=${dir}&limit=${limit}`
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  })
  return res.json()
}

describe('Join content timing', function () {
  this.timeout(30000)

  let alice, bob

  before(async function () {
    try {
      const res = await fetch(`${HOMESERVER_URL}/_matrix/client/versions`)
      const data = await res.json()
      if (!data.versions) throw new Error('not a Matrix server')
    } catch {
      this.skip()
    }

    alice = await registerUser(`alice_timing_${suffix}`)
    bob = await registerUser(`bob_timing_${suffix}`)
  })

  it('should return messages immediately after join (no delay)', async function () {
    // Step 1: Alice creates room
    const { room_id: roomId } = await createRoom(alice.access_token, `Timing Test ${suffix}`)
    console.log('Room created:', roomId)

    // Step 2: Alice posts 5 messages
    for (let i = 1; i <= 5; i++) {
      await sendMessage(alice.access_token, roomId, `Message ${i}`, `txn_${suffix}_${i}`)
    }
    console.log('Alice posted 5 messages')

    // Step 3: Alice invites Bob
    await invite(alice.access_token, roomId, bob.user_id)

    // Step 4: Bob joins
    const joinResult = await join(bob.access_token, roomId)
    console.log('Bob joined:', joinResult.room_id)

    // Step 5: Bob immediately calls /messages (no from token, dir=f)
    const messages = await getMessages(bob.access_token, roomId, 'f', 100)
    console.log(`Bob received ${messages.chunk?.length || 0} events immediately after join`)

    const textMessages = (messages.chunk || []).filter(e => e.type === 'm.room.message')
    console.log(`Of which ${textMessages.length} are m.room.message`)

    for (const msg of textMessages) {
      console.log(`  → ${msg.content.body}`)
    }

    // Assertions
    assert.strictEqual(textMessages.length, 5, 'Bob should see all 5 messages immediately after join')
  })

  it('should return messages immediately after join (with type filter)', async function () {
    // Same test but with a type filter (like ODIN uses)
    const { room_id: roomId } = await createRoom(alice.access_token, `Filter Test ${suffix}`)

    // Post with custom event type (like ODIN)
    for (let i = 1; i <= 3; i++) {
      await fetch(
        `${HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/io.syncpoint.odin.operation/filter_txn_${suffix}_${i}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${alice.access_token}`
          },
          body: JSON.stringify({ content: `data_${i}` })
        }
      )
    }
    console.log('Alice posted 3 ODIN operations')

    await invite(alice.access_token, roomId, bob.user_id)
    await join(bob.access_token, roomId)

    // Bob calls /messages with filter (like our content() method)
    const filter = JSON.stringify({ types: ['io.syncpoint.odin.operation'], lazy_load_members: true })
    const url = `${HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=f&limit=1000&filter=${encodeURIComponent(filter)}`
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${bob.access_token}` }
    })
    const messages = await res.json()

    const odinEvents = (messages.chunk || []).filter(e => e.type === 'io.syncpoint.odin.operation')
    console.log(`Bob received ${odinEvents.length} ODIN operations with filter`)

    assert.strictEqual(odinEvents.length, 3, 'Bob should see all 3 operations with type filter')
  })
})
