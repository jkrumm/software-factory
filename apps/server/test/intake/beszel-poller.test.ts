import { describe, expect, test } from 'bun:test'
import { beszelPoller } from '../../src/adapters/intake/beszel.ts'
import type { ProcessResult } from '../../src/adapters/intake/process.ts'
import { type Infra, parseInfra } from '../../src/domains/intake/infra.ts'
import type { Received } from '../../src/domains/intake/model.ts'
import type { IntakeSink, SubjectState } from '../../src/domains/intake/ports.ts'
import { fixedClock } from '../../src/kernel/clock.ts'
import { err, ok, portError } from '../../src/kernel/result.ts'

const PASSWORD = 'hub-password-value'
const GIB = 1024 ** 3
const MIN = 60_000

const INFRA: Infra = parseInfra(
  JSON.stringify({ hosts: { macmini: { repo: 'dotfiles', local: true }, homelab: { repo: 'homelab' } } }),
)

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

const HOT = swap(() => 9)
const COLD = swap(() => 0)

const PS_RSS = [
  '  100  2048 /sbin/launchd',
  '  200  9000000 /Applications/Big.app/Contents/MacOS/Big',
  '  300  512000 /usr/bin/node',
  '  400  100 /bin/a',
  '  500  4096000 /bin/b',
  '  600  300000 /bin/c',
  '  700  150000 /bin/d',
].join('\n')
const psFake = (command: readonly string[]): Promise<ProcessResult> =>
  Promise.resolve(command.includes('pid=,rss=,comm=') ? { exit: 0, stdout: PS_RSS } : { exit: 1, stdout: '' })

function setup(
  options: {
    systems?: (make: (name: string, extra?: Record<string, unknown>) => unknown) => unknown[]
    url?: string | null
    run?: (command: readonly string[]) => Promise<ProcessResult>
    answer?: (url: string) => Response | undefined
    subjects?: SubjectState[]
    receive?: 'fail'
    subjectsFail?: boolean
  } = {},
) {
  const clock = fixedClock('2026-11-07T12:00:00.000Z')
  const calls: { url: string; auth: string | null }[] = []
  const logged: string[] = []
  const received: Received[] = []
  const revoked = new Set<string>()
  const series = new Map<string, { count: number; shape: Shape }>()
  const state = { authCalls: 0, episodes: options.subjects ?? [] }
  const system = (name: string, extra: Record<string, unknown> = {}) => ({
    id: `id${name.toLowerCase()}`,
    name,
    status: 'up',
    info: { t: 8, c: 8, u: 5000 },
    updated: clock.now().toISOString().replace('T', ' '),
    ...extra,
  })
  const items = options.systems?.(system) ?? [system('MacMini')]

  const fetchFake = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const text = String(url)
    const auth = new Headers(init?.headers).get('Authorization')
    calls.push({ url: text, auth })
    const forced = options.answer?.(text)
    if (forced) return Promise.resolve(forced)
    if (text.endsWith('/api/collections/users/auth-with-password')) {
      state.authCalls++
      return Promise.resolve(Response.json({ token: `token-${state.authCalls}` }))
    }
    if (!auth || revoked.has(auth)) return Promise.resolve(new Response('no', { status: 401 }))
    if (text.includes('/collections/systems/records')) return Promise.resolve(Response.json({ items }))
    const id = /system%3D%22(\w+)%22/.exec(text)?.[1] ?? ''
    const wanted = series.get(id)
    const rows = Array.from({ length: wanted?.count ?? 0 }, (_, m) => ({
      created: new Date(clock.now().getTime() - m * MIN).toISOString().replace('T', ' '),
      stats: wanted?.shape(m),
    }))
    return Promise.resolve(Response.json({ items: rows }))
  }) as typeof fetch

  const sink: IntakeSink = {
    receive(value) {
      received.push(value)
      if (options.receive === 'fail') return Promise.resolve(err(portError('unreadable', 'store down')))
      return Promise.resolve(ok({ outcome: 'filed', detail: 'new', issue: null, signal: null, reason: null }))
    },
    subjects: () => Promise.resolve(options.subjectsFail ? err(portError('timeout', 'slow')) : ok(state.episodes)),
    pendingWritebacks: () => Promise.resolve(ok([])),
    wroteBack: () => Promise.resolve(ok(undefined)),
  }
  const poller = beszelPoller({
    sink,
    clock,
    infra: INFRA,
    url: 'url' in options ? (options.url ?? null) : 'https://hub.example.com/',
    email: 'hub-user',
    password: PASSWORD,
    fetch: fetchFake,
    run: options.run ?? (() => Promise.resolve({ exit: 1, stdout: '' })),
    log: (line) => logged.push(line),
  })
  return {
    poller,
    clock,
    calls,
    logged,
    received,
    get authCalls() {
      return state.authCalls
    },
    revoke: () => revoked.add(`token-${state.authCalls}`),
    serve: (name: string, count: number, shape: Shape) => series.set(system(name).id, { count, shape }),
    setEpisodes: (next: SubjectState[]) => {
      state.episodes = next
    },
    /** one pass a minute after the last */
    pass: async () => {
      clock.advance(MIN)
      await poller.pass()
    },
    system,
  }
}

