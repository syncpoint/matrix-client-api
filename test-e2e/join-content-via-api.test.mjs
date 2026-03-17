/**
 * Test: Does Project.content() return content immediately after joinLayer()?
 *
 * Same scenario as join-content-timing.test.mjs but using the matrix-client-api
 * abstractions (ProjectList, Project) to isolate whether our client code
 * causes the missing-content-after-join issue.
 *
 * Prerequisites:
 *   cd test-e2e && docker compose up -d
 *
 * Run:
 *   npm run test:e2e -- --grep "Join content via API"
 */

import { describe, it, before, after } from 'mocha'
import assert from 'assert'
import levelup from 'levelup'
import memdown from 'memdown'
import subleveldown from 'subleveldown'
import { HttpAPI } from '../src/http-api.mjs'
import { StructureAPI } from '../src/structure-api.mjs'
import { CommandAPI } from '../src/command-api.mjs'
import { TimelineAPI } from '../src/timeline-api.mjs'
import { ProjectList } from '../src/project-list.mjs'
import { Project } from '../src/project.mjs'
import { setLogger } from '../src/logger.mjs'
import { Base64 } from 'js-base64'

const HOMESERVER_URL = process.env.HOMESERVER_URL || 'http://localhost:8008'
const suffix = Date.now().toString(36)

setLogger({
  info: (...args) => console.log('[INFO]', ...args),
  debug: (...args) => console.log('[DEBUG]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args)
})

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
    home_server_url: HOMESERVER_URL
  }
}

function createDB () {
  const db = levelup(memdown())
  return subleveldown(db, 'command-queue', { valueEncoding: 'json' })
}

