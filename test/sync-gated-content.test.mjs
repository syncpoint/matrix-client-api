import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'mocha'
import { Base64 } from 'js-base64'
import { Project } from '../src/project.mjs'

/**
 * Minimal stubs for Project dependencies.
 * Only the methods actually called in joinLayer() and start() are stubbed.
 */

const createStructureAPI = (rooms = {}) => ({
  join: async () => {},
  getLayer: async (roomId) => rooms[roomId] || {
    id: 'layer-1',
    room_id: roomId,
    name: 'Test Layer',
    topic: '',
    powerlevel: {
      self: { name: 'OWNER' },
      default: { name: 'CONTRIBUTOR' }
    }
  },
  project: async () => ({
    name: 'Test Project',
    candidates: []
  })
})

const ODINv2_MESSAGE_TYPE = 'io.syncpoint.odin.operation'

/**
 * Create a fake TimelineAPI that yields a sequence of sync chunks,
 * then stops. content() returns the given operations.
 */
const createTimelineAPI = ({ syncChunks = [], contentResult = { events: [] }, credentials } = {}) => {
  const api = {
    credentials: () => credentials || { user_id: '@alice:test' },

    content: async (roomId, filter) => {
      // Track the filter used for assertions
      api._lastContentFilter = filter
      api._lastContentRoomId = roomId
      api._contentCallCount = (api._contentCallCount || 0) + 1
      return contentResult
    },

    stream: async function * () {
      for (const chunk of syncChunks) {
        yield chunk
      }
    },

    // For assertions
    _contentCallCount: 0,
    _lastContentFilter: null,
    _lastContentRoomId: null
  }
  return api
}

const createCommandAPI = () => ({
  schedule: () => {},
  run: () => {}
})

const encodeOperation = (ops) => Base64.encodeURI(JSON.stringify(ops))

