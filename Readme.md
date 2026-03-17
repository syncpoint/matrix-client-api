# @syncpoint/matrix-client-api

A purpose-built Matrix client library for [ODIN](https://odin.syncpoint.io) collaborative C2IS. Provides high-level abstractions for project/layer management, real-time synchronization, and end-to-end encryption — designed for both Node.js and browser (Electron) environments.

> **Note:** This is not a general-purpose Matrix SDK. It creates domain-specific abstractions like `ProjectList` and `Project` tailored to ODIN's collaboration model.

## Features

- **Project & Layer Management** — Create, share, join, and leave collaborative projects and layers via Matrix spaces and rooms.
- **End-to-End Encryption** — Transparent Megolm encryption/decryption of ODIN operations, including historical key sharing for late joiners.
- **Real-time Sync** — Long-polling sync stream with automatic catch-up and reconnection.
- **Role-based Access Control** — Power level mapping to ODIN roles (Owner, Administrator, Contributor, Reader).
- **Automatic Token Refresh** — Transparent access token renewal on 401 responses.
- **Configurable Logging** — Injectable logger with log levels (Error, Warn, Info, Debug).

## Requirements

- Node.js 18+ (uses built-in `fetch`)
- For E2EE: `@matrix-org/matrix-sdk-crypto-wasm` (peer dependency)

## Installation

```bash
npm install @syncpoint/matrix-client-api
```

## Quick Start

```javascript
import { MatrixClient, setLogger, consoleLogger, LEVELS, TrustRequirement } from '@syncpoint/matrix-client-api'

setLogger(consoleLogger(LEVELS.INFO))

const client = MatrixClient({
  home_server_url: 'https://matrix.example.com',
  user_id: '@alice:example.com',
  password: 'secret',
  encryption: { enabled: true }       // optional: enable E2EE
})

// Connect and authenticate
await client.connect(new AbortController())
const projectList = await client.projectList()

// List projects
await projectList.hydrate()
const projects = await projectList.joined()

// Open a project
const project = await client.project(projectList.credentials())
const structure = await project.hydrate({ id: projects[0].id, upstreamId: projects[0].upstreamId })

// Stream live changes
project.start(null, {
  received: ({ id, operations }) => console.log(`Layer ${id}: ${operations.length} ops`),
  renamed: (items) => items.forEach(r => console.log(`Renamed: ${r.name}`)),
  roleChanged: (roles) => roles.forEach(r => console.log(`Role: ${r.role.self}`)),
  error: (err) => console.error(err)
})
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  MatrixClient (factory)                                 │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────────┐  │
│  │ ProjectList │  │   Project   │  │ CryptoManager  │  │
│  └──────┬──────┘  └──────┬──────┘  └───────┬────────┘  │
│         │                │                  │           │
│  ┌──────┴──────────────────────────────────┘           │
│  │                                                     │
│  │  ┌──────────────┐ ┌────────────┐ ┌──────────────┐  │
│  │  │ StructureAPI │ │ CommandAPI │ │ TimelineAPI  │  │
│  │  └──────┬───────┘ └─────┬──────┘ └──────┬───────┘  │
│  │         │               │               │          │
│  │         └───────────────┼───────────────┘          │
│  │                         │                          │
│  │                  ┌──────┴──────┐                    │
│  │                  │   HttpAPI   │                    │
│  │                  └─────────────┘                    │
│  │                                                     │
│  └─────────────────────────────────────────────────────┘
```

### API Layers

**HttpAPI** — Thin wrapper over the Matrix Client-Server API with automatic token refresh. All other APIs build on this.

**StructureAPI** — Creates and queries ODIN structural components: projects (Matrix spaces) and layers (Matrix rooms). Handles invitations, joins, power levels, and room hierarchy.

**CommandAPI** — Send-only API with ordered queue. Schedules ODIN operations for delivery. Transparently encrypts messages when E2EE is enabled. Supports async callback functions in the queue for post-send actions.

**TimelineAPI** — Receive-only API. Consumes the Matrix sync stream and message history. Transparently decrypts incoming events. Provides both initial catch-up (via `/messages`) and live streaming (via `/sync` long-poll).

**CryptoManager** — Wraps the `@matrix-org/matrix-sdk-crypto-wasm` OlmMachine. Handles key upload, device tracking, Olm/Megolm session management, and historical key sharing.

## End-to-End Encryption

E2EE is configured per project. When enabled:

1. **Outgoing operations** are Megolm-encrypted by the CommandAPI before sending.
2. **Incoming events** are transparently decrypted by the TimelineAPI.
3. **Historical keys** are shared with new members via Olm-encrypted `to_device` messages, ensuring late joiners can decrypt existing layer content.
4. **Power levels** are configured so that `m.room.encrypted` events require the same permission level as `io.syncpoint.odin.operation` (Contributor).

### Historical Key Sharing

When a user shares a layer that already has content:

1. Content is posted to the layer (encrypted via Megolm).
2. After posting, all Megolm session keys for the room are exported.
3. Keys are Olm-encrypted per-device for each project member.
4. Keys are sent as `m.room.encrypted` to_device messages (type `io.syncpoint.odin.room_keys` after Olm decryption).
5. The Matrix server queues `to_device` messages for offline recipients.
6. On the receiving side, `receiveSyncChanges()` intercepts decrypted key events and imports them via `importRoomKeys()`.

This ensures that members who join later — even when the sharer is offline — can decrypt all existing content.

### Encryption Configuration

```javascript
import { MatrixClient, CryptoManager, TrustRequirement } from '@syncpoint/matrix-client-api'

// Per-project encryption (as used in ODIN)
const client = MatrixClient({
  home_server_url: 'https://matrix.example.com',
  user_id: '@alice:example.com',
  password: 'secret',
  encryption: {
    enabled: true,
    storeName: 'crypto-<projectUUID>',    // persistent IndexedDB store (Electron/browser)
    passphrase: 'optional-store-passphrase'
  }
})
```

### Trust Requirements

The `CryptoManager` accepts a configurable trust level for decryption. This controls whether messages from unverified devices are accepted or rejected.

```javascript
// Default: accept messages from all devices (including unverified)
const crypto = new CryptoManager()

// Strict: only accept messages from cross-signed or locally trusted devices
const crypto = new CryptoManager({ trustRequirement: TrustRequirement.CrossSignedOrLegacy })
```

Available trust levels (from `@matrix-org/matrix-sdk-crypto-wasm`):

| TrustRequirement | Description |
|------------------|-------------|
| `Untrusted` | Accept all messages regardless of device verification status (default) |
| `CrossSignedOrLegacy` | Only accept messages from devices that are cross-signed or locally trusted |
```

### Device Verification (SAS)

Devices can be interactively verified using the [Short Authentication String (SAS)](https://spec.matrix.org/v1.12/client-server-api/#short-authentication-string-sas-verification) method. Both users compare 7 emojis displayed on their screens — if they match, the devices are mutually verified.

```javascript
// Alice initiates verification of Bob's device
const { request, toDeviceRequest } = await crypto.requestVerification(bobUserId, bobDeviceId)
await httpAPI.sendOutgoingCryptoRequest(toDeviceRequest)

// Bob receives and accepts (after sync)
const requests = crypto.getVerificationRequests(aliceUserId)
const acceptRequest = crypto.acceptVerification(requests[0])
await httpAPI.sendOutgoingCryptoRequest(acceptRequest)

// Alice starts SAS (after sync)
const { sas, request: sasRequest } = await crypto.startSas(request)
await httpAPI.sendOutgoingCryptoRequest(sasRequest)

// Bob gets SAS and accepts (after sync)
const bobSas = crypto.getSas(bobRequest)
await httpAPI.sendOutgoingCryptoRequest(bobSas.accept())

// Both see emojis (after sync)
const emojis = crypto.getEmojis(sas)
// → [{symbol: '🎸', description: 'Guitar'}, {symbol: '📕', description: 'Book'}, ...]

// Both confirm match
const outgoing = await crypto.confirmSas(sas)
for (const req of outgoing) await httpAPI.sendOutgoingCryptoRequest(req)

// Check verification status
await crypto.isDeviceVerified(bobUserId, bobDeviceId) // → true
await crypto.getDeviceVerificationStatus(bobUserId)
// → [{deviceId: 'BOB_DEVICE', verified: true, locallyTrusted: true, crossSigningTrusted: false}]
```

#### Verification API

| Method | Description |
|--------|-------------|
| `requestVerification(userId, deviceId)` | Initiate SAS verification |
| `getVerificationRequests(userId)` | List pending requests for a user |
| `getVerificationRequest(userId, flowId)` | Get specific request by flow ID |
| `acceptVerification(request)` | Accept incoming request (SAS method) |
| `startSas(request)` | Transition accepted request to SAS flow |
| `getSas(request)` | Get SAS state machine from request |
| `getEmojis(sas)` | Get 7 emoji objects `{symbol, description}` |
| `confirmSas(sas)` | Confirm emojis match → device verified |
| `cancelSas(sas)` | Cancel SAS flow |
| `cancelVerification(request)` | Cancel verification request |
| `isDeviceVerified(userId, deviceId)` | Check if device is trusted |
| `getDeviceVerificationStatus(userId)` | All devices with trust details |
| `getVerificationPhase(request)` | Current phase name (Created/Requested/Ready/Transitioned/Done/Cancelled) |

#### Verification Flow

```
Alice                              Bob
  │  requestVerification()           │
  ├─────── m.key.verification.request ──────►│
  │                                  │  acceptVerification()
  │◄──────── m.key.verification.ready ───────┤
  │  startSas()                      │
  ├──────── m.key.verification.start ────────►│
  │                                  │  sas.accept()
  │◄─────── m.key.verification.accept ───────┤
  │                                  │
  │◄──── m.key.verification.key (exchange) ──►│
  │                                  │
  │  🎸 📕 🐢 🎅 🚂 🍄 🐧          │  🎸 📕 🐢 🎅 🚂 🍄 🐧
  │  "Do these match?" [Yes]         │  "Do these match?" [Yes]
  │                                  │
  │  confirmSas()                    │  confirmSas()
  │◄──── m.key.verification.mac ─────────────►│
  │◄──── m.key.verification.done ────────────►│
  │                                  │
  │  ✅ Bob verified                 │  ✅ Alice verified
```

## Roles & Power Levels

| Role | Level | Can Send Operations | Can Manage | Can Admin |
|------|-------|-------------------|------------|-----------|
| Owner | 111 | ✅ | ✅ | ✅ |
| Administrator | 100 | ✅ | ✅ | ✅ |
| Contributor | 25 | ✅ | ❌ | ❌ |
| Reader | 0 | ❌ | ❌ | ❌ |

## Playground CLI

An interactive CLI for testing the library is included in `playground/`.

```bash
cd playground
cp .env.example .env
# Edit .env with your Matrix credentials
node cli.mjs
```

### Configuration (.env)

```
MATRIX_HOMESERVER=http://localhost:8008
MATRIX_USER=@alice:odin.battlefield
MATRIX_PASSWORD=Alice
MATRIX_ENCRYPTION=true
```

### Commands

| Category | Command | Description |
|----------|---------|-------------|
| Connection | `login` | Connect and authenticate |
| | `discover` | Check homeserver availability |
| | `whoami` | Show current credentials |
| Projects | `projects` | List joined projects |
| | `invited` | List project invitations |
| | `share <id> <name> [--encrypted]` | Share a new project |
| | `join <id>` | Join an invited project |
| | `invite <pid> <uid>` | Invite user to project |
| | `members <id>` | List project members |
| Project | `open <id>` | Open a project by ODIN id |
| | `layer-share <id> <name> [--encrypted]` | Share a new layer |
| | `layer-join <id>` | Join a layer |
| | `layer-content <id>` | Fetch layer operations |
| | `post <lid> <json>` | Post operations to a layer |
| | `send <lid> <text>` | Send plain message (testing) |
| Streaming | `listen` | Stream live changes |
| | `stop` | Stop streaming |
| E2EE | `crypto-status` | Show OlmMachine status |
| Settings | `loglevel <n>` | Set log level (0=ERROR..3=DEBUG) |

Session credentials are cached in `.state.json` for convenience.

## Testing

### Unit Tests

```bash
npm test
```

### E2E Integration Tests (against Tuwunel)

The E2E tests run against a real Matrix homeserver (Tuwunel) in Docker:

```bash
# Start the test homeserver
cd test-e2e
docker compose up -d
cd ..

# Run E2E tests
npm run test:e2e
```

Test suites:
- **e2ee.test.mjs** — Low-level crypto: key upload, room encryption, encrypt/decrypt round-trip
- **matrix-client-api.test.mjs** — Full API stack: StructureAPI, CommandAPI, TimelineAPI with E2EE
- **content-after-join.test.mjs** — Historical key sharing: Alice posts encrypted content → shares keys → Bob joins → Bob decrypts

## Compatibility

Tested against:
- **Synapse** (reference Matrix homeserver)
- **Tuwunel** (Conduit fork) — with fixes for state event delivery differences

### Tuwunel Specifics

Tuwunel may deliver room state events differently than Synapse:
- State events for new rooms may appear only in the timeline, not in the `state` block during initial sync.
- The `timeline` object may be omitted entirely for rooms with no new events.

The library handles both behaviors transparently.

## License

See [LICENSE](LICENSE).
