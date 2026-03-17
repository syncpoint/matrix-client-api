import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'mocha'
import { MemoryLevel } from 'memory-level'
import { FIFO } from '../src/queue.mjs'

const createDB = () => {
  return new MemoryLevel({ valueEncoding: 'json' })
}

describe('Persistent FIFO Queue', function () {
  this.timeout(5000)

  let db

  beforeEach(() => {
    db = createDB()
  })

  it('should enqueue and dequeue a command', async () => {
    const queue = new FIFO(db)
    await queue.enqueue(['sendMessageEvent', '!room:test', 'io.syncpoint.odin.operation', { content: 'abc' }])

    const { command, key } = await queue.dequeue()
    assert.deepStrictEqual(command, ['sendMessageEvent', '!room:test', 'io.syncpoint.odin.operation', { content: 'abc' }])
    assert.ok(key, 'should have a persistence key')
    await queue.acknowledge(key)
  })

  it('should maintain FIFO order', async () => {
    const queue = new FIFO(db)
    await queue.enqueue(['sendMessageEvent', '!room:test', 'type', { id: 1 }])
    await queue.enqueue(['sendMessageEvent', '!room:test', 'type', { id: 2 }])
    await queue.enqueue(['sendMessageEvent', '!room:test', 'type', { id: 3 }])

    const first = await queue.dequeue()
    const second = await queue.dequeue()
    const third = await queue.dequeue()

    assert.deepStrictEqual(first.command[3].id, 1)
    assert.deepStrictEqual(second.command[3].id, 2)
    assert.deepStrictEqual(third.command[3].id, 3)
  })

  it('should persist commands across instances', async () => {
    // Enqueue with first instance
    const queue1 = new FIFO(db)
    await queue1.enqueue(['sendMessageEvent', '!room:test', 'type', { data: 'persisted' }])

    // Create second instance on same DB (simulates restart)
    const queue2 = new FIFO(db)
    const { command, key } = await queue2.dequeue()

    assert.deepStrictEqual(command, ['sendMessageEvent', '!room:test', 'type', { data: 'persisted' }])
    assert.ok(key)
  })

  it('should remove entry from DB after acknowledge', async () => {
    const queue = new FIFO(db)
    await queue.enqueue(['sendMessageEvent', '!room:test', 'type', { data: 'temp' }])

    const { key } = await queue.dequeue()
    await queue.acknowledge(key)

    // New instance should have empty queue
    const queue2 = new FIFO(db)
    assert.ok(queue2.isEmpty() || queue2.length === 0)
  })

  it('should keep entry in DB if not acknowledged (crash simulation)', async () => {
    const queue1 = new FIFO(db)
    await queue1.enqueue(['sendMessageEvent', '!room:test', 'type', { data: 'will-crash' }])

    // Dequeue but do NOT acknowledge (simulates crash)
    await queue1.dequeue()

    // New instance should still have the entry
    const queue2 = new FIFO(db)
    const { command } = await queue2.dequeue()
    assert.deepStrictEqual(command[3].data, 'will-crash')
  })

  it('should handle callback functions in-memory only (no key)', async () => {
    const queue = new FIFO(db)
    const callback = async () => {}
    await queue.enqueue([callback])

    const { command, key } = await queue.dequeue()
    assert.strictEqual(typeof command[0], 'function')
    assert.strictEqual(key, null, 'callbacks should not have a persistence key')
  })

  it('should requeue a failed command at the front', async () => {
    const queue = new FIFO(db)
    await queue.enqueue(['sendMessageEvent', '!room:test', 'type', { id: 1 }])
    await queue.enqueue(['sendMessageEvent', '!room:test', 'type', { id: 2 }])

    const first = await queue.dequeue()
    // Simulate failure — requeue first entry
    queue.requeue(first.command, first.key)

    const retry = await queue.dequeue()
    assert.deepStrictEqual(retry.command[3].id, 1, 'requeued entry should come first')
  })

  it('should report correct length', async () => {
    const queue = new FIFO(db)
    assert.strictEqual(queue.length, 0)

    await queue.enqueue(['sendMessageEvent', '!room:test', 'type', {}])
    assert.strictEqual(queue.length, 1)

    await queue.enqueue(['sendMessageEvent', '!room:test', 'type', {}])
    assert.strictEqual(queue.length, 2)

    await queue.dequeue()
    assert.strictEqual(queue.length, 1)
  })

  it('should restore multiple commands in correct order after restart', async () => {
    const queue1 = new FIFO(db)
    await queue1.enqueue(['sendMessageEvent', '!room:test', 'type', { order: 'A' }])
    await queue1.enqueue(['sendMessageEvent', '!room:test', 'type', { order: 'B' }])
    await queue1.enqueue(['sendMessageEvent', '!room:test', 'type', { order: 'C' }])

    // Simulate restart
    const queue2 = new FIFO(db)
    const a = await queue2.dequeue()
    const b = await queue2.dequeue()
    const c = await queue2.dequeue()

    assert.strictEqual(a.command[3].order, 'A')
    assert.strictEqual(b.command[3].order, 'B')
    assert.strictEqual(c.command[3].order, 'C')
  })

  it('should continue counter after restart to avoid key collisions', async () => {
    const queue1 = new FIFO(db)
    await queue1.enqueue(['sendMessageEvent', '!room:test', 'type', { id: 1 }])
    const { key: key1 } = await queue1.dequeue()
    await queue1.acknowledge(key1)

    // Simulate restart, add new entry
    const queue2 = new FIFO(db)
    await queue2._ready
    await queue2.enqueue(['sendMessageEvent', '!room:test', 'type', { id: 2 }])
    const { key: key2 } = await queue2.dequeue()

    assert.notStrictEqual(key1, key2, 'keys should be unique across restarts')
  })
})
