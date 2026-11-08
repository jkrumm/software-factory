import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { freePort, startServer, startWorld } from '../scenarios/harness.ts'
import { makeEstate } from '../scenarios/intake/support.ts'
import { seed } from './seed.ts'

export const OWNER_LOGIN = 'owner@example.com'
const DIST = join(import.meta.dir, '..', '..', 'apps', 'console', 'dist')

/**
 * What `tailscale serve` does in front of the Console listener: the owner's login on every request. The browser's
 * extra headers do not reach a service worker's script fetch, so the tests open the app through this and keep the
 * listener itself (E2E_CONSOLE_URL) for the requests that must arrive without a login.
 */
function tailnetProxy(target: string) {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      const headers = new Headers(request.headers)
      headers.set('Tailscale-User-Login', OWNER_LOGIN)
      return fetch(`${target}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: request.body,
        redirect: 'manual',
        decompress: false,
      })
    },
  })
}

/**
 * A private Postgres and the real server with its Console listener on the built `apps/console/dist` (the Makefile builds
 * it first), seeded through the API. The two URLs reach the tests as environment variables; the teardown stops it all.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(DIST, 'index.html')))
    throw new Error('apps/console/dist is not built: `make e2e` builds it first')
  const world = await startWorld()
  const estate = await makeEstate(world, [{ repo: 'argo' }, { repo: 'chat', work: true }])
  const consolePort = await freePort()
  const server = await startServer(world, {
    env: {
      ...estate.env,
      FACTORY_CONSOLE_OWNER_LOGIN: OWNER_LOGIN,
      FACTORY_CONSOLE_PORT: String(consolePort),
      FACTORY_CONSOLE_DIR: DIST,
    },
  })
  await seed(world, server.url)
  const consoleUrl = `http://127.0.0.1:${consolePort}`
  const tailnet = tailnetProxy(consoleUrl)
  process.env.E2E_API_URL = server.url
  process.env.E2E_CONSOLE_URL = consoleUrl
  process.env.E2E_APP_URL = `http://127.0.0.1:${tailnet.port}`
  return async () => {
    await tailnet.stop(true)
    await server.stop()
    await estate.stop()
    await world.stop()
  }
}
