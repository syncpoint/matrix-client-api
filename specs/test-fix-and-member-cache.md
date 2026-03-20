# Task: Fix E2E Tests + Room Member Cache

## Part 1: Fix E2E Tests

All E2E tests fail because they use the OLD API signatures that were changed in the crypto-facade refactoring.

### What changed in the refactoring

1. **`HttpAPI.processOutgoingCryptoRequests(cryptoManager)` was REMOVED** — this method moved into `CryptoFacade`
2. **`CommandAPI` constructor changed**: old `(httpAPI, cryptoManager, db)` → new `(httpAPI, options = {})` where options has `encryptEvent` and `db`
3. **`TimelineAPI` constructor changed**: old `(httpAPI, { cryptoManager, httpAPI })` → new `(httpAPI, options = {})` where options has `onSyncResponse` and `decryptEvent` callbacks
4. **`Project` constructor changed**: old `cryptoManager` param → new `crypto = {}` with `isEnabled`, `registerRoom`, `shareHistoricalKeys`

### How to fix each test file

The tests use CryptoManager directly for low-level crypto operations (which is fine — CryptoManager is still exported).
The problem is they also call methods/constructors that changed.

**For ALL tests that call `httpAPI.processOutgoingCryptoRequests(crypto)`:**
Import `CryptoFacade` from `../src/crypto-facade.mjs` and use `facade.processOutgoingRequests()` instead.
Or, since these tests are low-level integration tests that test the crypto flow directly, create a small helper:

```javascript
import { CryptoFacade } from '../src/crypto-facade.mjs'

// Helper to replace the removed httpAPI.processOutgoingCryptoRequests()
async function processOutgoingRequests (httpAPI, crypto) {
  const facade = new CryptoFacade(crypto, httpAPI)
  await facade.processOutgoingRequests()
}
```

Or even simpler — just inline the logic since it's trivial:
```javascript
async function processOutgoingRequests (httpAPI, crypto) {
  const requests = await crypto.outgoingRequests()
  for (const request of requests) {
    const response = await httpAPI.sendOutgoingCryptoRequest(request)
    await crypto.markRequestAsSent(request.id, request.type, response)
  }
}
```

This is actually **cleaner** because the tests don't need to know about CryptoFacade at all.

**For tests that use `new CommandAPI(httpAPI, crypto, db)`:**
Change to: `new CommandAPI(httpAPI, { db })` (no encryptEvent needed for most tests that encrypt manually)
OR if the test relies on CommandAPI auto-encrypting: `new CommandAPI(httpAPI, { encryptEvent: (roomId, type, content, memberIds) => facade.encryptEvent(roomId, type, content, memberIds), db })`

**For tests that use `new TimelineAPI(httpAPI, { cryptoManager: crypto, httpAPI })`:**
Change to: `new TimelineAPI(httpAPI, { onSyncResponse: (data) => facade.processSyncResponse(data), decryptEvent: (event, roomId) => facade.decryptEvent(event, roomId) })`

### Files to fix

1. **`test-e2e/content-after-join-high-level.test.mjs`** — `CommandAPI(httpAPI, null, db)` → `CommandAPI(httpAPI, { db })`
2. **`test-e2e/content-after-join.test.mjs`** — `processOutgoingCryptoRequests`, `CommandAPI`, `TimelineAPI` signatures
3. **`test-e2e/matrix-client-api.test.mjs`** — same as above
4. **`test-e2e/sas-verification.test.mjs`** — `processOutgoingCryptoRequests` only (no CommandAPI/TimelineAPI)
5. **`test-e2e/sync-gated-content.test.mjs`** — `processOutgoingCryptoRequests`, `TimelineAPI` signature
6. **`test-e2e/e2ee.test.mjs`** — passes already (only uses CryptoManager directly), DO NOT TOUCH
7. **`test-e2e/project-join-content.test.mjs`** — test #4 fails with assertion error, may need separate investigation. Uses the high-level MatrixClient API, so it should work already. Check if it's a pre-existing issue.

