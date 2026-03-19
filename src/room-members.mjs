/**
 * In-memory cache for room membership.
 *
 * Self-sufficient: fetches members from the server on cache miss via the
 * provided fetch callback. Updated by sync stream membership events.
 *
 * @param {Function} fetchMembers - async (roomId) => string[] — fetches joined member IDs from the server
 */
class RoomMemberCache {
  constructor (fetchMembers) {
    this.rooms = new Map()
    this.fetchMembers = fetchMembers
  }

  /**
   * Get member IDs for a room. Fetches from server on cache miss.
   * On network failure, returns the existing cached members (possibly empty).
   * @param {string} roomId
   * @returns {Promise<string[]>}
   */
  async getMembers (roomId) {
    try {
      const memberIds = await this.fetchMembers(roomId)
      this.rooms.set(roomId, new Set(memberIds))
      return memberIds
    } catch {
      const cached = this.rooms.get(roomId)
      return cached ? Array.from(cached) : []
    }
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
   * Discard a room entirely (on leave).
   * @param {string} roomId
   */
  remove (roomId) {
    this.rooms.delete(roomId)
  }
}

export { RoomMemberCache }
