import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadRoleTable, type RoleTable } from '@software-factory/contract'
import type { SQL } from 'bun'
import type { Clock } from '../../src/clock.ts'
import { TickMonitor } from '../../src/health.ts'
import { serve } from '../../src/http.ts'
import { QuotaPoller } from '../../src/quota.ts'
import { FakeQuotaSource } from './quota.ts'

export const TEST_TOKEN = 'test-token-0123456789'

/** The one allowed root of a test server, and a repo inside it (both real paths: /tmp is a link on macOS). */
export const TEST_ROOT = realpathSync(mkdtempSync('/tmp/factory-roots-'))
export const TEST_REPO = join(TEST_ROOT, 'repo')
mkdirSync(TEST_REPO)
process.on('exit', () => rmSync(TEST_ROOT, { recursive: true, force: true }))

export const TEST_ROLES: RoleTable = await loadRoleTable()

export interface TestApp {
  url: URL
  /** what `POST /quota/refresh` reads */
  quotaSource: FakeQuotaSource
  /** what the ticker would report to `/health`; tests drive it directly */
  monitor: TickMonitor
  /** all of these carry the bearer token and, with a body, the JSON content type */
  get(path: string): Promise<Response>
  send(method: 'POST' | 'PUT', path: string, body: unknown): Promise<Response>
  raw(path: string, body: string): Promise<Response>
  request(method: string, path: string): Promise<Response>
  /** the request exactly as given: no token, no content type unless the test sets them */
  bare(path: string, init?: RequestInit): Promise<Response>
  stop(): Promise<void>
}

const authed = { authorization: `Bearer ${TEST_TOKEN}` }
const json = { ...authed, 'content-type': 'application/json' }

/** The real server on a loopback port the OS picks. */
export function startApp(deps: {
  sql: SQL
  clock: Clock
  monitor?: TickMonitor
  repoRoots?: readonly string[]
  roles?: RoleTable
}): TestApp {
  const quotaSource = new FakeQuotaSource()
  const monitor = deps.monitor ?? new TickMonitor(deps.clock, 5_000, 240_000)
  // A server in a test has ticked, unless the test brings a monitor of its own.
  if (!deps.monitor) monitor.passSucceeded()
  const server = serve({
    ...deps,
    monitor,
    repoRoots: deps.repoRoots ?? [TEST_ROOT],
    roles: deps.roles ?? TEST_ROLES,
    quota: new QuotaPoller({ sql: deps.sql, clock: deps.clock, source: quotaSource }),
    port: 0,
    version: 'test',
    token: TEST_TOKEN,
  })
  const url = (path: string) => new URL(path, server.url)
  return {
    monitor,
    quotaSource,
    url: server.url,
    get: (path) => fetch(url(path), { headers: authed }),
    send: (method, path, body) => fetch(url(path), { method, headers: json, body: JSON.stringify(body) }),
    raw: (path, body) => fetch(url(path), { method: 'POST', headers: json, body }),
    request: (method, path) => fetch(url(path), { method, headers: authed }),
    bare: (path, init) => fetch(url(path), init),
    stop: async () => {
      await server.stop(true)
    },
  }
}
