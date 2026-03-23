
import { Base64 } from 'js-base64'
import { getLogger } from './logger.mjs'
import { wrap } from './convenience.mjs'
import * as power from './powerlevel.mjs'
const ODINv2_MESSAGE_TYPE = 'io.syncpoint.odin.operation'
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
const Project = function ({ structureAPI, timelineAPI, commandAPI, memberCache, crypto = {} }) {
  this.structureAPI = structureAPI
  this.timelineAPI = timelineAPI
  this.commandAPI = commandAPI
  this.memberCache = memberCache
  this.crypto = crypto

  this.idMapping = new Map()
  this.idMapping.remember = function (upstream, downstream) {
    this.set(upstream, downstream)
    this.set(downstream, upstream)
  }
  this.idMapping.forget = function (key) {
    this.delete(key)
  }

  // Rooms waiting for their first sync cycle before content is fetched.
  // joinLayer() adds entries, start() processes them when the room appears in sync.
  this.pendingContent = new Set()
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
  this.idMapping.remember(id, upstreamId)
  Object.values(hierarchy.layers).forEach(layer => {
    this.idMapping.remember(layer.room_id, layer.id)
  })
  // Register encrypted rooms
  if (this.crypto.isEnabled) {
    const allRooms = { ...hierarchy.layers }
    for (const [roomId, room] of Object.entries(allRooms)) {
      if (room.encryption) {
        await this.crypto.registerRoom(roomId)
      }
    }
    // Also check the space itself
    if (hierarchy.encryption) {
      await this.crypto.registerRoom(upstreamId)
    }
  }



  const projectStructure = {
    id,
    name: hierarchy.name,
    role: {
      self: hierarchy.powerlevel.self.name,
      default: hierarchy.powerlevel.default.name
    },
    topic: hierarchy.topic,
    layers: Object.values(hierarchy.layers).map(layer => ({
      sender: layer.sender,
      id: layer.id,
      name: layer.name,
      role: {
        self: layer.powerlevel.self.name,
        default: layer.powerlevel.default.name
      },
      topic: layer.topic
    })),
    invitations: hierarchy.candidates.map(candidate => ({
      id: Base64.encodeURI(candidate.id),
      name: candidate.name,
      topic: candidate.topic
    }))
  }

  return projectStructure
}

Project.prototype.shareLayer = async function (layerId, name, description, options = {}) {
  if (this.idMapping.get(layerId)) {
    /* layer is already shared */
    return
  }
  const layer = await this.structureAPI.createLayer(layerId, name, description, undefined, options)

  await this.structureAPI.addLayerToProject(this.idMapping.get(this.projectId), layer.globalId)
  this.idMapping.remember(layerId, layer.globalId)

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

  const upstreamId = this.idMapping.get(layerId) || (Base64.isValid(layerId) ? Base64.decode(layerId) : layerId)

  // 1. Add the upstream (Matrix) room ID to the filter BEFORE joining
  //    so the next sync poll includes it.
  this.idMapping.remember(upstreamId, upstreamId)
  this.pendingContent.add(upstreamId)

  // 2. Restart the sync long-poll and WAIT until the new iteration has
  //    applied the updated rooms filter. This ensures the sync request
  //    that includes the new room is already in flight before we join.
  await this.timelineAPI.restartSync()

  // 3. NOW perform the actual join — the sync poll already includes this room.
  await this.structureAPI.join(upstreamId)
  const room = await this.structureAPI.getLayer(upstreamId)

  // 4. Replace the temporary self-mapping with the real ODIN↔Matrix mapping.
  //    room.room_id === upstreamId, so pendingContent stays valid.
  this.idMapping.forget(upstreamId)
  this.idMapping.remember(room.id, room.room_id)

  // Register encryption if applicable (needed before content can be decrypted)
  if (this.crypto.isEnabled && room.encryption) {
    await this.crypto.registerRoom(room.room_id)
  }

  const layer = {...room}
  layer.role = {
    self: room.powerlevel.self.name,
    default: room.powerlevel.default.name
  }
  delete layer.powerlevel
  return layer
}

/**
 * Schedule sharing of all historical Megolm session keys for a layer
 * with all project members. The sharing is enqueued in the command queue
 * so it executes AFTER any pending content posts have been sent and
 * encrypted (ensuring the session keys actually exist).
 *
 * to_device messages are queued server-side, so offline recipients
 * get them on next sync.
 *
 * @param {string} layerId - the local layer id
 */