### Important: Do NOT change test logic!
Only update constructor calls and method calls to match the new API.
The test assertions and flow must stay exactly the same.

---

## Part 2: Room Member Cache

### New file: `src/room-members.mjs`

```javascript
/**
 * In-memory cache for room membership.
 * Event-driven: updated by sync stream membership events, not by polling.
 */
class RoomMemberCache {
  constructor () {
    this.rooms = new Map()  // Map<roomId, Set<userId>>
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
```

### Changes to `Project`

1. **Constructor**: Accept `memberCache` in the options
2. **`hydrate()`**: After loading the hierarchy, populate the cache for each layer
3. **`joinLayer()`**: After join, populate the cache for the new room
4. **`start()` → `isMembershipChanged` handler**: Update cache on join/leave events
5. **`leaveLayer()`**: Remove room from cache
6. **`shareHistoricalKeys()`**: Read member IDs from cache instead of `httpAPI.members()`

### Changes to `CommandAPI`

1. **Constructor options**: Add `getMemberIds: async (roomId) => string[]`
2. **`run()`**: Use `this.getMemberIds(roomId)` instead of `this.httpAPI.members(roomId)` + filter chain. The callback should fall back to HTTP when cache is empty.

### Changes to `index.mjs`

Wire the cache:

```javascript
const memberCache = new RoomMemberCache()

// getMemberIds with HTTP fallback
const getMemberIds = async (roomId) => {
  const cached = memberCache.get(roomId)
  if (cached) return cached
  // Fallback: fetch from server (first message before cache is populated)
  const members = await httpAPI.members(roomId)
  const ids = (members.chunk || [])
    .filter(e => e.content?.membership === 'join')
    .map(e => e.state_key)
    .filter(Boolean)
  memberCache.set(roomId, ids)
  return ids
}

const commandAPI = new CommandAPI(httpAPI, {
  encryptEvent: facade ? (...) => facade.encryptEvent(...) : null,
  getMemberIds,
  db: loginData.db
})

const project = new Project({
  structureAPI, timelineAPI, commandAPI,
  memberCache,
  crypto: ...
})
```

### Population in `Project.hydrate()`

After loading the hierarchy, for each layer room, fetch its members and cache them:

```javascript
// After layer registration, populate member cache
if (this.memberCache) {
  const allRoomIds = [upstreamId, ...Object.keys(hierarchy.layers)]
  for (const roomId of allRoomIds) {
    const members = await this.commandAPI.httpAPI.members(roomId)
    const memberIds = (members.chunk || [])
      .filter(e => e.content?.membership === 'join')
      .map(e => e.state_key)
      .filter(Boolean)
    this.memberCache.set(roomId, memberIds)
  }
}
```

### Update in `Project.start()` membership handler

```javascript
if (isMembershipChanged(content)) {
  // ... existing code ...

  // Update member cache
  if (this.memberCache) {
    for (const event of content.filter(e => e.type === M_ROOM_MEMBER)) {
      if (event.content.membership === 'join') {
        this.memberCache.addMember(roomId, event.state_key)
      } else if (['leave', 'ban'].includes(event.content.membership)) {
        this.memberCache.removeMember(roomId, event.state_key)
      }
    }
  }
}
```

### Implementation Order

1. Fix all E2E tests first (Part 1)
2. Run tests — they should all pass
3. Implement `src/room-members.mjs`
4. Update `CommandAPI` (getMemberIds callback)
5. Update `Project` (cache population + updates)
6. Update `index.mjs` (wiring)
7. Run `npx eslint src/` — fix issues
8. Run E2E tests again
9. Commit Part 1: "fix: update E2E tests for crypto-facade API changes"
10. Commit Part 2: "feat: room member cache to avoid per-message HTTP lookups"
