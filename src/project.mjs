
import { Base64 } from 'js-base64'
import { wrap } from './convenience.mjs'

const ODINv2_MESSAGE_TYPE = 'io.syncpoint.odin.operation'
const M_SPACE_CHILD = 'm.space.child'
const M_ROOM_NAME = 'm.room.name'

/**
 * 
 * @param {Object} apis
 * @property {StructureAPI} structureAPI
 */
const Project = function ({ structureAPI, timelineAPI, commandAPI }) {
  this.structureAPI = structureAPI
  this.timelineAPI = timelineAPI
  this.commandAPI = commandAPI

  this.wellKnown = new Map()
  this.wellKnown.remember = function (upstream, downstream) {
    this.set(upstream, downstream)
    this.set(downstream, upstream)
  }
  this.wellKnown.forget = function (key) {
    this.set.delete(key)
  }
  this.commandAPI.run()
}

/**
 * @description 
 * @typedef {Object} ProjectStructure
 * @property {string} id - project id
 * @property {string} name - project name
 * @property {string} topic - project topic
 * @property {Object[]} layers
 * @property {string} layers[].id
 * @property {string} layers[].name
 * @property {string} layers[].topic
 */


/**
 * @description Retrieves the project hierarchy from the Matrix server and fills the
 * wellKnown mapping between ODIN and Matrix IDs.
 * @param {*} param0 
 * @returns {ProjectStructure}
 */
Project.prototype.hydrate = async function ({ id, upstreamId }) {
  const hierarchy = await this.structureAPI.project(upstreamId)
  if (!hierarchy) return

  this.projectId = id
  this.wellKnown.remember(id, upstreamId)
  Object.values(hierarchy.layers).forEach(layer => {
    this.wellKnown.remember(layer.room_id, layer.id)
  })
  
  const projectStructure = {
    id,
    name: hierarchy.name,
    topic: hierarchy.topic,
    layers: Object.values(hierarchy.layers).map(layer => ({
      id: layer.id,
      name: layer.name,
      topic: layer.topic
    })),
    invitations: hierarchy.candidates.map(candidate => ({
      id: Base64.encode(candidate.id),
      name: candidate.name,
      topic: candidate.topic
    }))
  }

  return projectStructure
}

Project.prototype.shareLayer = async function (layerId, name, description) {
  const layer = await this.structureAPI.createLayer(layerId, name, description)
  await this.structureAPI.addLayerToProject(this.wellKnown.get(this.projectId), layer.globalId)
  this.wellKnown.remember(layerId, layer.globalId)
}

Project.prototype.joinLayer = async function (layerId) {
  
  const upstreamId = this.wellKnown.get(layerId) || (Base64.isValid(layerId) ? Base64.decode(layerId) : layerId)
  
  await this.structureAPI.join(upstreamId)
  /*
    It takes a while to propagate the "join" information. 
    Maybe it's better to handle this in the timeline/stream api??
  */
  const room = await this.structureAPI.getLayer(upstreamId)  
  this.wellKnown.remember(room.id, room.room_id)
  return room
}

Project.prototype.leaveLayer = async function (layerId) {
  const upstreamId = this.wellKnown.get(layerId)
  await this.structureAPI.leave(upstreamId)
  this.wellKnown.forget(layerId)
  this.wellKnown.forget(upstreamId)
}

Project.prototype.setLayerName = async function (layerId, name) {
  const upstreamId = this.wellKnown.get(layerId)
  return this.structureAPI.setName(upstreamId, name)
}

Project.prototype.post = async function (layerId, operations) {
  // TODO: operations need to get splitted if the max. size of approximately 60k per message is reached

  const encode = operations => Base64.encode(JSON.stringify(operations))
  const content = encode(operations)
  const upstreamId = this.wellKnown.get(layerId)
  this.commandAPI.schedule(['sendMessageEvent', upstreamId, ODINv2_MESSAGE_TYPE, { content }])
}

Project.prototype.start = async function (streamToken, handler = {}) {

  const filterProvider = () => {

    /*
      Within a project we are only interested in
        * a new layer has been added to the project >> m.space.child
        * an existing layer has been renamed >> m.room.name
        * a payload message has been posted in the layer >> io.syncpoint.odin.operation  
    */
    const EVENT_TYPES = [
      M_ROOM_NAME,
      M_SPACE_CHILD,
      ODINv2_MESSAGE_TYPE
    ]

    const filter = { 
      account_data: {
        not_types:  [ '*' ]
      },
      room: {
        timeline: { 
          lazy_load_members: true, // improve performance
          limit: 1000, 
          types: EVENT_TYPES, 
          not_senders: [ this.timelineAPI.credentials().user_id ], // NO events if the current user is the sender
          rooms: Array.from(this.wellKnown.keys()).filter(key => key.startsWith('!'))
        },
        ephemeral: {
          not_types: [ '*' ]
        }
      }
    }
    
    return filter
  }

  const isChildAdded = events => events.some(event => event.type === M_SPACE_CHILD)
  const isLayerRenamed = events => events.some(event => event.type === M_ROOM_NAME)
  const isODINOperation = events => events.some(event => event.type === ODINv2_MESSAGE_TYPE)


  const streamHandler = wrap(handler)
  this.stream = this.timelineAPI.stream(streamToken, filterProvider)
  for await (const chunk of this.stream) {
 
    if (chunk instanceof Error) {
      await streamHandler.error(chunk)
      continue
    }

    /* 
      Just store the next batch value no matter if we will process the stream any further.
      If any of the following functions runs into an error the erroneous chunk
      will get skipped during the next streamToken updated.
    */
    await streamHandler.streamToken(chunk.next_batch)

    if (Object.keys(chunk.events).length === 0) continue

    Object.entries(chunk.events).forEach(async ([roomId, content]) => {
      if (isChildAdded(content)) {
        /* 
          If a chunk for a room contains a m.space.child event
          we need to request the details for each child.
          m.space.child can only be received for the project (space) itself
        */
        const childEvent = content.find(event => event.type === M_SPACE_CHILD )
        const project = await this.structureAPI.project(roomId)
        const childRoom = project.candidates.find(room => room.id === childEvent.state_key)
        if (!childRoom) {
          console.warn('Received m.space.child event but did not find new child room')
          return
        }
        
        await streamHandler.invited({
          id: Base64.encode(childRoom.id),
          name: childRoom.name,
          topic: childRoom.topic
        })
      } 
      
      if (isLayerRenamed(content)) {
        console.dir(content)
        const renamed = content
          .filter(event => event.type === M_ROOM_NAME)
          .map(event => ({
            id: this.wellKnown.get(roomId),
            name: event.content.name
          }))
        
        await streamHandler.renamed(renamed)  
      } 
      
      if (isODINOperation(content)) {
        const operations = content
          .filter(event => event.type === ODINv2_MESSAGE_TYPE)
          .map(event => JSON.parse(Base64.decode(event.content.content)))
  
        await streamHandler.received(operations)
      }     
    })
  }

}

Project.prototype.stop = async function () {
  await this.stream?.return()
  delete this.stream
}

export {
  Project
}
