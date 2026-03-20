/**
 * E2E Test: content() immediately after joinLayer().
 *
 * Tests the real ODIN flow: Bob joins a layer and calls content()
 * right away — no sync-gate, no stream. This is how ODIN currently
 * works. The question is: does the federation-resilient catchUp retry
 * make this reliable, or does the server not know about the room yet?
 *
 * Prerequisites:
 *   cd test-e2e && docker compose up -d
 *
 * Run:
 *   npm run test:e2e -- --grep "Project Join Content"
 */

import { describe, it, before, after } from 'mocha'
import assert from 'node:assert/strict'
import levelup from 'levelup'
import memdown from 'memdown'
import subleveldown from 'subleveldown'
import { MatrixClient, setLogger } from '../index.mjs'

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

async function registerUser (username) {
  const res = await fetch(`${HOMESERVER_URL}/_matrix/client/v3/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: `pass_${username}`,
      device_id: `DEVICE_${username}`,
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

function createDB () {
  const db = levelup(memdown())
  return subleveldown(db, 'command-queue', { valueEncoding: 'json' })
}

function waitForQueueDrain (project, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const check = () => {
      if (project.commandAPI.scheduledCalls.isBlocked()) {
        setTimeout(resolve, 200)
      } else if (Date.now() > deadline) {
        reject(new Error('CommandAPI queue did not drain in time'))
      } else {
        setTimeout(check, 100)
      }
    }
    setTimeout(check, 200)
  })
}

describe('Project Join Content (E2E)', function () {
  this.timeout(30000)

  let aliceCreds, bobCreds
  let aliceClient, bobClient
  let aliceProject

  const projectLocalId = `project-${suffix}`
  const layerLocalId = `layer-${suffix}`

  const testOps = [
    { type: 'put', key: 'feature:1', value: { name: 'Alpha', seq: 1 } },
    { type: 'put', key: 'feature:2', value: { name: 'Bravo', seq: 2 } },
    { type: 'put', key: 'feature:3', value: { name: 'Charlie', seq: 3 } }
  ]

  before(async function () {
    try {
      const res = await fetch(`${HOMESERVER_URL}/_matrix/client/versions`)
      const data = await res.json()
      if (!data.versions) throw new Error('not a Matrix server')
    } catch {
      this.skip()
    }

    aliceCreds = await registerUser(`alice_pjc_${suffix}`)
    bobCreds = await registerUser(`bob_pjc_${suffix}`)

    aliceClient = MatrixClient({ ...aliceCreds, db: createDB() })
    bobClient = MatrixClient({ ...bobCreds, db: createDB() })

    // Alice: create project, layer, post content, invite Bob
    const aliceProjectList = await aliceClient.projectList(aliceCreds)
    const shared = await aliceProjectList.share(projectLocalId, 'Test Project', 'E2E test')

    aliceProject = await aliceClient.project(aliceCreds)
    await aliceProject.hydrate({ id: projectLocalId, upstreamId: shared.upstreamId })
    await aliceProject.shareLayer(layerLocalId, 'Test Layer', '')
    await aliceProject.post(layerLocalId, testOps)
    await waitForQueueDrain(aliceProject)

    await aliceProjectList.invite(projectLocalId, bobCreds.user_id)
  })

  after(async function () {
    if (aliceProject?.commandAPI) await aliceProject.commandAPI.stop()
  })

  it('content() immediately after joinLayer() should return all operations', async function () {

    // Bob receives invitation via ProjectList
    const bobProjectList = await bobClient.projectList(bobCreds)

    const invitation = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No invite received')), 15000)
      bobProjectList.start(null, {
        error: async (err) => { clearTimeout(timer); reject(err) },
        invited: async (project) => {
          clearTimeout(timer)
          await bobProjectList.stop()
          resolve(project)
        }
      })
    })

    // Bob joins project and hydrates
    await bobProjectList.join(invitation.id)

    const bobProject = await bobClient.project(bobCreds)
    const projectStructure = await bobProject.hydrate({
      id: invitation.id,
      upstreamId: bobProjectList.wellKnown.get(invitation.id)
    })

    assert.ok(projectStructure.invitations.length > 0, 'Bob should see the layer as invitation')

    // Bob joins layer and IMMEDIATELY calls content() — no sync-gate
    const inv = projectStructure.invitations[0]
    await bobProject.joinLayer(inv.id)
    const loaded = await bobProject.content(layerLocalId)

    console.log(`  Immediate content() returned ${loaded.length} operations`)

    // Verify all operations in correct order
    assert.equal(loaded.length, testOps.length,
      `Expected ${testOps.length} operations, got ${loaded.length}`)

    for (let i = 0; i < testOps.length; i++) {
      assert.deepStrictEqual(loaded[i], testOps[i],
        `Operation at index ${i} out of order`)
    }
  })
})
