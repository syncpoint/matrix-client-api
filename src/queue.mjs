class FIFO {
  constructor () {
    this.items = []
  }

  enqueue (item) {
    // inserts item at the end of the items array
    this.items.push(item)
    if (this.controller) {
      this.controller.abort()
      this.controller = undefined
    }
    
  }

  dequeue() {
    // removes the first element of the items array 
    const next = this.items.shift()
    if (next) { 
      return Promise.resolve(next)
    }
    this.controller = new AbortController()
    return new Promise((resolve) => {
      const handler = () => {
        this.controller.signal.removeEventListener('abort', handler)
        resolve(this.items.shift())
      }
      this.controller.signal.addEventListener('abort', handler)
    })
  }

  requeue (item) {
    this.items = this.items.concat([item], this.items)
  }

  get lenght () {
    return this.items.length
  }
}

export {
  FIFO
}