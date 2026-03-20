# Crypto Facade Refactoring Spec

## Goal

Eliminate direct `CryptoManager` usage from `TimelineAPI`, `CommandAPI`, and `Project`.
Introduce a `CryptoFacade` that encapsulates all crypto orchestration in one place.
No API module should know that a `CryptoManager` exists.

## Motivation

Currently, the 7-step encrypt ceremony (trackUsers → queryKeys → claimSessions → shareRoomKey → encrypt → processOutgoing) is duplicated across `CommandAPI.run()` and `Project._shareHistoricalKeysWithProjectMembers()`. Every module directly calls `cryptoManager.decryptRoomEvent()`, `cryptoManager.receiveSyncChanges()`, `cryptoManager.setRoomEncryption()`, etc. This violates separation of concerns and makes the code fragile.

## Architecture

### New: `src/crypto-facade.mjs`

A facade that owns the `CryptoManager` and `HttpAPI` references and exposes high-level operations:

```javascript
class CryptoFacade {
  constructor(cryptoManager, httpAPI)

  // Feed sync response data into the OlmMachine and process outgoing requests
  async processSyncResponse({ toDeviceEvents, deviceLists, oneTimeKeyCounts, unusedFallbackKeys })

  // Decrypt a single room event. Returns the transformed event or null.
  async decryptEvent(event, roomId)

  // Register a room as encrypted
  async registerRoom(roomId, encryptionContent)

  // Full encrypt ceremony: track users, query keys, claim sessions, share room key, encrypt
  // The caller provides memberIds (fetched from the Matrix API).
  async encryptEvent(roomId, eventType, content, memberIds)

  // Share historical Megolm session keys with specific users
  // Handles: track → queryKeys → claimSessions → export → olm-encrypt → sendToDevice
  async shareHistoricalKeys(roomId, userIds)

  // Process all pending outgoing crypto requests
  async processOutgoingRequests()
}
```

