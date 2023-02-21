import { EventEmitter } from 'node:events'

class Store extends EventEmitter {
  constructor (initialstate) {
    super()
    this.innerState = initialstate
    this.controller = new AbortController()
  }

  getState () { return {...this.innerState} }
  setStreamToken (value, silent = false) { 
    console.log(`STORE: setStreamToken ${value}`)
    this.innerState.streamToken = value
    if (silent) return
    this.emit('streamToken', value)
  }
  
  setFilter (value, silent = false) {
    console.log(`STORE: setFilter ${value}`)
    this.innerState.filter = value
    if (silent) return
    this.emit('filter', value)
  }

  setTimeout (value, silent = false) {
    console.log(`STORE: setTimeout ${value}`)
    this.innerState.timeout = value
    if (silent) return
    this.emit('timeout', value)
  }

  setDelay (value, silent = false) {
    console.log(`STORE: setDelay ${value}`)
    this.innerState.delay = value
    if (silent) return
    this.emit('delay', value)
  }

}

export { Store }