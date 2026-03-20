/**
 * Test: How does the Matrix /sync endpoint behave when not_senders
 * filters out the joining user's own events?
 *
 * Specifically:
 *   1. Does the room appear in rooms.join after a self-join?
 *   2. Are timeline events present or filtered?
 *   3. Are state events present or filtered?
 *
 * This test uses raw /sync calls to observe server behavior directly,
 * without any library abstraction.
 *
 * Prerequisites:
 *   cd test-e2e && docker compose up -d
 */

import { describe, it, before } from 'mocha'
import assert from 'node:assert/strict'
import { setLogger } from '../src/logger.mjs'

const HOMESERVER_URL = process.env.HOMESERVER_URL || 'http://localhost:8008'
const suffix = Date.now().toString(36)

setLogger({
  info: () => {},
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
      device_id: `DEV_${username}`,
      auth: { type: 'm.login.dummy' }
    })
  })
  const data = await res.json()
  if (data.errcode) throw new Error(`Registration failed: ${data.error}`)
  return { user_id: data.user_id, access_token: data.access_token }
}

async function rawSync (accessToken, since, filter, timeout = 0) {
  const params = new URLSearchParams()
  if (since) params.set('since', since)
  if (filter) params.set('filter', JSON.stringify(filter))
  params.set('timeout', String(timeout))

  const res = await fetch(
    `${HOMESERVER_URL}/_matrix/client/v3/sync?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  return res.json()
}

describe('Sync filter behavior: not_senders and self-join', function () {
  this.timeout(30000)

  let alice, bob
  let roomId

  before(async function () {
    try {
      const res = await fetch(`${HOMESERVER_URL}/_matrix/client/versions`)
      const data = await res.json()
      if (!data.versions) throw new Error('not a Matrix server')
    } catch {
      this.skip()
    }

    alice = await registerUser(`alice_sfb_${suffix}`)
    bob = await registerUser(`bob_sfb_${suffix}`)

    // Alice creates a room and posts content
    const createRes = await fetch(`${HOMESERVER_URL}/_matrix/client/v3/createRoom`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alice.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'filter-test',
        preset: 'private_chat',
        invite: [bob.user_id]
      })
    }).then(r => r.json())
    roomId = createRes.room_id

    // Alice posts an ODIN-like message
    await fetch(`${HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/io.syncpoint.odin.operation/txn1`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${alice.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content: 'dGVzdA==' })
    })
  })

  it('without not_senders: room + join event appear in sync after join', async function () {
    // Bob does an initial sync to get a since token
    const initial = await rawSync(bob.access_token, undefined, undefined, 0)
    const since = initial.next_batch

    // Bob joins
    await fetch(`${HOMESERVER_URL}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bob.access_token}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    })

    // Incremental sync — no filter
    const sync = await rawSync(bob.access_token, since, undefined, 1000)

    const room = sync.rooms?.join?.[roomId]
    console.log(`  Room in rooms.join: ${!!room}`)
    console.log(`  Timeline events: ${room?.timeline?.events?.length || 0}`)
    console.log(`  State events: ${room?.state?.events?.length || 0}`)

    if (room?.timeline?.events) {
      room.timeline.events.forEach(e =>
        console.log(`    timeline: ${e.type} sender=${e.sender} state_key=${e.state_key ?? '-'}`)
      )
    }
    if (room?.state?.events) {
      room.state.events.forEach(e =>
        console.log(`    state: ${e.type} sender=${e.sender} state_key=${e.state_key ?? '-'}`)
      )
    }

    assert.ok(room, 'Room should appear in rooms.join')
  })

  it('with not_senders=[bob]: does the room still appear?', async function () {
    // Fresh users so we start clean
    const alice2 = await registerUser(`alice2_sfb_${suffix}`)
    const bob2 = await registerUser(`bob2_sfb_${suffix}`)

    // Alice creates room, posts content
    const createRes = await fetch(`${HOMESERVER_URL}/_matrix/client/v3/createRoom`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alice2.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'filter-test-2',
        preset: 'private_chat',
        invite: [bob2.user_id]
      })
    }).then(r => r.json())
    const room2Id = createRes.room_id

    await fetch(`${HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(room2Id)}/send/io.syncpoint.odin.operation/txn2`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${alice2.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content: 'dGVzdA==' })
    })

    // Bob initial sync with the ODIN-like filter
    const filter = {
      account_data: { not_types: ['*'] },
      room: {
        timeline: {
          lazy_load_members: true,
          limit: 1000,
          types: ['m.room.name', 'm.room.power_levels', 'm.space.child', 'm.room.member', 'io.syncpoint.odin.operation'],
          not_senders: [bob2.user_id]
        },
        ephemeral: { not_types: ['*'] }
      }
    }

    const initial = await rawSync(bob2.access_token, undefined, filter, 0)
    const since = initial.next_batch

    // Bob joins
    await fetch(`${HOMESERVER_URL}/_matrix/client/v3/join/${encodeURIComponent(room2Id)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bob2.access_token}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    })

    // Incremental sync WITH the not_senders filter
    const sync = await rawSync(bob2.access_token, since, filter, 1000)

    const room = sync.rooms?.join?.[room2Id]
    const timelineEvents = room?.timeline?.events || []
    const stateEvents = room?.state?.events || []

    console.log(`  Room in rooms.join: ${!!room}`)
    console.log(`  Timeline events: ${timelineEvents.length}`)
    console.log(`  State events: ${stateEvents.length}`)
    console.log(`  Timeline limited: ${room?.timeline?.limited}`)
    console.log(`  Timeline prev_batch: ${room?.timeline?.prev_batch ? 'present' : 'absent'}`)

    timelineEvents.forEach(e =>
      console.log(`    timeline: ${e.type} sender=${e.sender} state_key=${e.state_key ?? '-'}`)
    )
    stateEvents.forEach(e =>
      console.log(`    state: ${e.type} sender=${e.sender} state_key=${e.state_key ?? '-'}`)
    )

    // Document findings
    if (room) {
      console.log('\n  ✅ Room DOES appear in rooms.join despite not_senders filter')
    } else {
      console.log('\n  ❌ Room does NOT appear in rooms.join — not_senders suppresses it entirely')
    }

    if (timelineEvents.length === 0 && stateEvents.length === 0) {
      console.log('  ⚠️  No events at all — room appears as empty shell')
    }
  })

  it('with not_senders=[bob] + rooms=[roomId]: does the room still appear?', async function () {
    // This tests the exact Project.start() filter: not_senders + explicit rooms list
    const alice3 = await registerUser(`alice3_sfb_${suffix}`)
    const bob3 = await registerUser(`bob3_sfb_${suffix}`)

    const createRes = await fetch(`${HOMESERVER_URL}/_matrix/client/v3/createRoom`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alice3.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'filter-test-3',
        preset: 'private_chat',
        invite: [bob3.user_id]
      })
    }).then(r => r.json())
    const room3Id = createRes.room_id

    await fetch(`${HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(room3Id)}/send/io.syncpoint.odin.operation/txn3`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${alice3.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content: 'dGVzdA==' })
    })

    // Filter with rooms list that INCLUDES the target room (simulating
    // that idMapping was updated before join, as proposed)
    const filter = {
      account_data: { not_types: ['*'] },
      room: {
        timeline: {
          lazy_load_members: true,
          limit: 1000,
          types: ['m.room.name', 'm.room.power_levels', 'm.space.child', 'm.room.member', 'io.syncpoint.odin.operation'],
          not_senders: [bob3.user_id],
          rooms: [room3Id]
        },
        ephemeral: { not_types: ['*'] }
      }
    }

    const initial = await rawSync(bob3.access_token, undefined, filter, 0)
    const since = initial.next_batch

    // Bob joins
    await fetch(`${HOMESERVER_URL}/_matrix/client/v3/join/${encodeURIComponent(room3Id)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bob3.access_token}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    })

    // Incremental sync with not_senders + rooms filter
    const sync = await rawSync(bob3.access_token, since, filter, 1000)

    const room = sync.rooms?.join?.[room3Id]
    const timelineEvents = room?.timeline?.events || []
    const stateEvents = room?.state?.events || []

    console.log(`  Room in rooms.join: ${!!room}`)
    console.log(`  Timeline events: ${timelineEvents.length}`)
    console.log(`  State events: ${stateEvents.length}`)
    console.log(`  Timeline limited: ${room?.timeline?.limited}`)

    timelineEvents.forEach(e =>
      console.log(`    timeline: ${e.type} sender=${e.sender} state_key=${e.state_key ?? '-'}`)
    )
    stateEvents.forEach(e =>
      console.log(`    state: ${e.type} sender=${e.sender} state_key=${e.state_key ?? '-'}`)
    )

    if (room) {
      console.log('\n  ✅ Room appears with not_senders + rooms filter')
    } else {
      console.log('\n  ❌ Room does NOT appear with not_senders + rooms filter')
    }
  })
})