**Key design decisions:**
- `encryptEvent()` receives `memberIds` as a parameter. The facade does NOT fetch members itself — that would mean reaching into the HTTP layer for room membership, which is the caller's responsibility.
- `shareHistoricalKeys()` is fully self-contained: it handles the complete flow including `sendToDevice`. The caller just says "share keys for this room with these users."
- `processOutgoingCryptoRequests()` moves from `HttpAPI` into the facade. `HttpAPI.sendOutgoingCryptoRequest()` stays in HttpAPI (it's a pure HTTP concern).

### Changes to `TimelineAPI`

**Before:**
```javascript
const TimelineAPI = function (httpApi, crypto) {
  this.crypto = crypto || null  // { cryptoManager, httpAPI }
}
```

**After:**
```javascript
const TimelineAPI = function (httpApi, options = {}) {
  this.onSyncResponse = options.onSyncResponse || null    // async (syncData) => void
  this.decryptEvent = options.decryptEvent || null          // async (event, roomId) => decryptedEvent | null
}
```

- In `syncTimeline()`: replace `this.crypto` block with `if (this.onSyncResponse) await this.onSyncResponse({...})`
- In `content()` and `syncTimeline()`: replace `cryptoManager.decryptRoomEvent()` calls with `this.decryptEvent(event, roomId)`
- The `augmentFilterForCrypto()` logic stays in TimelineAPI (it's a filter concern, not a crypto concern), but it triggers based on `this.decryptEvent` being set (i.e., crypto is active) rather than `this.crypto`.
- `applyPostDecryptTypeFilter()` stays as-is (pure filter logic).

### Changes to `CommandAPI`

**Before:**
```javascript
constructor(httpAPI, cryptoManager, db)
// 60 lines of encrypt ceremony in run()
```

**After:**
```javascript
constructor(httpAPI, options = {})
// options.encryptEvent: async (roomId, eventType, content) => encryptedContent
// options.db: levelup-compatible database
```

In `run()`, the entire crypto block (lines 73–130) becomes:
```javascript
if (this.encryptEvent && functionName === 'sendMessageEvent') {
  const [roomId, eventType, content, ...rest] = params
  try {
    const members = await this.httpAPI.members(roomId)
    const memberIds = (members.chunk || [])
      .filter(e => e.content?.membership === 'join')
      .map(e => e.state_key)
      .filter(Boolean)
    const encrypted = await this.encryptEvent(roomId, eventType, content, memberIds)
    params = [roomId, 'm.room.encrypted', encrypted, ...rest]
  } catch (encryptError) {
    log.warn('Encryption failed, sending unencrypted:', encryptError.message)
  }
}
```

Note: member fetching stays in CommandAPI because it's the only place that knows *when* to fetch members (at send time). The facade's `encryptEvent()` receives the memberIds.

### Changes to `Project`

**Before:**
```javascript
const Project = function ({ structureAPI, timelineAPI, commandAPI, cryptoManager })
// Direct cryptoManager calls everywhere
```

**After:**
```javascript
const Project = function ({ structureAPI, timelineAPI, commandAPI, crypto = {} })
// crypto.registerRoom: async (roomId, encryptionContent) => void
// crypto.shareHistoricalKeys: async (roomId, userIds) => void
// crypto.isEnabled: boolean
```

Changes:
- `this.cryptoManager` → `this.crypto` (the options object with callbacks)
- All `if (this.cryptoManager)` → `if (this.crypto.isEnabled)`
- `this.cryptoManager.setRoomEncryption(roomId, enc)` → `this.crypto.registerRoom(roomId, enc)`
- `this._shareHistoricalKeysWithProjectMembers(roomId, userIds)` → `this.crypto.shareHistoricalKeys(roomId, userIds)` — the entire 50-line method disappears
- `this.shareHistoricalKeys()` (the public method that schedules via commandAPI) uses the crypto callback too

### Changes to `index.mjs` (MatrixClient)

The MatrixClient factory is the **single composition root** where everything is wired:

```javascript
const getCrypto = async (httpAPI) => {
  if (!encryption?.enabled) return null
  // ... initialize CryptoManager as before ...
  return new CryptoFacade(cryptoManager, httpAPI)
}

// In project():
const facade = await getCrypto(httpAPI)
const timelineAPI = new TimelineAPI(httpAPI, facade ? {
  onSyncResponse: (data) => facade.processSyncResponse(data),
  decryptEvent: (event, roomId) => facade.decryptEvent(event, roomId)
} : {})

const commandAPI = new CommandAPI(httpAPI, {
  encryptEvent: facade
    ? (roomId, type, content, memberIds) => facade.encryptEvent(roomId, type, content, memberIds)
    : null,
  db: loginData.db
})

const project = new Project({
  structureAPI, timelineAPI, commandAPI,
  crypto: facade ? {
    isEnabled: true,
    registerRoom: (roomId, enc) => facade.registerRoom(roomId, enc),
    shareHistoricalKeys: (roomId, userIds) => facade.shareHistoricalKeys(roomId, userIds)
  } : { isEnabled: false }
})
```

### Changes to `HttpAPI`

- `processOutgoingCryptoRequests(cryptoManager)` is **removed** (it moves to CryptoFacade)
- `sendOutgoingCryptoRequest(request)` **stays** (it's a pure HTTP method)
- The `import { RequestType } from './crypto.mjs'` at the top stays (needed for `sendOutgoingCryptoRequest`)

### What does NOT change

- `CryptoManager` class itself — it's a clean OlmMachine wrapper, stays as-is
- `StructureAPI` — has no crypto involvement
- `ProjectList` — has no crypto involvement
- E2E test files — they test through the public MatrixClient API and should continue to work
- The public exports from `index.mjs` (CryptoManager, TrustRequirement, etc. stay exported for direct use)

## Acceptance Criteria

1. No module except `CryptoFacade` and `index.mjs` imports from `crypto.mjs`
2. `TimelineAPI`, `CommandAPI`, `Project` have zero references to `CryptoManager`
3. The encrypt ceremony (track → query → claim → share → encrypt → processOutgoing) exists exactly once, in `CryptoFacade.encryptEvent()`
4. The historical key sharing ceremony exists exactly once, in `CryptoFacade.shareHistoricalKeys()`
5. All existing E2E tests pass: `npm run test:e2e`
6. No public API changes (MatrixClient return values, Project methods, etc.)
7. `HttpAPI.processOutgoingCryptoRequests()` is removed
8. Clean separation: each module only knows about its callbacks/options, not the crypto internals

## Implementation Order

1. Create `src/crypto-facade.mjs` with full implementation + JSDoc
2. Refactor `TimelineAPI` to use callback options
3. Refactor `CommandAPI` to use callback options
4. Refactor `Project` to use crypto options object
5. Update `index.mjs` wiring
6. Remove `HttpAPI.processOutgoingCryptoRequests()`
7. Run `npx eslint src/` — fix any issues
8. Run E2E tests (if Docker/Tuwunel is available)
9. Commit with message: "refactor: extract CryptoFacade, remove direct CryptoManager coupling"