Project.prototype.shareHistoricalKeys = function (layerId) {
  if (!this.crypto.isEnabled) return
  const roomId = this.idMapping.get(layerId)
  if (!roomId) return
  this.commandAPI.schedule([async () => {
    const myUserId = this.timelineAPI.credentials().user_id
    const projectRoomId = this.idMapping.get(this.projectId)
    const allMembers = await this.memberCache.getMembers(projectRoomId)
    const userIds = allMembers.filter(id => id !== myUserId)

    if (userIds.length === 0) return
    await this.crypto.shareHistoricalKeys(roomId, userIds)
  }])
}

Project.prototype.leaveLayer = async function (layerId) {
  const upstreamId = this.idMapping.get(layerId)
  const layer = await this.structureAPI.getLayer(upstreamId)

  await this.structureAPI.leave(upstreamId)
  this.memberCache.remove(upstreamId)
  this.idMapping.forget(layerId)
  this.idMapping.forget(upstreamId)

  /* an invitation to re-join the layer */
  return {
    id: Base64.encodeURI(upstreamId),
    name: layer.name,
    topic: layer.topic
  }
}

Project.prototype.setLayerName = async function (layerId, name) {
  const upstreamId = this.idMapping.get(layerId)
  return this.structureAPI.setName(upstreamId, name)
}

Project.prototype.setDefaultRole = async function (layerId, role) {
  const upstreamId = this.idMapping.get(layerId)
  const powerlevel = power.ROLES.LAYER[role]
  return this.structureAPI.setDefaultPowerlevel(upstreamId, powerlevel)
}

Project.prototype.roles = Object.fromEntries(Object.keys(power.ROLES.LAYER).map(k =>[k, k]))

Project.prototype.content = async function (layerId) {
  const filter = {
      lazy_load_members: true, // improve performance
      limit: 1000,
      types: [ODINv2_MESSAGE_TYPE]
      // No not_senders filter: on (re-)join we need ALL events
      // including our own to reconstruct the full layer state.
    }

  const upstreamId = this.idMapping.get(layerId)
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

  const encode = operations => Base64.encodeURI(JSON.stringify(operations))

  const chunks = split(operations)
  const parts = collect(chunks)

  const upstreamId = this.idMapping.get(layerId)
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
          rooms: Array.from(this.idMapping.keys()).filter(key => key.startsWith('!'))
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

    // Sync-gated content fetch: for rooms that were recently joined,
    // wait until they appear in the sync response, then fetch full content.
    // The sync appearance is the server's signal that /messages will work reliably.
    // Check both timeline events and state events — the room may appear in sync
    // with only state (e.g. the join event) but no timeline events if the
    // server-side filter excludes the current user's events via not_senders.
    for (const roomId of this.pendingContent) {
      if (!chunk.events[roomId] && !chunk.stateEvents?.[roomId]) continue

      this.pendingContent.delete(roomId)
      const log = getLogger()
      log.info(`Sync-gated content fetch for room ${roomId}`)

      const layerId = this.idMapping.get(roomId)
      const operations = await this.content(layerId)

      log.info(`Sync-gated content: ${operations.length} operations for room ${roomId}`)

      if (operations.length > 0) {
        await streamHandler.received({ id: layerId, operations })
      }
    }

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
          getLogger().warn('Received m.space.child but child room not found')
          return
        }

        await streamHandler.invited({
          id: Base64.encodeURI(childRoom.id),
          name: childRoom.name,
          topic: childRoom.topic
        })
      }

      if (isLayerRenamed(content)) {
        const renamed = content
          .filter(event => event.type === M_ROOM_NAME)
          .map(event => (
            {
              id: this.idMapping.get(roomId),
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
              id: this.idMapping.get(roomId),
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
            id: this.idMapping.get(roomId),
            membership: event.content.membership,
            subject: event.state_key
          }))

        for (const change of membership) {
          if (change.membership === 'join') {
            this.memberCache.addMember(roomId, change.subject)
          } else if (change.membership === 'leave' || change.membership === 'ban') {
            this.memberCache.removeMember(roomId, change.subject)
          }
        }

        await streamHandler.membershipChanged(membership)

        // Safety net: share historical keys with newly joined members.
        // Primary key sharing happens at share/invite time (see shareLayer),
        // but this catches keys created between share and join.
        if (this.crypto.isEnabled) {
          const myUserId = this.timelineAPI.credentials().user_id
          const newJoinUserIds = membership
            .filter(m => m.membership === 'join' && m.subject !== myUserId)
            .map(m => m.subject)

          if (newJoinUserIds.length > 0) {
            await this.crypto.shareHistoricalKeys(roomId, newJoinUserIds)
          }
        }
      }

      if (isODINOperation(content)) {
        const operations = content
          .filter(event => event.type === ODINv2_MESSAGE_TYPE)
          .map(event => JSON.parse(Base64.decode(event.content.content)))
          .flat()

        await streamHandler.received({
          id: this.idMapping.get(roomId),
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
