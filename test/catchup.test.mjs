import { describe, it, beforeEach } from 'mocha'
import assert from 'node:assert/strict'
import { TimelineAPI } from '../src/timeline-api.mjs'
import { setLogger } from '../src/logger.mjs'

// Suppress log output during tests
setLogger({
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {}
})

/**
 * Create a fake httpApi with a controllable getMessages response sequence.
 * Each call to getMessages() shifts the next response from the array.
 */
function createFakeHttpApi (responses) {
  const calls = []
  return {
    calls,
    credentials: { user_id: '@test:localhost' },
    getMessages: async (roomId, options) => {
      calls.push({ roomId, options: { ...options } })
      if (responses.length === 0) {
        throw new Error('Unexpected getMessages call — no more responses queued')
      }
      return responses.shift()
    },
    sync: async () => ({ rooms: {}, next_batch: 'unused' })
  }
}

describe('TimelineAPI.catchUp', function () {
  this.timeout(15000)

  it('should collect events from a single page', async () => {
    const api = createFakeHttpApi([
      { chunk: [{ type: 'test', event_id: '1' }, { type: 'test', event_id: '2' }], start: 'a' }
    ])
    const timeline = new TimelineAPI(api)
    const result = await timeline.catchUp('!room:test', null, null, 'f', {})

    assert.equal(result.events.length, 2)
    assert.equal(result.roomId, '!room:test')
    assert.equal(api.calls.length, 1)
    assert.equal(api.calls[0].options.limit, 100)
  })

  it('should paginate across multiple pages', async () => {
    const api = createFakeHttpApi([
      { chunk: [{ event_id: '1' }], start: 'a', end: 'b' },
      { chunk: [{ event_id: '2' }], start: 'b', end: 'c' },
      { chunk: [{ event_id: '3' }], start: 'c' }  // no end = last page
    ])
    const timeline = new TimelineAPI(api)
    const result = await timeline.catchUp('!room:test', null, null, 'f', {})

    assert.equal(result.events.length, 3)
    assert.equal(api.calls.length, 3)
    assert.equal(api.calls[1].options.from, 'b')
    assert.equal(api.calls[2].options.from, 'c')
  })

  it('should stop when end equals the target token (to)', async () => {
    const api = createFakeHttpApi([
      { chunk: [{ event_id: '1' }], start: 'a', end: 'target' }
    ])
    const timeline = new TimelineAPI(api)
    const result = await timeline.catchUp('!room:test', 'target', 'a', 'b', {})

    assert.equal(result.events.length, 1)
    assert.equal(api.calls.length, 1)
  })

  it('should stop on empty chunk with no end token', async () => {
    const api = createFakeHttpApi([
      { chunk: [], start: 'a' }
    ])
    const timeline = new TimelineAPI(api)
    const result = await timeline.catchUp('!room:test', null, null, 'f', {})

    assert.equal(result.events.length, 0)
    assert.equal(api.calls.length, 1)
  })

  it('should retry on empty chunk with end token (federation lag)', async () => {
    const api = createFakeHttpApi([
      { chunk: [], start: 'a', end: 'b' },              // empty, retry 1
      { chunk: [], start: 'a', end: 'b' },              // empty, retry 2
      { chunk: [{ event_id: '1' }], start: 'a' }        // events arrive, no end = done
    ])
    const timeline = new TimelineAPI(api)
    const result = await timeline.catchUp('!room:test', null, null, 'f', {})

    assert.equal(result.events.length, 1)
    assert.equal(api.calls.length, 3)
    // All three calls should use the same from-token (no advancement on empty)
    assert.equal(api.calls[0].options.from, api.calls[1].options.from)
    assert.equal(api.calls[1].options.from, api.calls[2].options.from)
  })

  it('should give up after max retries on persistent empty responses', async () => {
    const api = createFakeHttpApi([
      { chunk: [], start: 'a', end: 'b' },  // empty + end → emptyRetries=1
      { chunk: [], start: 'a', end: 'b' },  // emptyRetries=2
      { chunk: [], start: 'a', end: 'b' },  // emptyRetries=3
      { chunk: [], start: 'a', end: 'b' },  // emptyRetries=4
      { chunk: [], start: 'a', end: 'b' },  // emptyRetries=5 > MAX(4) → stop
    ])
    const timeline = new TimelineAPI(api)
    const result = await timeline.catchUp('!room:test', null, null, 'f', {})

    assert.equal(result.events.length, 0)
    assert.equal(api.calls.length, 5)
  })

  it('should reset retry counter when events are received', async () => {
    const api = createFakeHttpApi([
      { chunk: [], start: 'a', end: 'b' },              // empty, retry 1
      { chunk: [{ event_id: '1' }], start: 'a', end: 'c' },  // events, advance to c
      { chunk: [], start: 'c', end: 'd' },              // empty again, retry 1 (counter reset)
      { chunk: [{ event_id: '2' }], start: 'c' }        // events, no end = done
    ])
    const timeline = new TimelineAPI(api)
    const result = await timeline.catchUp('!room:test', null, null, 'f', {})

    assert.equal(result.events.length, 2)
    assert.equal(api.calls.length, 4)
  })

  it('should pass direction and filter correctly', async () => {
    const testFilter = { types: ['m.room.message'], lazy_load_members: true }
    const api = createFakeHttpApi([
      { chunk: [], start: 'a' }
    ])
    const timeline = new TimelineAPI(api)
    await timeline.catchUp('!room:test', 'target', 'start', 'b', testFilter)

    assert.equal(api.calls[0].options.dir, 'b')
    assert.equal(api.calls[0].options.to, 'target')
    assert.equal(api.calls[0].options.from, 'start')
    assert.deepStrictEqual(api.calls[0].options.filter, testFilter)
  })
})
