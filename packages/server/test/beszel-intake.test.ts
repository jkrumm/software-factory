import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ProcessResult } from '../src/exec.ts'
import { BeszelIntake } from '../src/intake/beszel.ts'
import { type Infra, parseInfra } from '../src/intake/infra.ts'
import { TEST_ROOT } from './support/app.ts'
import { FakeClock } from './support/clock.ts'
import { startTestDb, type TestDb } from './support/pg.ts'

const DOTFILES = join(TEST_ROOT, 'dotfiles')
const HOMELAB = join(TEST_ROOT, 'homelab')
const IU_ROOT = join(TEST_ROOT, 'IuRoot')
mkdirSync(DOTFILES, { recursive: true })
mkdirSync(HOMELAB, { recursive: true })
mkdirSync(join(IU_ROOT, 'dotfiles'), { recursive: true })
const PASSWORD = 'hub-password-value'
const GIB = 1024 ** 3
const MIN = 60_000

const INFRA: Infra = parseInfra(
  JSON.stringify({
    hosts: { macmini: { repo: 'dotfiles', local: true }, homelab: { repo: 'homelab' } },
  }),
)

let db: TestDb
const clock = new FakeClock()

beforeAll(async () => {
  db = await startTestDb()
})
afterAll(() => db.stop())
beforeEach(() => db.reset())

const logged: unknown[][] = []
let errors: ReturnType<typeof spyOn>
beforeEach(() => {
  logged.length = 0
  errors = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args)
  })
})
afterEach(() => errors.mockRestore())

type Stats = Record<string, unknown>
/** minutes ago -> the stats of that minute */
type Shape = (minutesAgo: number) => Stats

/** Swap in GB at a minute; 0 is omitted as the hub does. */
const swap =
  (gb: (m: number) => number): Shape =>
  (m) => {
    const used = gb(m)
    return { mp: 50, dp: 40, cpu: 3, la: [0.5, 0.5, 0.5], ...(used > 0 ? { swap: [16 * GIB, used * GIB] } : {}) }
  }

const system = (name: string, extra: Record<string, unknown> = {}) => ({
  id: `id${name.toLowerCase()}`,
  name,
  status: 'up',
  info: { t: 8, c: 8, u: 5000 },
  updated: clock.now().toISOString().replace('T', ' '),
  ...extra,
})

function setup(
  options: {
    systems?: ReturnType<typeof system>[]
    url?: string | undefined
    sourceRoot?: string
    run?: (cmd: string[]) => Promise<ProcessResult>
    answer?: (url: string) => Response | undefined
  } = {},
) {
  const calls: { url: string; auth: string | null }[] = []
  const revoked = new Set<string>()
  const series = new Map<string, { count: number; shape: Shape }>()
  let authCalls = 0
  let systems = options.systems ?? [system('MacMini')]
  const fetchFake = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const text = String(url)
    const auth = new Headers(init?.headers).get('Authorization')
    calls.push({ url: text, auth })
    const forced = options.answer?.(text)
    if (forced) return Promise.resolve(forced)
    if (text.endsWith('/api/collections/users/auth-with-password')) {
      authCalls++
      return Promise.resolve(Response.json({ token: `token-${authCalls}` }))
    }
    if (!auth || revoked.has(auth)) return Promise.resolve(new Response('no', { status: 401 }))
    if (text.includes('/collections/systems/records')) return Promise.resolve(Response.json({ items: systems }))
    const id = /system%3D%22(\w+)%22/.exec(text)?.[1] ?? ''
    const wanted = series.get(id)
    const items = Array.from({ length: wanted?.count ?? 0 }, (_, m) => ({
      created: new Date(clock.now().getTime() - m * MIN).toISOString().replace('T', ' '),
      stats: wanted?.shape(m),
    }))
    return Promise.resolve(Response.json({ items }))
  }
  const intake = new BeszelIntake({
    sql: db.sql,
    now: () => clock.now(),
    roots: [TEST_ROOT],
    sourceRoot: options.sourceRoot ?? TEST_ROOT,
    infra: INFRA,
    url: 'url' in options ? options.url : 'https://hub.example.com/',
    email: 'hub-user',
    password: PASSWORD,
    everyMs: 60_000,
    fetch: fetchFake as typeof fetch,
    run: options.run ?? (() => Promise.resolve({ exitCode: 1, stdout: '' })),
  })
  return {
    calls,
    intake,
    get authCalls() {
      return authCalls
    },
    revoke: () => revoked.add(`token-${authCalls}`),
    serve: (name: string, count: number, shape: Shape) => series.set(system(name).id, { count, shape }),
    setSystems: (next: ReturnType<typeof system>[]) => {
      systems = next
    },
    pass: async () => {
      clock.advance(MIN)
      intake.kick()
      await intake.settled()
    },
  }
}

