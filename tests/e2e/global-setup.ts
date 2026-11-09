import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freePort, startServer, startWorld, type ServerProcess } from '../scenarios/harness.ts'
import { makeEstate } from '../scenarios/intake/support.ts'
import { startLab } from '../scenarios/planning/lab.ts'
import { seedHost } from './seed-host.ts'
import { LEAD_REPOS, seed } from './seed.ts'
import { ARTIFACT_REPOS, seedArtifacts } from './seed-artifacts.ts'
import { CHAIN_REPOS, chainPlan, seedChain } from './seed-chain.ts'
import { HISTORY_REPOS, seedHistory } from './seed-history.ts'

const DIST = join(import.meta.dir, '..', '..', 'apps', 'console', 'dist')

/**
 * A private Postgres and the real server with its Console listener on the built `apps/console/dist` (the Makefile builds
 * it first), seeded through the API with real leads (a repo with an origin, the fake `hc`: tests/e2e/seed.ts). The URLs
 * and the world's directory reach the tests as environment variables; the teardown stops it all.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(DIST, 'index.html')))
    throw new Error('apps/console/dist is not built: `make e2e` builds it first')
  const world = await startWorld()
  const estate = await makeEstate(world, [{ repo: 'argo' }, { repo: 'chat', work: true }, { repo: 'orion' }])
  const consolePort = await freePort()
  const dataDir = await mkdtemp(join(tmpdir(), 'factory-e2e-data-'))
  // the owner's line: a page being sent is what puts a Decision on the owner's list
  const ntfy = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') })
  // `chat` is the work repo of the estate (outside text redacted for the read token); these have project files, so leads run in them
  const labEnv = {
    ...estate.env,
    FACTORY_LEADS_PER_ACCOUNT: '16',
    FACTORY_NTFY_URL: `http://127.0.0.1:${ntfy.port}`,
    FACTORY_NTFY_TOPIC: 'factory',
    NTFY_TOKEN: 'e2e-token',
    FACTORY_CONSOLE_URL: 'https://console.example.test',
    FACTORY_CONSOLE_PORT: String(consolePort),
    FACTORY_CONSOLE_DIR: DIST,
    FACTORY_DATA_DIR: dataDir,
  }
  const lab = await startLab({
    world,
    leads: true,
    repos: Object.fromEntries(
      [...LEAD_REPOS, ...ARTIFACT_REPOS, ...HISTORY_REPOS, ...CHAIN_REPOS].map((name) => [
        name,
        {
          project: `apiVersion: factory/v2\nname: ${name}\n`,
          ...(CHAIN_REPOS.includes(name) ? { plan: chainPlan() } : {}),
        },
      ]),
    ),
    env: labEnv,
  })
  // before `seed`, which leaves a project row the planning of a new Issue cannot read
  process.env.E2E_ARTIFACTS = JSON.stringify(await seedArtifacts(lab))
  process.env.E2E_HISTORY = JSON.stringify(await seedHistory(lab))
  process.env.E2E_CHAIN = JSON.stringify(await seedChain(lab))
  await seedHost(world.db.sql)
  await seed(lab)
  const consoleUrl = `http://127.0.0.1:${consolePort}`
  // the same environment the lab used, so the restarted server keeps the Console port and the repos
  const serverEnv = { FACTORY_REPO_ROOTS: lab.root, FACTORY_GRACE_MS: '0', ...labEnv }
  let current: ServerProcess = lab.server
  const control = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      if (request.method === 'GET' && path === '/api-url') return new Response(current.url)
      if (request.method !== 'POST' || path !== '/restart') return new Response('not found', { status: 404 })
      await current.stop()
      current = await startServer(world, { env: serverEnv })
      return new Response(current.url)
    },
  })
  process.env.E2E_CONTROL_URL = `http://127.0.0.1:${control.port}`
  process.env.E2E_API_URL = lab.server.url
  process.env.E2E_CONSOLE_URL = consoleUrl
  process.env.E2E_WORLD_BIN = world.bin
  return async () => {
    await control.stop(true)
    await current.stop()
    await lab.stop()
    await ntfy.stop(true)
    await estate.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
}
