/**
 * In-memory cache for room membership.
 * Event-driven: updated by sync stream membership events, not by polling.
 */
class RoomMemberCache {
  constructor () {
    this.rooms = new Map()
  }

  /**
   * Set the full member list for a room (initial population).
   * @param {string} roomId
   * @param {string[]} memberIds
   */
  set (roomId, memberIds) {
    this.rooms.set(roomId, new Set(memberIds))
  }

  /**
   * Get cached member IDs for a room.
   * @param {string} roomId
   * @returns {string[]|null} Member IDs or null if room is not cached
   */
  get (roomId) {
    const members = this.rooms.get(roomId)
    return members ? Array.from(members) : null
  }

  /**
   * Add a member to a room (on join event).
   * @param {string} roomId
   * @param {string} userId
   */
  addMember (roomId, userId) {
    let members = this.rooms.get(roomId)
    if (!members) {
      members = new Set()
      this.rooms.set(roomId, members)
    }
    members.add(userId)
  }

  /**
   * Remove a member from a room (on leave/kick/ban event).
   * @param {string} roomId
   * @param {string} userId
   */
  removeMember (roomId, userId) {
    const members = this.rooms.get(roomId)
    if (members) members.delete(userId)
  }

  /**
   * Whether a room has cached membership data.
   * @param {string} roomId
   * @returns {boolean}
   */
  has (roomId) {
    return this.rooms.has(roomId)
  }

  /**
   * Remove a room from the cache (on leave).
   * @param {string} roomId
   */
  remove (roomId) {
    this.rooms.delete(roomId)
  }
}

export { RoomMemberCache }
