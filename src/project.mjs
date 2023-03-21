
import { Base64 } from 'js-base64'

const ODINv2_MESSAGE_TYPE = 'io.syncpoint.odin.operation'

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
Project.prototype.hydrate = async function ({ projectId, matrixSpaceId }) {
  const hierarchy = await this.structureAPI.project(matrixSpaceId)
  if (!hierarchy) return

  this.projectId = projectId
  this.wellKnown.remember(projectId, matrixSpaceId)
  Object.values(hierarchy.layers).forEach(layer => {
    this.wellKnown.remember(layer.room_id, layer.id)
  })
  
  const projectStructure = {
    id: projectId,
    name: hierarchy.name,
    topic: hierarchy.topic,
    layers: Object.values(hierarchy.layers).map(layer => ({
      id: layer.id,
      name: layer.name,
      topic: layer.topic
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
  // 
  const upstreamId = this.wellKnown.get(layerId) || layerId
  await this.structureAPI.join(upstreamId)
}

Project.prototype.leaveLayer = async function (layerId) {

}

Project.prototype.setLayerName = async function (layerId, name) {
  const upstreamId = this.wellKnown.get(layerId)
  return this.structureAPI.setName(upstreamId, name)
}

Project.prototype.post = async function (layerId, operations) {
  // TODO: operations need to get splitted if the max. size of approximately 60k per message is reached

  const encode = operations => `data:application/json;base64,${Base64.encode(JSON.stringify(operations))}`
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
      'm.room.create',
      'm.room.name',
      'm.space.child',
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
          // types: EVENT_TYPES, 
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

  const isChildAdded = events => events.some(event => event.type === 'm.space.child')




  this.stream = this.timelineAPI.stream(streamToken, filterProvider)
  for await (const chunk of this.stream) {

    console.dir(chunk, { depth: 5 })
    if (Object.keys(chunk.events).length === 0) continue

    /* 
      If a chunk for a room contains a m.space.child event
      we need to request the details for each child.
      m.space.child can only be received for the project (space) itself
    */

    Object.entries(chunk.events).forEach(async ([roomId, content]) => {
      if (isChildAdded(content)) {
        const childEvent = content.find(event => event.type === 'm.space.child' )
        console.dir(childEvent.state_key)
        const p = await this.structureAPI.project(roomId)
        console.dir(p)
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
