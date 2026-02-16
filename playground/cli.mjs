#!/usr/bin/env node

/**
 * matrix-client-api Playground CLI
 * 
 * Interactive REPL to test the Matrix client API.
 * 
 * Usage:
 *   1. Copy .env.example to .env and fill in your credentials
 *   2. node cli.mjs
 * 
 * Commands are shown on startup. Type 'help' at any time.
 */

import { createInterface } from 'readline'
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { MatrixClient, discover, setLogger, consoleLogger, LEVELS } from '../index.mjs'

// ── ENV ──────────────────────────────────────────────────────────────────────

const loadEnv = () => {
  const envPath = new URL('.env', import.meta.url).pathname
  if (!existsSync(envPath)) {
    console.error('❌ No .env file found. Copy .env.example to .env and fill in your credentials.')
    process.exit(1)
  }
  const lines = readFileSync(envPath, 'utf-8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [key, ...rest] = trimmed.split('=')
    process.env[key.trim()] = rest.join('=').trim()
  }
}

loadEnv()

const HOME_SERVER = process.env.MATRIX_HOMESERVER
const USER_ID = process.env.MATRIX_USER
const PASSWORD = process.env.MATRIX_PASSWORD
const ENCRYPTION = process.env.MATRIX_ENCRYPTION === 'true'

if (!HOME_SERVER || !USER_ID || !PASSWORD) {
  console.error('❌ MATRIX_HOMESERVER, MATRIX_USER and MATRIX_PASSWORD must be set in .env')
  process.exit(1)
}

// ── State ────────────────────────────────────────────────────────────────────

let credentials = null
let projectList = null
let project = null
let streamController = null
const STATE_FILE = new URL('.state.json', import.meta.url).pathname

const saveState = () => {
  if (!credentials) return
  writeFileSync(STATE_FILE, JSON.stringify(credentials, null, 2))
}

const loadState = () => {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
    }
  } catch { /* ignore */ }
  return null
}

// ── Logging ──────────────────────────────────────────────────────────────────

let logLevel = LEVELS.INFO
setLogger(consoleLogger(logLevel))

// ── REPL ─────────────────────────────────────────────────────────────────────

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'matrix> '
})

const print = (...args) => console.log(...args)
const printJSON = (obj) => console.log(JSON.stringify(obj, null, 2))

const HELP = `
╔══════════════════════════════════════════════════════════════╗
║  matrix-client-api Playground                                ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Connection                                                  ║
║    discover          Check homeserver availability            ║
║    login             Login with credentials from .env         ║
║    logout            Logout and clear session                 ║
║    whoami            Show current credentials                 ║
║                                                              ║
║  Project List                                                ║
║    projects          List joined projects                     ║
║    invited           List project invitations                 ║
║    share <id> <name> [--encrypted] Share a new project         ║
║    join <id>         Join an invited project                  ║
║    members <id>      List project members                     ║
║    invite <pid> <uid> Invite user to project                  ║
║    search <term>     Search user directory                    ║
║                                                              ║
║  Project (select first with 'open')                          ║
║    open <id>         Open a project by ODIN id                ║
║    layers            List layers in current project            ║
║    layer-share <id> <name> [--encrypted] Share a new layer     ║
║    layer-join <id>   Join a layer                             ║
║    layer-content <id> Get layer content (operations)          ║
║    post <lid> <json> Post operations to a layer               ║
║                                                              ║
║  Streaming                                                   ║
║    listen            Start listening for project changes       ║
║    stop              Stop listening                            ║
║                                                              ║
║  E2EE (if enabled)                                           ║
║    crypto-status     Show OlmMachine status                   ║
║                                                              ║
║  Settings                                                    ║
║    loglevel <n>      Set log level (0=ERROR..3=DEBUG)         ║
║    help              Show this help                           ║
║    exit / quit       Exit                                     ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`

// ── Command Handlers ─────────────────────────────────────────────────────────