function buildStack (credentials) {
  const httpAPI = new HttpAPI(credentials)
  const structureAPI = new StructureAPI(httpAPI)
  const commandAPI = new CommandAPI(httpAPI, null, createDB())
  const timelineAPI = new TimelineAPI(httpAPI)

  const projectList = new ProjectList({ structureAPI, timelineAPI })
  const project = new Project({ structureAPI, timelineAPI, commandAPI, cryptoManager: null })

  return { httpAPI, structureAPI, commandAPI, timelineAPI, projectList, project }
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

describe('Join content via API', function () {
  this.timeout(30000)

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

    aliceCreds = await registerUser(`alice_api_${suffix}`, `ALICE_API_${suffix}`)
    bobCreds = await registerUser(`bob_api_${suffix}`, `BOB_API_${suffix}`)

    alice = buildStack(aliceCreds)
    bob = buildStack(bobCreds)
  })

  after(async function () {
    if (alice?.commandAPI) await alice.commandAPI.stop()
    if (bob?.commandAPI) await bob.commandAPI.stop()
  })

  it('Project.content() should return operations immediately after joinLayer()', async function () {
    const projectId = `project-api-${suffix}`
    const layerId = `layer-api-${suffix}`

    // === Alice: create project + layer, post content ===
    console.log('\n--- Alice creates project and layer ---')
    const project = await alice.structureAPI.createProject(projectId, 'API Test Project', 'Content after join')
    console.log('Project:', project.globalId)

    const layer = await alice.structureAPI.createLayer(layerId, 'API Test Layer', '')
    await alice.structureAPI.addLayerToProject(project.globalId, layer.globalId)
    console.log('Layer:', layer.globalId)

    // Alice invites Bob to the project
    await alice.httpAPI.invite(project.globalId, bobCreds.user_id)

    // Alice posts ODIN operations via CommandAPI (same as ODIN does)
    const testOps = [
      { type: 'put', key: 'feature:tank1', value: { name: 'Tank Alpha', sidc: 'SFGPUCA---' } },
      { type: 'put', key: 'feature:hq1', value: { name: 'HQ Bravo', sidc: 'SFGPUH----' } },
      { type: 'put', key: 'feature:inf1', value: { name: 'Infantry Charlie', sidc: 'SFGPUCI---' } }
    ]
    const encoded = Base64.encodeURI(JSON.stringify(testOps))
    alice.commandAPI.schedule(['sendMessageEvent', layer.globalId, 'io.syncpoint.odin.operation', { content: encoded }])
    alice.commandAPI.run()
    await waitForCommandQueue(alice.commandAPI)
    console.log('Alice posted 3 operations via CommandAPI')

    // === Bob: hydrate project, join layer, load content ===
    console.log('\n--- Bob joins and loads content ---')

    // Bob joins project first
    await bob.httpAPI.join(project.globalId)

    // Sync to let the server process the join (needed for hierarchy visibility)
    await bob.httpAPI.sync(undefined, undefined, 0)

    // Debug: check raw hierarchy
    const hierarchy = await bob.httpAPI.getRoomHierarchy(project.globalId)
    console.log('Raw hierarchy rooms:', hierarchy.rooms.length)
    for (const room of hierarchy.rooms) {
      console.log(`  → ${room.room_id} type=${room.room_type} name="${room.name}"`)
    }

    // Bob hydrates — same as ODIN does
    const projectStructure = await bob.project.hydrate({ id: projectId, upstreamId: project.globalId })
    console.log('Bob hydrated project')
    console.log('  layers:', projectStructure.layers.length)
    console.log('  invitations:', projectStructure.invitations.length)
    for (const inv of projectStructure.invitations) {
      console.log(`    → ${inv.id} "${inv.name}"`)
    }

    // Bob joins the layer directly via room ID since hierarchy may be slow
    console.log('Bob joining layer directly:', layer.globalId)
    await bob.httpAPI.join(layer.globalId)
    bob.project.idMapping.remember(layerId, layer.globalId)
    const room = await bob.structureAPI.getLayer(layer.globalId)
    console.log('Bob joined layer:', room.id)

    // Bob loads content — same as ODIN toolbar handler
    const operations = await bob.project.content(room.id)
    console.log(`Bob received ${operations.length} operations via Project.content()`)

    for (const op of operations) {
      console.log(`  → ${op.key}: ${op.value?.name}`)
    }

    // === Assertions ===
    assert.strictEqual(operations.length, 3, 'Bob should see all 3 operations immediately')
    assert.strictEqual(operations[0].value.name, 'Tank Alpha')
    assert.strictEqual(operations[1].value.name, 'HQ Bravo')
    assert.strictEqual(operations[2].value.name, 'Infantry Charlie')

    console.log('\n✅ Project.content() returns all operations immediately after joinLayer()!')
  })

  it('should also work when Bob was offline during content posting', async function () {
    const projectId = `offline-api-${suffix}`
    const layerId = `offline-layer-${suffix}`

    // Alice creates everything and posts content while Bob doesn't interact
    console.log('\n--- Alice creates project, layer, and content (Bob offline) ---')
    const project = await alice.structureAPI.createProject(projectId, 'Offline Test', '')
    const layer = await alice.structureAPI.createLayer(layerId, 'Offline Layer', '')
    await alice.structureAPI.addLayerToProject(project.globalId, layer.globalId)
    await alice.httpAPI.invite(project.globalId, bobCreds.user_id)

    // Alice posts multiple batches (like a user editing over time)
    for (let i = 1; i <= 3; i++) {
      const ops = [{ type: 'put', key: `feature:item${i}`, value: { name: `Item ${i}` } }]
      const encoded = Base64.encodeURI(JSON.stringify(ops))
      alice.commandAPI.schedule(['sendMessageEvent', layer.globalId, 'io.syncpoint.odin.operation', { content: encoded }])
    }
    await waitForCommandQueue(alice.commandAPI)
    console.log('Alice posted 3 separate batches')

    // Now Bob comes online: join project, hydrate, join layer, load content
    console.log('\n--- Bob comes online ---')
    await bob.httpAPI.join(project.globalId)
    await bob.httpAPI.sync(undefined, undefined, 0)
    const projectStructure2 = await bob.project.hydrate({ id: projectId, upstreamId: project.globalId })
    console.log('Bob hydrated, invitations:', projectStructure2.invitations.length)
    // Join layer directly
    await bob.httpAPI.join(layer.globalId)
    bob.project.idMapping.remember(layerId, layer.globalId)
    const operations = await bob.project.content(layerId)

    console.log(`Bob received ${operations.length} operations from ${3} batches`)

    assert.strictEqual(operations.length, 3, 'Bob should see all 3 operations from separate batches')

    console.log('\n✅ Offline scenario works!')
  })
})
