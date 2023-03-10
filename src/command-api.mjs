import { FIFO } from './queue.mjs'

class CommandAPI {
  constructor (httpAPI, retryInterval = 30000) {
    this.httpAPI = httpAPI
    this.retryInterval = retryInterval
    this.scheduledCalls = new FIFO()
    this.execute()
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

  async execute () {
    let functionCall
    try {
      functionCall = await this.scheduledCalls.dequeue()
      const [functionName, ...params] = functionCall
      await this.httpAPI[functionName].apply(this.httpAPI, params)
      setImmediate(() => this.execute())
      console.log(`Called ${functionName}`)
    } catch (error) {
      if (error.response?.statusCode === 403) {
        console.error(`Calling ${functionCall[0]} is forbidden: ${error.response.body}`)
        return setImmediate(() => this.execute())
      }
      
      console.log(`Error: ${error.message}`)
      this.scheduledCalls.requeue(functionCall)
      setTimeout(() => this.execute(), this.retryInterval)
    }
  }
}

export {
  CommandAPI
}