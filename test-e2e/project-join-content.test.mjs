/**
 * E2E Test: Full ODIN flow — join layer and receive content.
 *
 * Uses ONLY the high-level API (MatrixClient, ProjectList, Project).
 * No direct httpAPI, TimelineAPI, or StructureAPI calls.
 *
 * Flow:
 *   1. Alice creates a project and a layer
 *   2. Alice posts ODIN operations to the layer
 *   3. Alice invites Bob to the project
 *   4. Bob joins the project
 *   5. Bob hydrates the project, starts the stream
 *   6. Bob joins the layer (no explicit content() call)
 *   7. Bob's received() handler should get all operations
 *
 * Prerequisites:
 *   cd test-e2e && docker compose up -d
 *
 * Run:
 *   npm run test:e2e -- --grep "Project Join Content"
 */

import { describe, it, before, after } from 'mocha'
import assert from 'assert'
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

/**
 * Register a user directly via the Matrix API (test helper only).
 */
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
    home_server_url: HOMESERVER_URL
  }
}

function createDB () {
  const db = levelup(memdown())
  return subleveldown(db, 'command-queue', { valueEncoding: 'json' })
}

describe('Project Join Content (E2E)', function () {
  this.timeout(120000)

  let aliceCreds, bobCreds
  let aliceClient, bobClient
  let aliceProjectList, bobProjectList
  let aliceProject, bobProject

  const projectLocalId = `project-${suffix}`
  const layerLocalId = `layer-${suffix}`

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
    aliceCreds = await registerUser(`alice_pjc_${suffix}`)
    bobCreds = await registerUser(`bob_pjc_${suffix}`)

    // Create MatrixClient instances (no E2EE)
    aliceClient = MatrixClient({
      ...aliceCreds,
      db: createDB()
    })
    bobClient = MatrixClient({
      ...bobCreds,
      db: createDB()
    })
  })

  after(async function () {
    if (aliceProject) await aliceProject.stop?.()
    if (bobProject) await bobProject.stop?.()
  })

  it('Bob receives layer content after joining via stream handler', async function () {

    // === Step 1: Alice sets up ProjectList and creates a project ===
    console.log('\n--- Step 1: Alice creates project ---')
    aliceProjectList = await aliceClient.projectList(aliceCreds)
    await aliceProjectList.hydrate()

    const shared = await aliceProjectList.share(projectLocalId, 'Test Project', 'E2E test')
    console.log(`Project created: ${shared.upstreamId}`)

    // === Step 2: Alice invites Bob to the project BEFORE creating the layer ===
    // This way Bob can hydrate and see the layer as invitation.
    console.log('\n--- Step 2: Alice invites Bob ---')
    await aliceProjectList.invite(projectLocalId, bobCreds.user_id)
    console.log('Bob invited')

    // === Step 3: Bob joins the project ===
    console.log('\n--- Step 3: Bob joins project ---')
    bobProjectList = await bobClient.projectList(bobCreds)
    await bobProjectList.hydrate()
    await bobProjectList.join(projectLocalId)
    console.log('Bob joined project')

    // === Step 4: Alice creates layer and posts content ===
    console.log('\n--- Step 4: Alice creates layer and posts content ---')
    aliceProject = await aliceClient.project(aliceCreds)
    await aliceProject.hydrate({ id: projectLocalId, upstreamId: shared.upstreamId })

    const layer = await aliceProject.shareLayer(layerLocalId, 'Test Layer', '')
    console.log(`Layer created: ${layer.upstreamId}`)

    // Post ODIN operations via commandAPI
    const testOps = [
      { type: 'put', key: 'feature:1', value: { name: 'Tank', sidc: 'SFGPUCA---' } },
      { type: 'put', key: 'feature:2', value: { name: 'HQ', sidc: 'SFGPUH----' } },
      { type: 'put', key: 'feature:3', value: { name: 'Infantry', sidc: 'SFGPUCI---' } }
    ]
    await aliceProject.post(layerLocalId, testOps)

    // Wait for command queue to drain
    await new Promise(resolve => setTimeout(resolve, 3000))
    console.log('Content posted: 3 operations')

    // === Step 5: Bob hydrates the project ===
    console.log('\n--- Step 5: Bob hydrates project ---')
    bobProject = await bobClient.project(bobCreds)
    const projectUpstreamId = bobProjectList.wellKnown.get(projectLocalId)

    let projectStructure
    for (let attempt = 0; attempt < 10; attempt++) {
      projectStructure = await bobProject.hydrate({ id: projectLocalId, upstreamId: projectUpstreamId })
      if (projectStructure.invitations.length > 0) break
      console.log(`  Hydrate attempt ${attempt + 1}: ${projectStructure.layers.length} layers, ${projectStructure.invitations.length} invitations — retrying...`)
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    console.log(`Bob hydrated: ${projectStructure.layers.length} layers, ${projectStructure.invitations.length} invitations`)
    assert.ok(projectStructure.invitations.length > 0, 'Bob should see the layer as an invitation')

    // === Step 6: Bob starts the stream and joins the layer ===
    console.log('\n--- Step 6: Bob starts stream and joins layer ---')

    const receivedOps = []
    let receivedResolve
    const receivedPromise = new Promise(resolve => { receivedResolve = resolve })

    const timeout = setTimeout(() => receivedResolve(), 60000)

    bobProject.start(undefined, {
      streamToken: async () => {},
      received: async ({ id, operations }) => {
        console.log(`  received() called: ${operations.length} operations for layer ${id}`)
        receivedOps.push(...operations)
        if (receivedOps.length >= 3) {
          clearTimeout(timeout)
          receivedResolve()
        }
      },
      invited: async (invitation) => {
        console.log(`  invited() called: ${invitation.name}`)
      },
      renamed: async () => {},
      roleChanged: async () => {},
      membershipChanged: async () => {},
      error: async (err) => {
        console.error('Stream error:', err)
      }
    })

    // Give the stream a moment to start
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Bob joins the layer — NO content() call after this
    const invitation = projectStructure.invitations[0]
    console.log(`Joining layer: ${invitation.id} (${invitation.name})`)
    const joinedLayer = await bobProject.joinLayer(invitation.id)
    console.log(`Joined layer: ${joinedLayer.id}`)

    // === Step 7: Wait for operations to arrive via received() ===
    console.log('\n--- Step 7: Waiting for operations via received() handler ---')
    await receivedPromise

    await bobProject.stop()

    // === Assertions ===
    console.log(`\nReceived ${receivedOps.length} operations total`)
    assert.strictEqual(receivedOps.length, 3, 'Bob should receive all 3 operations')
    assert.strictEqual(receivedOps[0].key, 'feature:1')
    assert.strictEqual(receivedOps[0].value.name, 'Tank')
    assert.strictEqual(receivedOps[1].key, 'feature:2')
    assert.strictEqual(receivedOps[1].value.name, 'HQ')
    assert.strictEqual(receivedOps[2].key, 'feature:3')
    assert.strictEqual(receivedOps[2].value.name, 'Infantry')

    console.log('\n✅ Bob received all layer content via stream handler after join!')
  })
})
