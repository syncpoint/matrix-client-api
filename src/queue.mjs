import { getLogger } from './logger.mjs'

const KEY_PREFIX = 'cmd:'
const COUNTER_KEY = '_counter'
const PAD_LENGTH = 16

/**
 * Format a numeric counter as a zero-padded key.
 * @param {number} n
 * @returns {string}
 */
const formatKey = n => `${KEY_PREFIX}${String(n).padStart(PAD_LENGTH, '0')}`

/**
 * Parse the numeric counter from a key.
 * @param {string} key
 * @returns {number}
 */
const parseKey = key => Number(key.slice(KEY_PREFIX.length))

/**
 * A persistent FIFO queue backed by a LevelDB instance (levelup/subleveldown API).
 *
 * Serializable commands (arrays with string function name) are persisted to disk.
 * Non-serializable commands (callbacks) are held in memory only.
 *
 * The queue resolves dequeue() calls in FIFO order, mixing persistent and
 * in-memory entries by insertion order.
 */
class FIFO {
  /**
   * @param {Object} db - A levelup-compatible database instance (e.g. subleveldown)
   */
  constructor (db) {
    this.db = db
    this.counter = 0
    this.pendingResolvers = []
    this.pendingPromises = []
    this._ready = this._restore()
  }

  /**
   * Restore pending commands from the database on startup.
   * @private
   */
  async _restore () {
    const log = getLogger()
    const entries = []

    await new Promise((resolve, reject) => {
      const stream = this.db.createReadStream({ gte: `${KEY_PREFIX}0`, lte: `${KEY_PREFIX}\xFF` })
      stream.on('data', ({ key, value }) => {
        const seq = parseKey(typeof key === 'string' ? key : key.toString())
        const command = typeof value === 'string' ? JSON.parse(value) : value
        entries.push({ seq, key: typeof key === 'string' ? key : key.toString(), command })
      })
      stream.on('error', reject)
      stream.on('end', resolve)
    })

    // Restore the counter (persisted separately to survive acknowledge)
    try {
      const savedCounter = await this.db.get(COUNTER_KEY)
      this.counter = typeof savedCounter === 'number' ? savedCounter : Number(savedCounter)
    } catch (err) {
      // Key not found — counter stays at 0
    }

    if (entries.length > 0) {
      entries.sort((a, b) => a.seq - b.seq)
      const maxSeq = entries[entries.length - 1].seq
      if (maxSeq > this.counter) this.counter = maxSeq

      for (const entry of entries) {
        this._addPromise()
        const resolve = this.pendingResolvers.shift()
        resolve({ command: entry.command, key: entry.key })
      }
      log.info(`Restored ${entries.length} pending command(s) from persistent queue`)
    }
  }

  /** @private */
  _addPromise () {
    this.pendingPromises.push(new Promise(resolve => {
      this.pendingResolvers.push(resolve)
    }))
  }

  /**
   * Add a command to the end of the queue.
   * @param {Array} command - Function call as array: [functionName, ...params] or [callback]
   */
  async enqueue (command) {
    await this._ready
    const [functionName] = command

    let key = null
    if (typeof functionName !== 'function') {
      this.counter++
      key = formatKey(this.counter)
      await this.db.batch([
        { type: 'put', key, value: JSON.stringify(command) },
        { type: 'put', key: COUNTER_KEY, value: JSON.stringify(this.counter) }
      ])
    }

    if (!this.pendingResolvers.length) this._addPromise()
    const resolve = this.pendingResolvers.shift()
    resolve({ command, key })
  }

  /**
   * Remove and return the next command from the queue.
   * Blocks until a command is available.
   * @returns {Promise<{command: Array, key: string|null}>}
   */
  async dequeue () {
    await this._ready
    if (!this.pendingPromises.length) this._addPromise()
    return this.pendingPromises.shift()
  }

  /**
   * Acknowledge successful processing — remove the entry from the database.
   * @param {string|null} key - The database key, or null for in-memory-only entries
   */
  async acknowledge (key) {
    if (key) {
      await this.db.del(key)
    }
  }

  /**
   * Put a failed command back at the front of the queue.
   * @param {Array} command
   * @param {string|null} key - The database key (entry stays in DB until acknowledged)
   */
  requeue (command, key) {
    if (!this.pendingPromises.length) {
      this._addPromise()
    } else {
      this.pendingPromises.unshift(new Promise(resolve => {
        this.pendingResolvers.unshift(resolve)
      }))
    }
    this.pendingResolvers.shift()({ command, key })
  }

  isEmpty () {
    return !this.pendingPromises.length
  }

  isBlocked () {
    return !!this.pendingResolvers.length
  }

  get length () {
    return this.pendingPromises.length - this.pendingResolvers.length
  }
}

export { FIFO }
