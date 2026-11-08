import { cleanText, MAX_TITLE_CHARS, storable } from '@software-factory/contract'
import * as z from 'zod'
import { evaluate, RULE_METRIC } from '../../domains/intake/beszel-rules.ts'
import type { Finding, RuleName, Sample, SystemView } from '../../domains/intake/beszel-rules.ts'
import type { HostRule, Infra } from '../../domains/intake/infra.ts'
import type { Received } from '../../domains/intake/model.ts'
import type { IntakeSink, SubjectState } from '../../domains/intake/ports.ts'
import type { Clock } from '../../kernel/clock.ts'
import { runProcess } from './process.ts'
import type { RunProcess } from './process.ts'

const HTTP_TIMEOUT_MS = 15_000
const PS_TIMEOUT_MS = 5_000
const SERIES_PER_PAGE = 240
const TAIL_MIN = 60
const TAIL_EVERY = 5
const TOP_PROCESSES = 5
const MAX_COMMAND_CHARS = 120
const GIB = 1024 ** 3
const MIN = 60_000
const ID = /^[A-Za-z0-9]+$/

export interface BeszelPollerDeps {
  sink: IntakeSink
  clock: Clock
  infra: Infra
  /** `FACTORY_BESZEL_URL`, `_EMAIL`, `_PASSWORD`; without all three the source is off */
  url: string | null
  email: string | null
  password: string | null
  run?: RunProcess
  fetch?: typeof fetch
  log?: (line: string) => void
}

const Systems = z.object({
  items: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      status: z.string().nullish(),
      updated: z.string().nullish(),
      info: z.looseObject({ t: z.number().nullish(), c: z.number().nullish(), u: z.number().nullish() }).nullish(),
    }),
  ),
})

const num = z.number().nullish()
const Series = z.object({
  items: z.array(
    z.looseObject({
      created: z.string(),
      stats: z
        .looseObject({
          mp: num,
          mu: num,
          m: num,
          s: num,
          su: num,
          swap: z.array(z.number()).nullish(),
          d: num,
          du: num,
          dp: num,
          la: z.array(z.number()).nullish(),
        })
        .nullish(),
    }),
  ),
})

type SystemItem = z.infer<typeof Systems>['items'][number]

/** The hub failed in a way worth one line: the status or what kind of failure, never a body. */
class HubError extends Error {
  constructor(readonly status: number | string) {
    super(`hub ${status}`)
  }
}

const minuteOf = (at: Date): string => at.toISOString().slice(0, 16)

/** PocketBase writes "2024-01-01 12:00:00.000Z". */
function parseTime(text: string): Date | null {
  const at = new Date(text.replace(' ', 'T'))
  return Number.isNaN(at.getTime()) ? null : at
}

/** A sample counts once it has `mp` or `dp`; the hub omits zeros, so no swap fields is no swap. */
function toSample(item: z.infer<typeof Series>['items'][number]): Sample | null {
  const at = parseTime(item.created)
  const s = item.stats
  if (!at || !s || (s.mp == null && s.dp == null)) return null
  const swap = s.swap
  const swapTotalGb = swap?.[0] !== undefined ? swap[0] / GIB : (s.s ?? 0)
  const swapUsedGb = swap?.[1] !== undefined ? swap[1] / GIB : (s.su ?? 0)
  return {
    at,
    memPct: s.mp ?? (s.m && s.mu != null ? (s.mu / s.m) * 100 : null),
    swapUsedGb,
    swapTotalGb,
    diskPct: s.dp ?? (s.d && s.du != null ? (s.du / s.d) * 100 : null),
    diskUsedGb: s.du ?? null,
    diskTotalGb: s.d ?? null,
    load1: s.la?.[0] ?? null,
  }
}

interface Process {
  pid: number
  command: string
  rssMb?: number
  cpu?: number
}

/**
 * The Beszel source: the hub is polled for the systems named in `config/infra.json`, `beszel-rules.ts` judges each one's
 * minute series, and a breach or a recovery becomes a `down` or `up` of the subject `<system>:<rule>`. All HTTP and `ps`
 * happen before a signal is handed over; no model.
 */