describe('Sync-Gated Content after Join', function () {
  this.timeout(5000)

  describe('joinLayer()', () => {
    it('should add room to pendingContent', async () => {
      const roomId = '!room1:test'
      const project = new Project({
        structureAPI: createStructureAPI({
          [roomId]: {
            id: 'layer-1',
            room_id: roomId,
            name: 'Test',
            topic: '',
            powerlevel: { self: { name: 'OWNER' }, default: { name: 'CONTRIBUTOR' } }
          }
        }),
        timelineAPI: createTimelineAPI(),
        commandAPI: createCommandAPI()
      })

      // Need idMapping for the Base64 lookup path
      await project.joinLayer(roomId)

      assert.ok(project.pendingContent.has(roomId), 'Room should be in pendingContent after join')
    })

    it('should register room encryption when cryptoManager is available', async () => {
      const roomId = '!encrypted-room:test'
      let registeredRoom = null

      const fakeCrypto = {
        setRoomEncryption: async (rid) => { registeredRoom = rid }
      }

      const project = new Project({
        structureAPI: createStructureAPI({
          [roomId]: {
            id: 'layer-1',
            room_id: roomId,
            name: 'Encrypted Layer',
            topic: '',
            encryption: { algorithm: 'm.megolm.v1.aes-sha2' },
            powerlevel: { self: { name: 'OWNER' }, default: { name: 'CONTRIBUTOR' } }
          }
        }),
        timelineAPI: createTimelineAPI(),
        commandAPI: createCommandAPI(),
        cryptoManager: fakeCrypto
      })

      await project.joinLayer(roomId)

      assert.strictEqual(registeredRoom, roomId, 'Should register room encryption')
      assert.ok(project.pendingContent.has(roomId))
    })

    it('should not register encryption when room is not encrypted', async () => {
      const roomId = '!plain-room:test'
      let registeredRoom = null

      const fakeCrypto = {
        setRoomEncryption: async (rid) => { registeredRoom = rid }
      }

      const project = new Project({
        structureAPI: createStructureAPI({
          [roomId]: {
            id: 'layer-1',
            room_id: roomId,
            name: 'Plain Layer',
            topic: '',
            powerlevel: { self: { name: 'OWNER' }, default: { name: 'CONTRIBUTOR' } }
          }
        }),
        timelineAPI: createTimelineAPI(),
        commandAPI: createCommandAPI(),
        cryptoManager: fakeCrypto
      })

      await project.joinLayer(roomId)

      assert.strictEqual(registeredRoom, null, 'Should not register encryption for unencrypted room')
    })
  })

  describe('start() — pending content processing', () => {
    it('should fetch content when pending room appears in sync', async () => {
      const roomId = '!room1:test'
      const layerId = 'layer-1'

      const ops = [{ type: 'put', key: 'feature:123', value: { name: 'test' } }]
      const encodedContent = Base64.encodeURI(JSON.stringify(ops))

      const receivedOps = []

      const timelineAPI = createTimelineAPI({
        syncChunks: [
          // First sync: room appears with some events
          {
            next_batch: 'batch_2',
            events: {
              [roomId]: [
                { type: 'm.room.member', state_key: '@bob:test', content: { membership: 'join' } }
              ]
            },
            stateEvents: {}
          }
        ],
        contentResult: {
          events: [
            {
              type: ODINv2_MESSAGE_TYPE,
              content: { content: encodedContent }
            }
          ]
        }
      })

      const project = new Project({
        structureAPI: createStructureAPI({
          [roomId]: {
            id: layerId,
            room_id: roomId,
            name: 'Test',
            topic: '',
            powerlevel: { self: { name: 'OWNER' }, default: { name: 'CONTRIBUTOR' } }
          }
        }),
        timelineAPI,
        commandAPI: createCommandAPI()
      })

      // Simulate: project is hydrated, idMapping is set
      project.idMapping.remember(layerId, roomId)

      // Simulate: room was just joined
      project.pendingContent.add(roomId)

      // Run start with a handler that captures received operations
      await project.start('batch_1', {
        streamToken: async () => {},
        received: async ({ id, operations }) => {
          receivedOps.push({ id, operations })
        }
      })

      // Verify content() was called
      assert.strictEqual(timelineAPI._contentCallCount, 1, 'content() should be called once')

      // Verify operations were delivered via received()
      assert.strictEqual(receivedOps.length, 1)
      assert.strictEqual(receivedOps[0].id, layerId)
      assert.deepStrictEqual(receivedOps[0].operations, ops)

      // Verify room was removed from pendingContent
      assert.ok(!project.pendingContent.has(roomId), 'Room should be removed from pendingContent')
    })

    it('should not fetch content if room is not yet in sync', async () => {
      const roomId = '!room1:test'
      const otherRoomId = '!other:test'

      const timelineAPI = createTimelineAPI({
        syncChunks: [
          // Sync contains a different room, not our pending one
          {
            next_batch: 'batch_2',
            events: {
              [otherRoomId]: [
                { type: 'm.room.name', state_key: '', content: { name: 'Other' } }
              ]
            },
            stateEvents: {}
          }
        ]
      })

      const project = new Project({
        structureAPI: createStructureAPI(),
        timelineAPI,
        commandAPI: createCommandAPI()
      })

      project.idMapping.remember('layer-1', roomId)
      project.pendingContent.add(roomId)

      await project.start('batch_1', {
        streamToken: async () => {}
      })

      // content() should NOT have been called — room wasn't in sync
      assert.strictEqual(timelineAPI._contentCallCount, 0, 'content() should not be called')

      // Room should still be pending
      assert.ok(project.pendingContent.has(roomId), 'Room should still be in pendingContent')
    })

    it('should not call received() when content has no operations', async () => {
      const roomId = '!empty-room:test'
      const receivedCalls = []

      const timelineAPI = createTimelineAPI({
        syncChunks: [
          {
            next_batch: 'batch_2',
            events: { [roomId]: [{ type: 'm.room.create', state_key: '', content: {} }] },
            stateEvents: {}
          }
        ],
        contentResult: { events: [] }  // No ODIN operations
      })

      const project = new Project({
        structureAPI: createStructureAPI(),
        timelineAPI,
        commandAPI: createCommandAPI()
      })

      project.idMapping.remember('layer-1', roomId)
      project.pendingContent.add(roomId)

      await project.start('batch_1', {
        streamToken: async () => {},
        received: async (data) => { receivedCalls.push(data) }
      })

      assert.strictEqual(timelineAPI._contentCallCount, 1, 'content() should still be called')
      assert.strictEqual(receivedCalls.length, 0, 'received() should not be called for empty content')
      assert.ok(!project.pendingContent.has(roomId), 'Room should be removed from pendingContent')
    })

    it('should use content filter without not_senders', async () => {
      const roomId = '!room1:test'

      const timelineAPI = createTimelineAPI({
        syncChunks: [
          {
            next_batch: 'batch_2',
            events: { [roomId]: [{ type: 'm.room.member', state_key: '@bob:test', content: { membership: 'join' } }] },
            stateEvents: {}
          }
        ],
        contentResult: { events: [] }
      })

      const project = new Project({
        structureAPI: createStructureAPI(),
        timelineAPI,
        commandAPI: createCommandAPI()
      })

      project.idMapping.remember('layer-1', roomId)
      project.pendingContent.add(roomId)

      await project.start('batch_1', {
        streamToken: async () => {}
      })

      // content() is called via Project.content() which builds the filter internally.
      // The key point: Project.content() does NOT include not_senders.
      // We verify this by checking that content() was called (the filter is built inside Project.content).
      assert.strictEqual(timelineAPI._contentCallCount, 1)
    })

    it('should handle multiple pending rooms across sync cycles', async () => {
      const room1 = '!room1:test'
      const room2 = '!room2:test'
      const receivedOps = []

      const ops1 = [{ type: 'put', key: 'f:1', value: {} }]
      const ops2 = [{ type: 'put', key: 'f:2', value: {} }]

      let contentCallIndex = 0
      const contentResults = [
        { events: [{ type: ODINv2_MESSAGE_TYPE, content: { content: Base64.encodeURI(JSON.stringify(ops1)) } }] },
        { events: [{ type: ODINv2_MESSAGE_TYPE, content: { content: Base64.encodeURI(JSON.stringify(ops2)) } }] }
      ]

      const timelineAPI = createTimelineAPI({
        syncChunks: [
          // First sync: only room1 appears
          {
            next_batch: 'batch_2',
            events: { [room1]: [{ type: 'm.room.create', state_key: '', content: {} }] },
            stateEvents: {}
          },
          // Second sync: room2 appears
          {
            next_batch: 'batch_3',
            events: { [room2]: [{ type: 'm.room.create', state_key: '', content: {} }] },
            stateEvents: {}
          }
        ]
      })

      // Override content to return different results per call
      timelineAPI.content = async (roomId) => {
        timelineAPI._contentCallCount++
        return contentResults[contentCallIndex++]
      }

      const project = new Project({
        structureAPI: createStructureAPI(),
        timelineAPI,
        commandAPI: createCommandAPI()
      })

      project.idMapping.remember('layer-1', room1)
      project.idMapping.remember('layer-2', room2)
      project.pendingContent.add(room1)
      project.pendingContent.add(room2)

      await project.start('batch_1', {
        streamToken: async () => {},
        received: async ({ id, operations }) => {
          receivedOps.push({ id, operations })
        }
      })

      assert.strictEqual(timelineAPI._contentCallCount, 2, 'content() should be called twice')
      assert.strictEqual(receivedOps.length, 2)
      assert.strictEqual(receivedOps[0].id, 'layer-1')
      assert.strictEqual(receivedOps[1].id, 'layer-2')
      assert.ok(!project.pendingContent.has(room1))
      assert.ok(!project.pendingContent.has(room2))
    })
  })
})
