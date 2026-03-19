/**
 * Test: Bob can load layer content after joining an encrypted room.
 *
 * This reproduces the exact ODIN flow:
 *   1. Alice creates an encrypted project + layer
 *   2. Alice posts content (ODIN operations) to the layer
 *   3. Alice shares historical keys with project members
 *   4. Bob joins the layer
 *   5. Bob calls content() to load all existing operations
 *
 * Prerequisites:
 *   cd test-e2e && docker compose up -d
 *
 * Run:
 *   npm run test:e2e -- --grep "Content after Join"
 */

import { describe, it, before, after } from 'mocha'
import assert from 'node:assert/strict'

import { HttpAPI } from '../src/http-api.mjs'
import { StructureAPI } from '../src/structure-api.mjs'
import { CommandAPI } from '../src/command-api.mjs'
import { TimelineAPI } from '../src/timeline-api.mjs'
import { Project } from '../src/project.mjs'
import { ProjectList } from '../src/project-list.mjs'
import { setLogger } from '../src/logger.mjs'
import { randomUUID } from 'crypto'

import levelup from 'levelup'
import memdown from 'memdown'
import subleveldown from 'subleveldown'

const createDB = () => {
  const db = levelup(memdown())
  const s = subleveldown(db, 'command-queue', { valueEncoding: 'json' })
  return s
}

const HOMESERVER_URL = process.env.HOMESERVER_URL || 'http://localhost:8008'
const suffix = Date.now().toString(36)

// Enable debug logging with E2E_DEBUG=1
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
    home_server_url: HOMESERVER_URL,
    password: `pass_${username}`
  }
}

async function buildStack (credentials) {
  const httpAPI = new HttpAPI(credentials)


  const structureAPI = new StructureAPI(httpAPI)
  const db = createDB()
  const getMemberIds = async (roomId) => {
    const members = await httpAPI.members(roomId)
    return (members.chunk || [])
      .filter(e => e.content?.membership === 'join')
      .map(e => e.state_key)
      .filter(Boolean)
  }
  const commandAPI = new CommandAPI(httpAPI, getMemberIds, { db })
  const timelineAPI = new TimelineAPI(httpAPI)

  return {
    projectList: new ProjectList({ structureAPI, timelineAPI }),
    project: new Project({ structureAPI, timelineAPI, commandAPI }),
    userId: credentials.user_id
  }
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

describe('Content after Join', function () {
  this.timeout(60000)

  let aliceCreds, bobCreds
  let alice, bob

  let projectId, layerId

  const first = [
    { type: 'put', key: 'feature:1', value: { name: 'Tank', sidc: 'SFGPUCA---' } }
  ]

  const second = [
    { type: 'put', key: 'feature:2', value: { name: 'HQ', sidc: 'SFGPUH----' } }
  ]

  const expectedOperations = [...first, ...second]

  before(async function () {
    try {
      const res = await fetch(`${HOMESERVER_URL}/_matrix/client/versions`)
      const data = await res.json()
      if (!data.versions) throw new Error('not a Matrix server')
    } catch {
      this.skip()
    }

    aliceCreds = await registerUser(`alice_${suffix}`, `ALICE_${suffix}`)
    bobCreds = await registerUser(`bob_${suffix}`, `BOB_${suffix}`)

    alice = await buildStack(aliceCreds)
    bob = await buildStack(bobCreds)

    projectId = `project:${randomUUID()}`
    layerId = `layer:${randomUUID()}`

  })

  after(async function () {
    if (alice?.projectList) await alice.projectList.stop()
    if (bob?.projectList) await bob.projectList.stop()
    if (alice?.crypto) await alice.crypto.close()
    if (bob?.crypto) await bob.crypto.close()
  })

  it('Alice creates and shares a project with bob, creates a shared layer and posts some content', async function() {
    

    const projectDescriptor = await alice.projectList.share(projectId, 'Who the fuck is Alice', 'TEST')
    await alice.project.hydrate({ id: projectDescriptor.id, upstreamId: projectDescriptor.upstreamId })

    const layerStructure = await alice.project.shareLayer(layerId, 'Who needs a name', 'TEST')

    
    await alice.project.post(layerStructure.id, first)
    await alice.project.post(layerStructure.id, second)

    await alice.projectList.invite(projectId, bob.userId)
  })

  it('Bob receives a project invitation, accepts it, joins all layers and loads the layer content', async function() {

    const controller = new AbortController()
    Object.defineProperty(controller.signal, 'id', { value: 'mocha-test', writable: false, enumerable: true })

    let resolver
    const handlerPromise = new Promise((resolve) => {
      resolver = resolve
    })

    const projectListHandler = {
      error: async function (error) {
        console.error(error)
      },
      streamToken: async function (token) {
        // ignored
      },
      invited: async function(project) {
        const projectDescriptor = await bob.projectList.join(project.id)

        const projectStructure = await bob.project.hydrate({ id: projectDescriptor.id, upstreamId: projectDescriptor.upstreamId })
      
        const promisesToJoinLayer = projectStructure.invitations.map(invitation => {
          const p = bob.project.joinLayer(invitation.id)
          return p
        })
        await Promise.all(promisesToJoinLayer)

        const operations = await bob.project.content(layerId)
        resolver(operations)
      }
    }

    bob.projectList.start(null, projectListHandler)

    const operations = await handlerPromise

    assert.equal(operations.length, 2, `Bob should have received 2 operations`)
    assert.deepStrictEqual(operations, expectedOperations, 'Operations received by Bob are not equal to the ones Alice sent')

    await bob.projectList.stop()
  })


  
})
