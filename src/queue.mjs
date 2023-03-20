class FIFO {
  /*
    Dequeue will create a promise that enqueue/requeue will resolve.
    Credits to https://stackoverflow.com/questions/47157428/how-to-implement-a-pseudo-blocking-async-queue-in-js-ts/47157577#47157577
  */
  constructor() {
    this.resolvingFunctions = []
    this.promises = []
  }

  _add() {
    this.promises.push(new Promise(resolve => {
      this.resolvingFunctions.push(resolve)
    }))
  }

  enqueue(t) {
    if (!this.resolvingFunctions.length) this._add()
    // give me the heading resolving function, I'll call (resolve) it with parameter 't'

    const resolve = this.resolvingFunctions.shift()
    resolve(t)
  }

  dequeue() {
    if (!this.promises.length) this._add()
    return this.promises.shift()
  }

  requeue(t) {
    if (!this.promises.length) {
      this._add()
    } else {
      this.promises.unshift(new Promise(resolve => {
        this.resolvingFunctions.unshift(resolve)
      }))
    }
    this.resolvingFunctions.shift()(t)
  }
  
  isEmpty() {
    return !this.promises.length
  }

  isBlocked() {
    return !!this.resolvingFunctions.length
  }

  get length() {
    return this.promises.length - this.resolvingFunctions.length
  }

  [Symbol.asyncIterator]() {
    return {
      next: async () => {
        const value = await this.dequeue()
        return { done: false, value}
      },
      [Symbol.asyncIterator]() { return this }
    }
  }
}

export {
  FIFO
}