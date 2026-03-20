/**
 * Test: Operations loaded via content() must be in chronological order (oldest first).
 *
 * ODIN applies operations sequentially — if the order is wrong, the resulting
 * layer state is corrupted. This test verifies that content() returns operations
 * in the exact order they were posted, across multiple posts.
 *
 * Prerequisites:
 *   cd test-e2e && docker compose up -d
 *
 * Run:
 *   npm run test:e2e -- --grep "Content Ordering"
 */

import { describe, it, before, after } from 'mocha'
import assert from 'node:assert/strict'

import { HttpAPI } from '../src/http-api.mjs'
import { StructureAPI } from '../src/structure-api.mjs'
import { CommandAPI } from '../src/command-api.mjs'
import { RoomMemberCache } from '../src/room-members.mjs'
import { TimelineAPI } from '../src/timeline-api.mjs'
import { Project } from '../src/project.mjs'
import { ProjectList } from '../src/project-list.mjs'
import { setLogger } from '../src/logger.mjs'
import { randomUUID } from 'crypto'

import levelup from 'levelup'
import memdown from 'memdown'
import subleveldown from 'subleveldown'

const HOMESERVER_URL = process.env.HOMESERVER_URL || 'http://localhost:8008'
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
    home_server: 'odin.battlespace',
    home_server_url: HOMESERVER_URL
  }
}

async function buildStack (credentials) {
  const httpAPI = new HttpAPI(credentials)
  const structureAPI = new StructureAPI(httpAPI)
  const db = (() => {
    const d = levelup(memdown())
    return subleveldown(d, 'command-queue', { valueEncoding: 'json' })
  })()
  const memberCache = new RoomMemberCache(async (roomId) => {
    const members = await httpAPI.members(roomId)
    return (members.chunk || [])
      .filter(e => e.content?.membership === 'join')
      .map(e => e.state_key)
      .filter(Boolean)
  })
  const commandAPI = new CommandAPI(httpAPI, memberCache, { db })
  const timelineAPI = new TimelineAPI(httpAPI)

  return {
    projectList: new ProjectList({ structureAPI, timelineAPI }),
    project: new Project({ structureAPI, timelineAPI, commandAPI }),
    userId: credentials.user_id
  }
}

/**
 * Wait until the CommandAPI queue has drained (all scheduled calls sent).
 * isBlocked() means the run-loop is waiting for new entries — i.e. the queue is empty.
 */
function waitForQueueDrain (project, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const check = () => {
      if (project.commandAPI.scheduledCalls.isBlocked()) {
        setTimeout(resolve, 200)  // small grace period
      } else if (Date.now() > deadline) {
        reject(new Error('CommandAPI queue did not drain in time'))
      } else {
        setTimeout(check, 100)
      }
    }
    setTimeout(check, 200)
  })
}

describe('Content Ordering', function () {
  this.timeout(30000)

  let alice, bob
  let projectId, layerId

  // Five operations posted individually — order matters
  const operations = [
    [{ type: 'put', key: 'feature:1', value: { name: 'Alpha', seq: 1 } }],
    [{ type: 'put', key: 'feature:2', value: { name: 'Bravo', seq: 2 } }],
    [{ type: 'put', key: 'feature:3', value: { name: 'Charlie', seq: 3 } }],
    [{ type: 'put', key: 'feature:1', value: { name: 'Alpha-updated', seq: 4 } }],
    [{ type: 'del', key: 'feature:2', seq: 5 }]
  ]

  const expectedFlat = operations.flat()

  before(async function () {
    try {
      const res = await fetch(`${HOMESERVER_URL}/_matrix/client/versions`)
      const data = await res.json()
      if (!data.versions) throw new Error('not a Matrix server')
    } catch {
      this.skip()
    }

    const aliceCreds = await registerUser(`alice_ord_${suffix}`, `ALICE_ORD_${suffix}`)
    const bobCreds = await registerUser(`bob_ord_${suffix}`, `BOB_ORD_${suffix}`)
    alice = await buildStack(aliceCreds)
    bob = await buildStack(bobCreds)
    projectId = `project:${randomUUID()}`
    layerId = `layer:${randomUUID()}`
  })

  after(async function () {
    if (alice?.projectList) await alice.projectList.stop()
    if (bob?.projectList) await bob.projectList.stop()
  })

  it('should return operations in chronological order (oldest first)', async function () {

    // --- Alice: create project, share layer, post operations sequentially ---
    const projectDescriptor = await alice.projectList.share(projectId, 'Ordering Test', 'TEST')
    await alice.project.hydrate({ id: projectDescriptor.id, upstreamId: projectDescriptor.upstreamId })
    const layerStructure = await alice.project.shareLayer(layerId, 'Ordered Layer', 'TEST')

    // Post each operation individually to ensure separate message events
    for (const op of operations) {
      await alice.project.post(layerStructure.id, op)
    }

    // Wait for CommandAPI to actually send all messages
    await waitForQueueDrain(alice.project)

    // --- Alice invites Bob, Bob joins via ProjectList ---
    await alice.projectList.invite(projectId, bob.userId)

    const invitation = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No invite received')), 15000)
      bob.projectList.start(null, {
        error: async (err) => { clearTimeout(timer); reject(err) },
        invited: async (project) => {
          clearTimeout(timer)
          await bob.projectList.stop()
          resolve(project)
        }
      })
    })

    const bobProjectDescriptor = await bob.projectList.join(invitation.id)
    await bob.project.hydrate({ id: bobProjectDescriptor.id, upstreamId: bobProjectDescriptor.upstreamId })

    const invitations = (await bob.project.hydrate({ id: bobProjectDescriptor.id, upstreamId: bobProjectDescriptor.upstreamId })).invitations
    for (const inv of invitations) {
      await bob.project.joinLayer(inv.id)
    }

    // --- Bob loads content ---
    const loaded = await bob.project.content(layerId)

    // --- Verify order ---
    assert.equal(loaded.length, expectedFlat.length,
      `Expected ${expectedFlat.length} operations, got ${loaded.length}`)

    for (let i = 0; i < expectedFlat.length; i++) {
      assert.deepStrictEqual(loaded[i], expectedFlat[i],
        `Operation at index ${i} is out of order.\nExpected: ${JSON.stringify(expectedFlat[i])}\nGot: ${JSON.stringify(loaded[i])}`)
    }
  })
})