export function beszelPoller(deps: BeszelPollerDeps): { enabled: boolean; pass(): Promise<void> } {
  const log = deps.log ?? ((line: string) => console.error(line))
  const { url, email, password } = deps
  const enabled = Boolean(url && email && password)
  if (!enabled) log('beszel intake is off: FACTORY_BESZEL_URL, FACTORY_BESZEL_EMAIL or FACTORY_BESZEL_PASSWORD not set')
  const base = (url ?? '').replace(/\/+$/, '')
  const doFetch = deps.fetch ?? fetch
  const run = deps.run ?? runProcess
  let token: string | undefined
  /** what was last sent for a subject, so a pass that sees the same finding again sends nothing */
  const sent = new Map<string, 'down' | 'up'>()
  const unknownLogged = new Set<string>()

  async function authenticate(): Promise<string> {
    const response = await doFetch(`${base}/api/collections/users/auth-with-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'software-factory' },
      body: JSON.stringify({ identity: email, password }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    if (response.status !== 200) throw new HubError(response.status)
    const body = z.object({ token: z.string().min(1) }).safeParse(await response.json())
    if (!body.success) throw new HubError('unparsable')
    return body.data.token
  }

  /** A GET with the cached token; a 401 authenticates once more and retries once. */
  async function get(path: string): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      token ??= await authenticate()
      const response = await doFetch(`${base}${path}`, {
        headers: { Authorization: token, 'User-Agent': 'software-factory' },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      if (response.status === 401 && attempt === 0) {
        token = undefined
        continue
      }
      if (response.status !== 200) throw new HubError(response.status)
      try {
        return await response.json()
      } catch {
        throw new HubError('unparsable')
      }
    }
    throw new HubError(401)
  }

  async function fetchOrLog<T>(step: string, path: string, schema: z.ZodType<T>): Promise<T | undefined> {
    try {
      const parsed = schema.safeParse(await get(path))
      if (parsed.success) return parsed.data
      log(`beszel intake: ${step} unparsable`)
    } catch (error) {
      log(`beszel intake: ${step} ${error instanceof HubError ? error.status : 'error'}`)
    }
    return undefined
  }

  function shouldSend(subject: string, status: 'down' | 'up', latest: SubjectState | undefined, now: Date): boolean {
    const open = latest?.open === true
    if (status === 'up') return open && sent.get(subject) !== 'up'
    if (open) return sent.get(subject) !== 'down'
    // A lead that closed it while still hot is not pestered again at once.
    return !latest || now.getTime() - latest.since.getTime() >= deps.infra.refileAfterMin * MIN
  }

  async function readPs(by: 'rss' | 'cpu'): Promise<Process[] | undefined> {
    try {
      const done = await run(['ps', '-Axo', by === 'rss' ? 'pid=,rss=,comm=' : 'pid=,pcpu=,comm='], PS_TIMEOUT_MS)
      if (done.exit !== 0) return undefined
      const rows: { pid: number; value: number; command: string }[] = []
      for (const line of done.stdout.split('\n')) {
        const found = /^\s*(\d+)\s+([\d.]+)\s+(.+?)\s*$/.exec(line)
        if (!found) continue
        rows.push({
          pid: Number(found[1]),
          value: Number(found[2]),
          command: (found[3] as string).slice(0, MAX_COMMAND_CHARS),
        })
      }
      return rows
        .sort((a, b) => b.value - a.value)
        .slice(0, TOP_PROCESSES)
        .map((r) =>
          by === 'rss'
            ? { pid: r.pid, rssMb: Math.round((r.value / 1024) * 10) / 10, command: r.command }
            : { pid: r.pid, cpu: r.value, command: r.command },
        )
    } catch {
      return undefined
    }
  }

  /** The top processes right now, for the rules where a process is the answer; a failing `ps` is no key. */
  async function processesFor(rule: RuleName, cache: Map<string, Promise<Process[] | undefined>>) {
    const by = rule === 'memory' || rule === 'swap' || rule === 'swap_growth' ? 'rss' : rule === 'load' ? 'cpu' : null
    if (by === null) return {}
    const cached = cache.get(by) ?? readPs(by)
    cache.set(by, cached)
    const top = await cached
    if (!top) return {}
    return by === 'rss' ? { processes: top } : { processesByCpu: top }
  }

  async function receivedOf(c: {
    item: SystemItem
    view: SystemView
    host: HostRule
    finding: Finding
    samples: Sample[]
    subject: string
    status: 'down' | 'up'
    now: Date
    ps: Map<string, Promise<Process[] | undefined>>
  }): Promise<Received> {
    const { finding, view, host, now } = c
    const at = c.status === 'down' ? finding.since : finding.recovered
    const metric = RULE_METRIC[finding.rule]
    const tail = metric
      ? c.samples
          .filter((s) => s.at.getTime() > now.getTime() - TAIL_MIN * MIN)
          .reverse()
          .filter((_, i) => i % TAIL_EVERY === 0)
          .reverse()
          .map((s): [string, number | null] => [minuteOf(s.at), metric(s)])
      : []
    const info = c.item.info
    const processes = c.status === 'down' && host.local ? await processesFor(finding.rule, c.ps) : {}
    return {
      signal: {
        source: 'beszel',
        kind: 'alert',
        origin: 'infrastructure',
        trust: 'machine',
        repo: host.repo,
        fingerprint: `beszel:${c.subject}`,
        title: cleanText(`${view.name}: ${finding.label}`.slice(0, MAX_TITLE_CHARS)) || c.subject,
        text: cleanText(finding.summary),
        link: null,
        madeBy: null,
        probe: false,
      },
      alert: {
        subject: c.subject,
        event: `${c.status}@${minuteOf(at ?? now)}`,
        status: c.status,
        facts: storable({
          system: view.name,
          rule: finding.rule,
          summary: finding.summary,
          numbers: finding.numbers,
          thresholds: host.thresholds[finding.rule],
          tail,
          systemInfo: {
            status: view.status,
            ...(info?.c != null ? { cores: info.c } : {}),
            ...(info?.t != null ? { threads: info.t } : {}),
            ...(info?.u != null ? { uptime: info.u } : {}),
          },
          ...processes,
        }),
      },
    }
  }

  async function pass(): Promise<void> {
    if (!enabled) return
    const known = await deps.sink.subjects('beszel', '')
    if (!known.ok) {
      log(`beszel intake: episodes unknown (${known.error.kind})`)
      return
    }
    const episodes = new Map(known.value.map((state) => [state.subject, state]))
    const systems = await fetchOrLog('systems', '/api/collections/systems/records?perPage=100', Systems)
    if (!systems) return
    const outgoing: { received: Received; subject: string; status: 'down' | 'up' }[] = []
    const ps = new Map<string, Promise<Process[] | undefined>>()
    for (const item of systems.items) {
      const name = item.name.toLowerCase()
      if (item.status === 'paused') continue
      const host = deps.infra.hosts.get(name)
      if (!host) {
        if (!unknownLogged.has(name)) {
          unknownLogged.add(name)
          log(`beszel intake: system ${cleanText(name).slice(0, 80)} is not in config/infra.json and files nothing`)
        }
        continue
      }
      if (!ID.test(item.id)) continue
      const filter = encodeURIComponent(`system="${item.id}"&&type="1m"`)
      const series = await fetchOrLog(
        'series',
        `/api/collections/system_stats/records?filter=${filter}&sort=-created&perPage=${SERIES_PER_PAGE}&fields=created,stats`,
        Series,
      )
      if (!series) continue
      const samples = series.items
        .map(toSample)
        .filter((s): s is Sample => s !== null)
        .sort((a, b) => a.at.getTime() - b.at.getTime())
      const view: SystemView = {
        name,
        status: item.status ?? 'pending',
        threads: item.info?.t ?? item.info?.c ?? null,
        updated: item.updated ? parseTime(item.updated) : null,
      }
      const now = deps.clock.now()
      for (const finding of evaluate(samples, view, host.thresholds, now)) {
        if (finding.state === 'hold') continue
        const subject = `${name}:${finding.rule}`
        const status = finding.state === 'breach' ? 'down' : 'up'
        if (!shouldSend(subject, status, episodes.get(subject), now)) continue
        outgoing.push({
          received: await receivedOf({ item, view, host, finding, samples, subject, status, now, ps }),
          subject,
          status,
        })
      }
    }
    for (const { received, subject, status } of outgoing) {
      const answer = await deps.sink.receive(received)
      if (answer.ok) sent.set(subject, status)
      else log(`beszel intake: ${subject} not filed (${answer.error.kind})`)
    }
  }

  return { enabled, pass }
}
