import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freePort, startWorld } from '../scenarios/harness.ts'
import { makeEstate } from '../scenarios/intake/support.ts'
import { startLab } from '../scenarios/planning/lab.ts'
import { LEAD_REPOS, seed } from './seed.ts'
import { ARTIFACT_REPOS, seedArtifacts } from './seed-artifacts.ts'

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
 * it first), seeded through the API with real leads (a repo with an origin, the fake `hc`: tests/e2e/seed.ts). The URLs
 * and the world's directory reach the tests as environment variables; the teardown stops it all.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(DIST, 'index.html')))
    throw new Error('apps/console/dist is not built: `make e2e` builds it first')
  const world = await startWorld()
  const estate = await makeEstate(world, [{ repo: 'argo' }, { repo: 'chat', work: true }])
  const consolePort = await freePort()
  const dataDir = await mkdtemp(join(tmpdir(), 'factory-e2e-data-'))
  // the owner's line: a page being sent is what puts a Decision on the owner's list
  const ntfy = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') })
  // `chat` is the work repo of the estate (outside text redacted for the read token); these have project files, so leads run in them
  const lab = await startLab({
    world,
    leads: true,
    repos: Object.fromEntries(
      [...LEAD_REPOS, ...ARTIFACT_REPOS].map((name) => [name, { project: `apiVersion: factory/v2\nname: ${name}\n` }]),
    ),
    env: {
      ...estate.env,
      FACTORY_LEADS_PER_ACCOUNT: '16',
      FACTORY_NTFY_URL: `http://127.0.0.1:${ntfy.port}`,
      FACTORY_NTFY_TOPIC: 'factory',
      NTFY_TOKEN: 'e2e-token',
      FACTORY_CONSOLE_URL: 'https://console.example.test',
      FACTORY_CONSOLE_OWNER_LOGIN: OWNER_LOGIN,
      FACTORY_CONSOLE_PORT: String(consolePort),
      FACTORY_CONSOLE_DIR: DIST,
      FACTORY_DATA_DIR: dataDir,
    },
  })
  // before `seed`, which leaves a project row the planning of a new Issue cannot read
  process.env.E2E_ARTIFACTS = JSON.stringify(await seedArtifacts(lab))
  await seed(lab)
  const consoleUrl = `http://127.0.0.1:${consolePort}`
  const tailnet = tailnetProxy(consoleUrl)
  process.env.E2E_API_URL = lab.server.url
  process.env.E2E_CONSOLE_URL = consoleUrl
  process.env.E2E_APP_URL = `http://127.0.0.1:${tailnet.port}`
  process.env.E2E_WORLD_BIN = world.bin
  return async () => {
    await tailnet.stop(true)
    await lab.stop()
    await ntfy.stop(true)
    await estate.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
}
