import { FIFO } from './queue.mjs'

class CommandAPI {
  constructor (httpAPI) {
    this.httpAPI = httpAPI
    this.scheduledCalls = new FIFO()
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
    
    let retryCounter = 0
    let functionCall

    while (!this.controller.signal.aborted) {
      try {
        await chill(retryCounter)

        functionCall = await this.scheduledCalls.dequeue()
        const [functionName, ...params] = functionCall        
        await this.httpAPI[functionName].apply(this.httpAPI, params)
        console.log('SUCCESS', functionName, params)
        retryCounter = 0
      } catch (error) {
        console.log('ERROR', error.message)
        if (error.response?.statusCode === 403) {
          console.error(`Calling ${functionCall[0]} is forbidden: ${error.response.body}`)
        }
        
        /*
          In most cases we will have to deal with socket errors. The users computer may
          be offline or the server might be unreachable.
        */
        console.log(`Error: ${error.message}`)
        this.scheduledCalls.requeue(functionCall)
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