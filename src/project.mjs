
import { Base64 } from 'js-base64'
import { wrap } from './convenience.mjs'
import * as power from './powerlevel.mjs'
import { ROOM_TYPE } from './shared.mjs'

const ODINv2_MESSAGE_TYPE = 'io.syncpoint.odin.operation'
const ODINv2_EXTENSION_MESSAGE_TYPE = 'io.syncpoint.odin.extension'
const M_SPACE_CHILD = 'm.space.child'
const M_ROOM_NAME = 'm.room.name'
const M_ROOM_POWER_LEVELS = 'm.room.power_levels'
const M_ROOM_MEMBER = 'm.room.member'

/*  The max. event size for a matrix event is 64k
    see https://spec.matrix.org/v1.6/client-server-api/#size-limits
    We limit our own content to chunks of max 56k
*/
const MAX_MESSAGE_SIZE = 56 * 1024

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
    this.delete(key)
  }
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

  this.commandAPI.run()

  this.projectId = id
  this.wellKnown.remember(id, upstreamId)
  Object.values(hierarchy.layers).forEach(layer => {
    this.wellKnown.remember(layer.room_id, layer.id)
  })
  Object.values(hierarchy.wellknown).forEach(wellknownRoom => {
    this.wellKnown.remember(wellknownRoom.room_id, wellknownRoom.id)
  })

  const projectStructure = {
    id,
    name: hierarchy.name,
    role: {
      self: hierarchy.powerlevel.self.name,
      default: hierarchy.powerlevel.default.name
    },
    topic: hierarchy.topic,
    layers: Object.values(hierarchy.layers).map(layer => ({
      creator: layer.creator,
      id: layer.id,
      name: layer.name,
      role: {
        self: layer.powerlevel.self.name,
        default: layer.powerlevel.default.name
      },
      topic: layer.topic      
    })),
    wellknownRooms: Object.values(hierarchy.wellknown).map(wellknownRoom => ({
      creator: wellknownRoom.creator,
      id: wellknownRoom.id,
      name: wellknownRoom.name      
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
  if (this.wellKnown.get(layerId)) {
    /* layer is already shared */
    return
  }
  const layer = await this.structureAPI.createLayer(layerId, name, description)
  
  await this.structureAPI.addLayerToProject(this.wellKnown.get(this.projectId), layer.globalId)
  this.wellKnown.remember(layerId, layer.globalId)

  return {
    id: layerId,
    upstreamId: layer.globalId,
    role: {
      self: layer.powerlevel.self.name,
      default: layer.powerlevel.default.name
    }
  }
}

Project.prototype.joinLayer = async function (layerId) {
  
  const upstreamId = this.wellKnown.get(layerId) || (Base64.isValid(layerId) ? Base64.decode(layerId) : layerId)
  
  await this.structureAPI.join(upstreamId)
  const room = await this.structureAPI.getLayer(upstreamId)  
  this.wellKnown.remember(room.id, room.room_id)
  const layer = {...room}
  layer.role = {
    self: room.powerlevel.self.name,
    default: room.powerlevel.default.name
  }
  delete layer.powerlevel
  return layer
}

Project.prototype.leaveLayer = async function (layerId) {
  const upstreamId = this.wellKnown.get(layerId)
  const layer = await this.structureAPI.getLayer(upstreamId)

  await this.structureAPI.leave(upstreamId)
  this.wellKnown.forget(layerId)
  this.wellKnown.forget(upstreamId)

  /* an invitation to re-join the layer */
  return {
    id: Base64.encode(upstreamId),
    name: layer.name,
    topic: layer.topic
  }
}

Project.prototype.setLayerName = async function (layerId, name) {
  const upstreamId = this.wellKnown.get(layerId)
  return this.structureAPI.setName(upstreamId, name)
}

Project.prototype.setDefaultRole = async function (layerId, role) {
  const upstreamId = this.wellKnown.get(layerId)
  const powerlevel = power.ROLES.LAYER[role]
  return this.structureAPI.setDefaultPowerlevel(upstreamId, powerlevel)
}

Project.prototype.roles = Object.fromEntries(Object.keys(power.ROLES.LAYER).map(k =>[k, k]))

Project.prototype.content = async function (layerId) {
  const filter = { 
      lazy_load_members: true, // improve performance
      limit: 1000, 
      types: [ODINv2_MESSAGE_TYPE],
      not_senders: [ this.timelineAPI.credentials().user_id ], // NO events if the current user is the sender
    }

  const upstreamId = this.wellKnown.get(layerId)
  const content = await this.timelineAPI.content(upstreamId, filter)
  const operations = content.events
    .map(event => 
      JSON.parse(Base64.decode(event.content.content))
    )
    .flat()
  return operations
}

Project.prototype.post = async function (layerId, operations) {
  this.__post(layerId, operations, ODINv2_MESSAGE_TYPE)
}

Project.prototype.postToAssembly = async function (operations) {
  this.__post(ROOM_TYPE.WELLKNOWN.ASSEMBLY.type, operations, ODINv2_EXTENSION_MESSAGE_TYPE)
}

Project.prototype.__post = async function (layerId, operations, messageType) {

  const split = ops => {
    const content = encode(ops)
    if (content.length <= MAX_MESSAGE_SIZE) return ops
    const half = Math.floor(ops.length / 2)
    const left = split(ops.slice(0, half))
    const right = split(ops.slice(half))
    return [left, right]
  }
  
  const collect = splittedOperations => {
    if (Array.isArray(splittedOperations[0]) === false) return [splittedOperations]
    return [...collect(splittedOperations[0]), ...collect(splittedOperations[1])]
  }

  const encode = operations => Base64.encode(JSON.stringify(operations))

  const chunks = split(operations)
  const parts = collect(chunks)

  const upstreamId = this.wellKnown.get(layerId)
  parts.forEach(part => this.commandAPI.schedule(['sendMessageEvent', upstreamId, messageType, { content: encode(part) }]))
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
      M_ROOM_POWER_LEVELS,
      M_SPACE_CHILD,
      M_ROOM_MEMBER,
      ODINv2_MESSAGE_TYPE,
      ODINv2_EXTENSION_MESSAGE_TYPE
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
  const isPowerlevelChanged = events => events.some(event => event.type === M_ROOM_POWER_LEVELS)
  const isMembershipChanged = events => events.some(event => event.type === M_ROOM_MEMBER)

  const isODINOperation = events => events.some(event => event.type === ODINv2_MESSAGE_TYPE)
  const isODINExtensionMessage = events => events.some(event => event.type === ODINv2_EXTENSION_MESSAGE_TYPE)


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
        const renamed = content
          .filter(event => event.type === M_ROOM_NAME)
          .map(event => (
            {
              id: this.wellKnown.get(roomId),
              name: event.content.name
            }
          ))
        
        await streamHandler.renamed(renamed)  
      } 

      if (isPowerlevelChanged(content)) {
        const role = content
          .filter(event => event.type === M_ROOM_POWER_LEVELS)
          .map(event => {
            const powerlevel = power.powerlevel(this.timelineAPI.credentials().user_id, event.content)
            return {
              id: this.wellKnown.get(roomId),
              role: {
                self: powerlevel.self.name,
                default: powerlevel.default.name 
              }
            }           
          })
        await streamHandler.roleChanged(role)
      }

      if (isMembershipChanged(content)) {
        const membership = content
          .filter(event => event.type === M_ROOM_MEMBER)
          .map(event => ({
            id: this.wellKnown.get(roomId),
            membership: event.content.membership,
            subject: event.state_key
          }))
        await streamHandler.membershipChanged(membership)
      }

      if (isODINExtensionMessage(content)) {
        const message = content
          .filter(event => event.type === ODINv2_EXTENSION_MESSAGE_TYPE)
          .map(event => JSON.parse(Base64.decode(event.content.content)))
          .flat()        
          
        await streamHandler.receivedExtension({
          id: this.wellKnown.get(roomId),
          message
        })
      }
      
      if (isODINOperation(content)) {
        const operations = content
          .filter(event => event.type === ODINv2_MESSAGE_TYPE)
          .map(event => JSON.parse(Base64.decode(event.content.content)))
          .flat()
  
        await streamHandler.received({
          id: this.wellKnown.get(roomId),
          operations
        }
        )
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