// oxlint-disable-next-line typescript/no-explicit-any -- rows of whichever table a test reads
const rows = async (table: string): Promise<Record<string, any>[]> => [
  ...(await db.sql.unsafe(`SELECT * FROM factory.${table} ORDER BY 1, 2`)),
]

const PS_RSS = [
  '  100  2048 /sbin/launchd',
  '  200  9000000 /Applications/Big.app/Contents/MacOS/Big',
  '  300  512000 /usr/bin/node',
  '  400  100 /bin/a',
  '  500  4096000 /bin/b',
  '  600  300000 /bin/c',
  '  700  150000 /bin/d',
].join('\n')
const psFake = (cmd: string[]): Promise<ProcessResult> =>
  Promise.resolve(cmd.includes('pid=,rss=,comm=') ? { exitCode: 0, stdout: PS_RSS } : { exitCode: 1, stdout: '' })

const HOT = swap(() => 9)
const COLD = swap(() => 0)

describe('the Beszel source', () => {
  test('a swap breach on the mini files one Issue with numbers and the top processes; later passes file nothing', async () => {
    const hub = setup({ run: psFake })
    hub.serve('MacMini', 60, HOT)
    await hub.pass()
    const [issue, ...rest] = await rows('issues')
    expect(rest).toEqual([])
    expect(issue).toMatchObject({ source: 'beszel', repo: DOTFILES, title: 'macmini: swap above 8 GB' })
    expect(issue?.facts).toMatchObject({
      source: 'beszel',
      monitor: 'macmini:swap',
      status: 'down',
      details: {
        system: 'macmini',
        rule: 'swap',
        numbers: { latest: 9, windowMax: 9, threshold: 8 },
        thresholds: { usedGb: 8, sustainMin: 10 },
        systemInfo: { status: 'up', threads: 8, cores: 8, uptime: 5000 },
      },
    })
    const details = issue?.facts.details
    expect(details.numbers.minutesSustained).toBeGreaterThanOrEqual(10)
    expect(details.processes).toHaveLength(5)
    expect(details.processes[0]).toEqual({
      pid: 200,
      rssMb: 8789.1,
      command: '/Applications/Big.app/Contents/MacOS/Big',
    })
    expect(details.tail.length).toBeGreaterThan(5)
    expect(details.tail[0]).toHaveLength(2)
    await hub.pass()
    await hub.pass()
    expect(await rows('issues')).toHaveLength(1)
    expect(await rows('issue_inbox')).toEqual([])
  })

  test('a recovery attaches an up, a later re-breach attaches a regression down to the same Issue', async () => {
    const hub = setup({ run: psFake })
    hub.serve('MacMini', 60, HOT)
    await hub.pass()
    hub.serve('MacMini', 60, COLD)
    await hub.pass()
    await hub.pass()
    let inbox = await rows('issue_inbox')
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({ kind: 'signal', payload: { status: 'up', regression: false } })
    hub.serve('MacMini', 60, HOT)
    await hub.pass()
    inbox = await rows('issue_inbox')
    expect(inbox).toHaveLength(2)
    expect(inbox[1]).toMatchObject({ kind: 'signal', payload: { status: 'down', regression: true } })
    expect(await rows('issues')).toHaveLength(1)
  })

  test('a closed Issue younger than refileAfterMin is not refiled, an older one is', async () => {
    const hub = setup({ run: psFake })
    hub.serve('MacMini', 60, HOT)
    await hub.pass()
    await db.sql`UPDATE factory.issues SET state = 'closed', outcome = 'done', closed_at = ${clock.now()}`
    await hub.pass()
    expect(await rows('issues')).toHaveLength(1)
    clock.advance(6 * 60 * MIN)
    await hub.pass()
    expect(await rows('issues')).toHaveLength(2)
  })

  test('a failing ps leaves out processes and still files; other hosts have none', async () => {
    const hub = setup({ systems: [system('MacMini'), system('HomeLab')] })
    hub.serve('MacMini', 60, HOT)
    hub.serve('HomeLab', 60, HOT)
    await hub.pass()
    const issues = await rows('issues')
    expect(issues).toHaveLength(2)
    for (const issue of issues) expect(issue.facts.details).not.toHaveProperty('processes')
    expect(issues.map((i) => i.repo).sort()).toEqual([DOTFILES, HOMELAB].sort())
  })

  test('a host not in the config and a paused system file nothing; the unknown one is logged once', async () => {
    const hub = setup({ systems: [system('Other'), system('MacMini', { status: 'paused' })] })
    hub.serve('Other', 60, HOT)
    hub.serve('MacMini', 60, HOT)
    await hub.pass()
    await hub.pass()
    expect(await rows('issues')).toEqual([])
    expect(hub.calls.some((c) => c.url.includes('system_stats'))).toBe(false)
    expect(logged.filter((l) => String(l[0]).includes('not in config/infra.json'))).toHaveLength(1)
  })

  test('the series request is filtered by system and type, with the token as sent by the hub', async () => {
    const hub = setup()
    hub.serve('MacMini', 60, COLD)
    await hub.pass()
    const call = hub.calls.find((c) => c.url.includes('system_stats'))
    expect(call?.url).toBe(
      'https://hub.example.com/api/collections/system_stats/records?filter=system%3D%22idmacmini%22%26%26type%3D%221m%22&sort=-created&perPage=240&fields=created,stats',
    )
    expect(call?.auth).toBe('token-1')
  })

  test('a 401 authenticates once more and retries', async () => {
    const hub = setup()
    hub.serve('MacMini', 60, HOT)
    await hub.pass()
    expect(hub.authCalls).toBe(1)
    hub.revoke()
    await hub.pass()
    expect(hub.authCalls).toBe(2)
    expect(hub.calls.filter((c) => c.url.includes('/systems/')).at(-1)?.auth).toBe('token-2')
  })

  test('a hub failure files nothing and logs neither token nor password', async () => {
    const hub = setup({
      answer: (url) => (url.includes('auth-with-password') ? new Response('{"x":1}', { status: 500 }) : undefined),
    })
    hub.serve('MacMini', 60, HOT)
    await hub.pass()
    expect(await rows('issues')).toEqual([])
    expect(logged).toContainEqual(['beszel intake', { step: 'systems', status: 500 }])
    const down = setup({
      answer: (url) => (url.includes('/systems/') ? new Response('secret body', { status: 503 }) : undefined),
    })
    await down.pass()
    expect(await rows('issues')).toEqual([])
    const text = JSON.stringify(logged)
    for (const secret of [PASSWORD, 'token-1', 'secret body', 'hub-user']) expect(text).not.toContain(secret)
  })

  test('without a URL the source is off with one line and nothing is fetched', async () => {
    const hub = setup({ url: undefined })
    await hub.pass()
    expect(hub.calls).toEqual([])
    expect(logged).toHaveLength(1)
    expect(String(logged[0]?.[0])).toContain('beszel intake is off')
  })

  test('a repo under IuRoot is refused and nothing is filed', async () => {
    const hub = setup({ sourceRoot: IU_ROOT })
    hub.serve('MacMini', 60, HOT)
    await hub.pass()
    expect(await rows('issues')).toEqual([])
    expect(logged.length).toBeGreaterThan(0)
  })

  test('the first pass waits 30 s', async () => {
    const hub = setup()
    hub.intake.kick()
    await hub.intake.settled()
    expect(hub.calls).toHaveLength(0)
    clock.advance(30_000)
    hub.intake.kick()
    await hub.intake.settled()
    expect(hub.calls.length).toBeGreaterThan(0)
  })
})