const episode = (open: boolean, since: Date, subject = 'macmini:swap'): SubjectState => ({ subject, open, since })

describe('the Beszel source', () => {
  test('a swap breach on the mini is one down alert with numbers, the tail and the top processes', async () => {
    const hub = setup({ run: psFake })
    hub.serve('MacMini', 60, HOT)
    await hub.pass()
    const swapAlerts = hub.received.filter((r) => r.alert?.subject === 'macmini:swap')
    expect(swapAlerts).toHaveLength(1)
    const [first] = swapAlerts
    expect(first?.signal).toMatchObject({
      source: 'beszel',
      kind: 'alert',
      origin: 'infrastructure',
      trust: 'machine',
      repo: 'dotfiles',
      title: 'macmini: swap above 8 GB',
      link: null,
      madeBy: null,
    })
    expect(first?.signal.text.length).toBeGreaterThan(0)
    expect(first?.alert?.status).toBe('down')
    expect(first?.alert?.event).toMatch(/^down@2026-11-07T1\d:\d\d$/)
    const facts = first?.alert?.facts as {
      system: string
      rule: string
      numbers: Record<string, number>
      thresholds: unknown
      systemInfo: unknown
      processes: unknown[]
      tail: unknown[][]
    }
    expect(facts).toMatchObject({
      system: 'macmini',
      rule: 'swap',
      numbers: { latest: 9, windowMax: 9, threshold: 8 },
      thresholds: { usedGb: 8, sustainMin: 10 },
      systemInfo: { status: 'up', threads: 8, cores: 8, uptime: 5000 },
    })
    expect(facts.numbers.minutesSustained).toBeGreaterThanOrEqual(10)
    expect(facts.processes).toHaveLength(5)
    expect(facts.processes[0]).toEqual({ pid: 200, rssMb: 8789.1, command: '/Applications/Big.app/Contents/MacOS/Big' })
    expect(facts.tail.length).toBeGreaterThan(5)
    expect(facts.tail[0]).toHaveLength(2)
  })

  test('the same breach again while its subject is open sends nothing', async () => {
    const hub = setup({ run: psFake })
    hub.serve('MacMini', 60, HOT)
    await hub.pass()
    const count = hub.received.length
    expect(count).toBeGreaterThan(0)
    hub.setEpisodes([episode(true, hub.clock.now())])
    await hub.pass()
    await hub.pass()
    expect(hub.received.filter((r) => r.alert?.subject === 'macmini:swap')).toHaveLength(1)
  })

  test('a recovery sends one up for an open subject, a re-breach sends a down again', async () => {
    const hub = setup({ run: psFake })
    hub.serve('MacMini', 60, HOT)
    await hub.pass()
    hub.setEpisodes([episode(true, hub.clock.now())])
    hub.serve('MacMini', 60, COLD)
    await hub.pass()
    await hub.pass()
    const swapStatuses = () =>
      hub.received.filter((r) => r.alert?.subject === 'macmini:swap').map((r) => r.alert?.status)
    expect(swapStatuses()).toEqual(['down', 'up'])
    const up = hub.received.filter((r) => r.alert?.status === 'up')[0]
    expect(up?.alert?.event).toMatch(/^up@/)
    hub.serve('MacMini', 60, HOT)
    await hub.pass()
    expect(swapStatuses()).toEqual(['down', 'up', 'down'])
  })

  test('a recovery of a subject with no open Issue sends nothing', async () => {
    const hub = setup({ subjects: [episode(false, new Date('2026-11-07T00:00:00Z'))] })
    hub.serve('MacMini', 60, COLD)
    await hub.pass()
    expect(hub.received).toEqual([])
  })

  test('a closed Issue younger than refileAfterMin is not refiled, an older one is', async () => {
    const hub = setup({ run: psFake })
    hub.serve('MacMini', 60, HOT)
    hub.setEpisodes([episode(false, new Date(hub.clock.now().getTime() - 5 * MIN))])
    await hub.pass()
    expect(hub.received).toEqual([])
    hub.clock.advance(6 * 60 * MIN)
    await hub.pass()
    expect(hub.received.filter((r) => r.alert?.subject === 'macmini:swap')).toHaveLength(1)
  })

  test('a failing ps leaves out processes and still files; other hosts have none', async () => {
    const hub = setup({ systems: (make) => [make('MacMini'), make('HomeLab')] })
    hub.serve('MacMini', 60, HOT)
    hub.serve('HomeLab', 60, HOT)
    await hub.pass()
    const swapAlerts = hub.received.filter((r) => r.alert?.subject.endsWith(':swap'))
    expect(swapAlerts.map((r) => r.signal.repo).sort()).toEqual(['dotfiles', 'homelab'])
    for (const r of swapAlerts) expect(r.alert?.facts).not.toHaveProperty('processes')
  })

  test('other hosts get no ps even when it works', async () => {
    const hub = setup({ systems: (make) => [make('HomeLab')], run: psFake })
    hub.serve('HomeLab', 60, HOT)
    await hub.pass()
    expect(hub.received.length).toBeGreaterThan(0)
    for (const r of hub.received) expect(r.alert?.facts).not.toHaveProperty('processes')
  })

  test('a host not in the config and a paused system file nothing; the unknown one is logged once', async () => {
    const hub = setup({ systems: (make) => [make('Other'), make('MacMini', { status: 'paused' })] })
    hub.serve('Other', 60, HOT)
    hub.serve('MacMini', 60, HOT)
    await hub.pass()
    await hub.pass()
    expect(hub.received).toEqual([])
    expect(hub.calls.some((c) => c.url.includes('system_stats'))).toBe(false)
    expect(hub.logged.filter((line) => line.includes('not in config/infra.json'))).toHaveLength(1)
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
    expect(hub.received).toEqual([])
    expect(hub.logged).toEqual(['beszel intake: systems 500'])
    const down = setup({
      answer: (url) => (url.includes('/systems/') ? new Response('secret body', { status: 503 }) : undefined),
    })
    await down.pass()
    expect(down.received).toEqual([])
    const text = [...hub.logged, ...down.logged].join('\n')
    for (const secret of [PASSWORD, 'token-1', 'secret body', 'hub-user']) expect(text).not.toContain(secret)
  })

  test('without a URL the source is off with one line and nothing is fetched', async () => {
    const hub = setup({ url: null })
    await hub.pass()
    expect(hub.poller.enabled).toBe(false)
    expect(hub.calls).toEqual([])
    expect(hub.logged).toHaveLength(1)
    expect(hub.logged[0]).toContain('beszel intake is off')
  })

  test('a sink that cannot file is one line, and the finding is sent again next pass', async () => {
    const hub = setup({ receive: 'fail' })
    hub.serve('MacMini', 60, HOT)
    await hub.pass()
    const first = hub.received.length
    expect(hub.logged.filter((line) => line.includes('macmini:swap not filed (unreadable)'))).toHaveLength(1)
    await hub.pass()
    expect(hub.received.length).toBe(first * 2)
  })

  test('when the episodes cannot be read nothing is fetched or sent', async () => {
    const hub = setup({ subjectsFail: true })
    hub.serve('MacMini', 60, HOT)
    await hub.pass()
    expect(hub.calls).toEqual([])
    expect(hub.received).toEqual([])
    expect(hub.logged).toEqual(['beszel intake: episodes unknown (timeout)'])
  })
})
