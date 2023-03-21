
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
 */Project.prototype.hydrate = async function ({ projectId, matrixSpaceId }) {
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
  const upstreamId = this.wellKnown.get(layerId)
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
    const EVENT_TYPES = [   
      'm.room.name',
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

  this.stream = this.timelineAPI.stream(streamToken, filterProvider)
  for await (const chunk of this.stream) {
    console.dir(chunk, { depth: 5 })
  }

}

Project.prototype.stop = async function () {
  await this.stream?.return()
  delete this.stream
}

export {
  Project
}
