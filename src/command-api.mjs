import { FIFO } from './queue.mjs'
import { getLogger } from './logger.mjs'

class CommandAPI {
  /**
   * @param {import('./http-api.mjs').HttpAPI} httpAPI
   * @param {import('./room-members.mjs').RoomMemberCache} memberCache
   * @param {Object} [options={}]
   * @param {Function} [options.encryptEvent] - async (roomId, eventType, content, memberIds) => encryptedContent
   * @param {Object} [options.db] - A levelup-compatible database instance for persistent queue storage
   */
  constructor (httpAPI, memberCache, options = {}) {
    this.httpAPI = httpAPI
    this.memberCache = memberCache
    this.encryptEvent = options.encryptEvent || null
    this.scheduledCalls = new FIFO(options.db)
  }

  /**
   * @param {FunctionCall} functionCall
   * @description A functionCall is an array of parameters. The first is the name of the function that will be called.
   * All other params (0..n) must meet the signature of that function.
   *
   * There is no way to retrieve the returning result of that function.
   */
  schedule (functionCall) {
    const [functionName] = functionCall
    // Allow scheduling async callback functions directly
    if (typeof functionName === 'function') {
      this.scheduledCalls.enqueue(functionCall)
      return
    }
    if (!this.httpAPI[functionName]) throw new Error(`HttpAPI: property ${functionName} does not exist`)
    if (typeof this.httpAPI[functionName] !== 'function') throw new Error(`HttpAPI: ${functionName} is not a function`)
    this.scheduledCalls.enqueue(functionCall)
  }


  async run () {

      /**
   * @param {Number} retryCounter
   * @returns A promise that resolves after a calculated time depending on the retryCounter using an exponential back-off algorithm. The max. delay is 30s.
   */
    const chill = retryCounter => new Promise(resolve => {
      const BACKOFF_FACTOR = 0.5
      const BACKOFF_LIMIT = 30_000
      const delay = Math.min(BACKOFF_LIMIT, (retryCounter === 0 ? 0 : BACKOFF_FACTOR * (2 ** (retryCounter)) * 1000))
      setTimeout(() => {
        resolve()
      }, delay)
    })

    if (this.controller) return
    this.controller = new AbortController()

    const log = getLogger()
    let retryCounter = 0
    let entry

    while (!this.controller.signal.aborted) {
      try {
        await chill(retryCounter)

        entry = await this.scheduledCalls.dequeue()
        const { command: functionCall, key } = entry
        let [functionName, ...params] = functionCall

        // Execute callback functions scheduled in the queue
        if (typeof functionName === 'function') {
          await functionName(...params)
          retryCounter = 0
          continue
        }

        // Encrypt outgoing message events if crypto is available
        if (this.encryptEvent && functionName === 'sendMessageEvent') {
          const [roomId, eventType, content, ...rest] = params
          try {
            const memberIds = await this.memberCache.getMembers(roomId)
            const encrypted = await this.encryptEvent(roomId, eventType, content, memberIds)
            params = [roomId, 'm.room.encrypted', encrypted, ...rest]
          } catch (encryptError) {
            log.warn('Encryption failed, sending unencrypted:', encryptError.message)
          }
        }

        await this.httpAPI[functionName].apply(this.httpAPI, params)
        await this.scheduledCalls.acknowledge(key)
        log.debug('Command sent:', functionName)
        retryCounter = 0
      } catch (error) {
        log.warn('Command failed:', error.message)
        if (error.response?.statusCode === 403) {
          log.error('Command forbidden:', entry.command[0], error.response.body)
        }

        /*
          In most cases we will have to deal with socket errors. The users computer may
          be offline or the server might be unreachable.
        */
        this.scheduledCalls.requeue(entry.command, entry.key)
        retryCounter++
      }
    }
  }

  async stop () {
    this.controller?.abort()
    delete this.controller
  }
}

export {
  CommandAPI
}
