import { defaultHookSocket } from '@software-factory/contract/spool'
import { createDoor, fileViaSocket, MAX_BODY_BYTES, reportViaSocket } from './door.ts'
import { loadTokens, tokensFileFrom } from './tokens.ts'

/** The loopback port `tailscale serve` publishes on the mini's tailnet name. */
const DEFAULT_PORT = 8796

function fail(message: string): never {
  console.error(`factory-door: ${message}`)
  process.exit(1)
}

const env = process.env
const port = env.FACTORY_DOOR_PORT ? Number(env.FACTORY_DOOR_PORT) : DEFAULT_PORT
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  fail(`FACTORY_DOOR_PORT must be an integer from 1 to 65535, got: ${env.FACTORY_DOOR_PORT}`)
}
const socket = env.FACTORY_SOCKET || (env.HOME ? defaultHookSocket(env.HOME) : '')
if (!socket) fail('no socket: set FACTORY_SOCKET or HOME')

const report = reportViaSocket(socket)

let tokens: ReturnType<typeof loadTokens>
try {
  tokens = loadTokens(tokensFileFrom(env))
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

// The server may not be up yet at login: tell it which sources the door holds, six tries five seconds apart, in the background.
void (async () => {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) await Bun.sleep(5_000)
    try {
      await report({ kind: 'start', sources: Object.keys(tokens).slice(0, 16) })
      return
    } catch {
      // the server is not up yet: try again
    }
  }
})()

// Loopback only, never a tailnet address: `tailscale serve` terminates TLS in front. Bun's own cap is a backstop above the
// door's, which counts the bytes it reads.
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  maxRequestBodySize: MAX_BODY_BYTES * 4,
  fetch: createDoor({ tokens, file: fileViaSocket(socket), report }),
})
console.error(`factory-door listening on 127.0.0.1:${server.port} (sources: ${Object.keys(tokens).join(', ')})`)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void server.stop(true).then(() => process.exit(0))
  })
}
