# Playground

Interactive CLI to test the `matrix-client-api`.

## Setup

```bash
cd playground
cp .env.example .env
# Edit .env with your Matrix credentials
```

## Run

```bash
node cli.mjs
```

## Commands

Type `help` in the CLI for a full command list. Quick start:

```
login                        # Connect and authenticate
projects                     # List your projects
open <odin-id>               # Open a specific project
layers                       # See layers in the project
layer-content <layer-id>     # Fetch layer operations
listen                       # Stream live changes
stop                         # Stop streaming
loglevel 3                   # Enable DEBUG logging
```

## E2EE

Set `MATRIX_ENCRYPTION=true` in `.env` to enable End-to-End Encryption.
Use `crypto-status` to check the OlmMachine state after login.

## Session Persistence

After login, credentials are saved to `.state.json` so you don't need to re-authenticate every time. Delete this file to force a fresh login.

## Notes

- This playground uses the library directly via relative import (`../index.mjs`)
- No `npm install` needed in the playground dir (dependencies come from the parent)
- The `.env` and `.state.json` files are gitignored