const commands = {

  help: () => print(HELP),

  discover: async () => {
    print('🔍 Discovering', HOME_SERVER, '...')
    const result = await discover({ home_server_url: HOME_SERVER })
    printJSON(result)
  },

  login: async () => {
    const saved = loadState()
    const loginData = {
      home_server_url: HOME_SERVER,
      user_id: USER_ID,
      password: PASSWORD,
      ...(ENCRYPTION ? { encryption: { enabled: true } } : {})
    }

    const client = MatrixClient(loginData)

    print('🔌 Connecting to', HOME_SERVER, '...')
    await client.connect(new AbortController())

    if (saved?.access_token) {
      print('♻️  Reusing saved session for', saved.user_id)
      credentials = saved
    } else {
      print('🔑 Logging in as', USER_ID, '...')
    }

    projectList = await client.projectList(saved?.access_token ? saved : undefined)
    
    projectList.tokenRefreshed(newCreds => {
      credentials = newCreds
      saveState()
      print('🔄 Token refreshed')
    })

    credentials = projectList.credentials()
    saveState()

    print('✅ Logged in as', credentials.user_id)
    if (ENCRYPTION) print('🔐 E2EE enabled')
    print('   Home server:', credentials.home_server_url)
    print('   Device ID:', credentials.device_id || '(none)')
  },

  logout: async () => {
    credentials = null
    projectList = null
    project = null
    try { existsSync(STATE_FILE) && writeFileSync(STATE_FILE, '{}') } catch {}
    print('👋 Logged out')
  },

  whoami: () => {
    if (!credentials) return print('❌ Not logged in')
    printJSON({
      user_id: credentials.user_id,
      home_server: credentials.home_server,
      device_id: credentials.device_id,
      encryption: ENCRYPTION
    })
  },

  projects: async () => {
    if (!projectList) return print('❌ Not logged in. Run: login')
    print('📂 Fetching projects...')
    await projectList.hydrate()
    const joined = await projectList.joined()
    if (joined.length === 0) return print('   (no projects)')
    joined.forEach(p => {
      print(`   📁 ${p.name || '(unnamed)'}`)
      print(`      id: ${p.id}`)
      print(`      upstream: ${p.upstreamId}`)
      if (p.powerlevel) print(`      role: ${p.powerlevel}`)
    })
  },

  invited: async () => {
    if (!projectList) return print('❌ Not logged in')
    const inv = await projectList.invited()
    if (inv.length === 0) return print('   (no invitations)')
    inv.forEach(p => {
      print(`   📨 ${p.name || '(unnamed)'}  id: ${p.id}`)
    })
  },

  share: async (args) => {
    if (!projectList) return print('❌ Not logged in')
    const encrypted = args.includes('--encrypted')
    const filtered = args.filter(a => a !== '--encrypted')
    const [id, ...nameParts] = filtered
    if (!id || nameParts.length === 0) return print('Usage: share <odin-id> <name> [--encrypted]')
    const name = nameParts.join(' ')
    const options = encrypted ? { encrypted: true } : {}
    print(`📤 Sharing project "${name}" (${id})${encrypted ? ' [E2EE]' : ''}...`)
    const result = await projectList.share(id, name, undefined, options)
    printJSON(result)
  },

  join: async (args) => {
    if (!projectList) return print('❌ Not logged in')
    const [id] = args
    if (!id) return print('Usage: join <odin-id>')
    print(`📥 Joining project ${id}...`)
    const result = await projectList.join(id)
    printJSON(result)
  },

  members: async (args) => {
    if (!projectList) return print('❌ Not logged in')
    const [id] = args
    if (!id) return print('Usage: members <odin-id>')
    const result = await projectList.members(id)
    result.forEach(m => {
      print(`   👤 ${m.displayName || m.userId}  (${m.membership}) role: ${m.role}`)
    })
  },

  invite: async (args) => {
    if (!projectList) return print('❌ Not logged in')
    const [projectId, userId] = args
    if (!projectId || !userId) return print('Usage: invite <project-id> <@user:server>')
    print(`📨 Inviting ${userId} to ${projectId}...`)
    await projectList.invite(projectId, userId)
    print('✅ Invited')
  },

  search: async (args) => {
    if (!projectList) return print('❌ Not logged in')
    const term = args.join(' ')
    if (!term) return print('Usage: search <term>')
    const results = await projectList.searchUsers(term)
    if (results.length === 0) return print('   (no results)')
    results.forEach(u => {
      print(`   👤 ${u.displayName || '?'}  ${u.userId}`)
    })
  },

  open: async (args) => {
    if (!projectList) return print('❌ Not logged in')
    const [id] = args
    if (!id) return print('Usage: open <odin-id>')

    // We need to get the upstream ID from the project list
    await projectList.hydrate()
    const joined = await projectList.joined()
    const found = joined.find(p => p.id === id)
    if (!found) return print(`❌ Project "${id}" not found. Run 'projects' to see available ones.`)

    print(`📂 Opening project "${found.name}" ...`)
    
    const loginData = {
      home_server_url: HOME_SERVER,
      user_id: USER_ID,
      password: PASSWORD,
      ...(ENCRYPTION ? { encryption: { enabled: true } } : {})
    }
    const client = MatrixClient(loginData)
    const proj = await client.project(credentials)
    const structure = await proj.hydrate({ id, upstreamId: found.upstreamId })
    project = proj

    print(`✅ Opened: ${structure.name}`)
    print(`   Layers: ${structure.layers.length}`)
    structure.layers.forEach(l => {
      print(`      📄 ${l.name || '(unnamed)'}  id: ${l.id}  role: ${l.role?.self}`)
    })
    if (structure.invitations?.length) {
      print(`   Invitations: ${structure.invitations.length}`)
      structure.invitations.forEach(i => print(`      📨 ${i.name}  id: ${i.id}`))
    }
  },

  layers: async () => {
    if (!project) return print('❌ No project open. Run: open <id>')
    print('   (layers are shown when opening a project)')
  },

  'layer-share': async (args) => {
    if (!project) return print('❌ No project open')
    const encrypted = args.includes('--encrypted')
    const filtered = args.filter(a => a !== '--encrypted')
    const [id, ...nameParts] = filtered
    if (!id || nameParts.length === 0) return print('Usage: layer-share <layer-id> <name> [--encrypted]')
    const name = nameParts.join(' ')
    const options = encrypted ? { encrypted: true } : {}
    print(`📤 Sharing layer "${name}"${encrypted ? ' [E2EE]' : ''}...`)
    const result = await project.shareLayer(id, name, undefined, options)
    printJSON(result)
  },

  'layer-join': async (args) => {
    if (!project) return print('❌ No project open')
    const [id] = args
    if (!id) return print('Usage: layer-join <layer-id>')
    print(`📥 Joining layer ${id}...`)
    const result = await project.joinLayer(id)
    printJSON(result)
  },

  'layer-content': async (args) => {
    if (!project) return print('❌ No project open')
    const [id] = args
    if (!id) return print('Usage: layer-content <layer-id>')
    print(`📖 Fetching content for layer ${id}...`)
    const ops = await project.content(id)
    print(`   ${ops.length} operation(s)`)
    if (ops.length <= 20) {
      printJSON(ops)
    } else {
      print('   (showing first 20)')
      printJSON(ops.slice(0, 20))
    }
  },

  post: async (args) => {
    if (!project) return print('❌ No project open')
    const [layerId, ...jsonParts] = args
    if (!layerId || jsonParts.length === 0) return print('Usage: post <layer-id> <json-operations>')
    try {
      const ops = JSON.parse(jsonParts.join(' '))
      print(`📝 Posting to layer ${layerId}...`)
      await project.post(layerId, Array.isArray(ops) ? ops : [ops])
      print('✅ Posted')
    } catch (e) {
      print('❌ Invalid JSON:', e.message)
    }
  },

  listen: async () => {
    if (!project) return print('❌ No project open')
    print('👂 Listening for changes (Ctrl+C or "stop" to end)...')
    
    const handler = {
      streamToken: async (token) => {
        // silently store
      },
      received: async ({ id, operations }) => {
        print(`\n   📥 Layer ${id}: ${operations.length} operation(s)`)
        if (operations.length <= 5) printJSON(operations)
        rl.prompt()
      },
      receivedExtension: async ({ id, message }) => {
        print(`\n   🔌 Extension ${id}:`, JSON.stringify(message).slice(0, 200))
        rl.prompt()
      },
      renamed: async (renamed) => {
        const items = Array.isArray(renamed) ? renamed : [renamed]
        items.forEach(r => print(`\n   ✏️  Renamed: ${r.id} → "${r.name}"`))
        rl.prompt()
      },
      invited: async (invitation) => {
        print(`\n   📨 Layer invitation: ${invitation.name} (${invitation.id})`)
        rl.prompt()
      },
      roleChanged: async (roles) => {
        const items = Array.isArray(roles) ? roles : [roles]
        items.forEach(r => print(`\n   👑 Role changed: ${r.id} → ${r.role?.self}`))
        rl.prompt()
      },
      membershipChanged: async (memberships) => {
        const items = Array.isArray(memberships) ? memberships : [memberships]
        items.forEach(m => print(`\n   👤 Membership: ${m.subject} → ${m.membership} in ${m.id}`))
        rl.prompt()
      },
      error: async (error) => {
        print(`\n   ⚠️  Stream error: ${error.message}`)
        rl.prompt()
      }
    }

    // Run in background
    project.start(undefined, handler).catch(err => {
      if (err.name !== 'AbortError') print('   Stream ended:', err.message)
    })
  },

  stop: async () => {
    if (!project) return print('❌ No project open')
    await project.stop()
    print('⏹️  Stopped listening')
  },

  'crypto-status': async () => {
    if (!ENCRYPTION) return print('❌ E2EE not enabled. Set MATRIX_ENCRYPTION=true in .env')
    const cm = projectList?.cryptoManager || project?.cryptoManager
    if (!cm) return print('❌ CryptoManager not available. Login first.')
    print('🔐 CryptoManager Status:')
    print(`   User: ${cm.userId?.toString()}`)
    print(`   Device: ${cm.deviceId?.toString()}`)
    print(`   Identity Keys: ${cm.identityKeys ? 'available' : 'not available'}`)
  },

  loglevel: (args) => {
    const [level] = args
    if (level === undefined) return print(`Current log level: ${logLevel}`)
    logLevel = parseInt(level)
    setLogger(consoleLogger(logLevel))
    const names = ['ERROR', 'WARN', 'INFO', 'DEBUG']
    print(`📊 Log level set to ${names[logLevel] || logLevel}`)
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

print(HELP)
print(`Config: ${HOME_SERVER} as ${USER_ID}${ENCRYPTION ? ' [E2EE]' : ''}`)
print('Type "login" to start.\n')

rl.prompt()

rl.on('line', async (line) => {
  const trimmed = line.trim()
  if (!trimmed) { rl.prompt(); return }
  
  if (trimmed === 'exit' || trimmed === 'quit') {
    print('👋 Bye!')
    process.exit(0)
  }

  const [cmd, ...args] = trimmed.split(/\s+/)
  const handler = commands[cmd]
  
  if (!handler) {
    print(`❌ Unknown command: ${cmd}. Type 'help' for available commands.`)
    rl.prompt()
    return
  }

  try {
    await handler(args)
  } catch (error) {
    print(`❌ Error: ${error.message}`)
    if (logLevel >= LEVELS.DEBUG) {
      console.error(error)
    }
  }
  rl.prompt()
})

rl.on('close', () => {
  print('\n👋 Bye!')
  process.exit(0)
})
