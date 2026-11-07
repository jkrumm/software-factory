import { join } from 'node:path'
import { cleanText, MAX_TITLE_CHARS, storable } from '@software-factory/contract'
import type { SQL } from 'bun'
import { z } from 'zod'
import { childEnv, runProcess } from '../exec.ts'
import { vetIntakeRepo } from '../issues/create.ts'
import { fileSignalIn, type Signal } from '../issues/signals.ts'
import { RepoRefused } from '../repos.ts'
import { evaluate, type Finding, RULE_METRIC, type RuleName, type Sample, type SystemView } from './beszel-rules.ts'
import type { HostRule, Infra } from './infra.ts'

/** The first pass comes this long after boot, so the tick's first minute is not shared with the network. */
const FIRST_PASS_MS = 30_000
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

export interface BeszelIntakeDeps {
  sql: SQL
  now: () => Date
  roots: readonly string[]
  /** the directory `repo` names of `config/infra.json` are under */
  sourceRoot: string
  infra: Infra
  /** `FACTORY_BESZEL_URL`, `_EMAIL`, `_PASSWORD`; without all three the source is off */
  url: string | undefined
  email: string | undefined
  password: string | undefined
  /** the spacing of two passes (`FACTORY_BESZEL_POLL`) */
  everyMs: number
  /** the tests' fakes */
  fetch?: typeof fetch
  run?: typeof runProcess
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

/** The hub failed in a way worth one line: the status or what kind of failure, never a body. */
class HubError extends Error {
  constructor(readonly status: number | string) {
    super(`hub ${status}`)
  }
}

const errorOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
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

interface Episode {
  issue: number
  state: string
  createdAt: Date
}

interface Process {
  pid: number
  command: string
  rssMb?: number
  cpu?: number
}

/**
 * The Beszel source (design §4 "Beszel"): the hub is polled for the systems named in `config/infra.json`, `beszel-rules.ts` judges each
 * one's minute series, and a breach or a recovery becomes a `down` or `up` signal of the episode `<system>:<rule>`. Self-paced like the
 * GitHub source; all HTTP and `ps` outside transactions, then one transaction per signal. No model.
 */
export class BeszelIntake {
  private nextAt: number
  private running: Promise<void> | undefined
  private token: string | undefined
  private readonly sent = new Map<string, 'down' | 'up'>()
  private readonly unknownLogged = new Set<string>()

  constructor(private readonly deps: BeszelIntakeDeps) {
    this.nextAt = deps.now().getTime() + FIRST_PASS_MS
    if (!this.enabled()) {
      console.error('beszel intake is off: FACTORY_BESZEL_URL, FACTORY_BESZEL_EMAIL or FACTORY_BESZEL_PASSWORD not set')
    }
  }

  private enabled(): boolean {
    return Boolean(this.deps.url && this.deps.email && this.deps.password)
  }

  kick(): void {
    if (!this.enabled() || this.running) return
    const at = this.deps.now().getTime()
    if (at < this.nextAt) return
    this.nextAt = at + this.deps.everyMs
    this.running = this.pass()
      .catch((error: unknown) => console.error('beszel intake', { error: errorOf(error) }))
      .finally(() => {
        this.running = undefined
      })
  }

  async settled(): Promise<void> {
    await this.running
  }

  private async authenticate(): Promise<string> {
    const response = await (this.deps.fetch ?? fetch)(`${this.base()}/api/collections/users/auth-with-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'software-factory' },
      body: JSON.stringify({ identity: this.deps.email, password: this.deps.password }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    if (response.status !== 200) throw new HubError(response.status)
    const body = z.object({ token: z.string().min(1) }).safeParse(await response.json())
    if (!body.success) throw new HubError('unparsable')
    return body.data.token
  }

  private base(): string {
    return (this.deps.url ?? '').replace(/\/+$/, '')
  }

  /** A GET with the cached token; a 401 authenticates once more and retries once. */
  private async get(path: string): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      this.token ??= await this.authenticate()
      const response = await (this.deps.fetch ?? fetch)(`${this.base()}${path}`, {
        headers: { Authorization: this.token, 'User-Agent': 'software-factory' },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      if (response.status === 401 && attempt === 0) {
        this.token = undefined
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

  private async fetchOrLog<T>(step: string, path: string, schema: z.ZodType<T>): Promise<T | undefined> {
    try {
      const parsed = schema.safeParse(await this.get(path))
      if (parsed.success) return parsed.data
      console.error('beszel intake', { step, status: 'unparsable' })
    } catch (error) {
      console.error('beszel intake', { step, status: error instanceof HubError ? error.status : 'error' })
    }
    return undefined
  }

  private async episodes(): Promise<Map<string, Episode>> {
    const rows: { monitor: string; issue_id: number; state: string; created_at: Date }[] = await this.deps.sql`
      SELECT DISTINCT ON (d.monitor) d.monitor, d.issue_id, i.state, i.created_at
      FROM factory.door_issues d JOIN factory.issues i ON i.id = d.issue_id
      WHERE d.source = 'beszel' ORDER BY d.monitor, d.issue_id DESC`
    return new Map(rows.map((r) => [r.monitor, { issue: r.issue_id, state: r.state, createdAt: r.created_at }]))
  }

  private async pass(): Promise<void> {
    const episodes = await this.episodes()
    const systems = await this.fetchOrLog('systems', '/api/collections/systems/records?perPage=100', Systems)
    if (!systems) return
    const signals: { signal: Signal; subject: string; status: 'down' | 'up' }[] = []
    const ps = new Map<string, Promise<Process[] | undefined>>()
    for (const item of systems.items) {
      const name = item.name.toLowerCase()
      if (item.status === 'paused') continue
      const host = this.deps.infra.hosts.get(name)
      if (!host) {
        if (!this.unknownLogged.has(name)) {
          this.unknownLogged.add(name)
          console.error('beszel intake: a system is not in config/infra.json and files nothing', { system: name })
        }
        continue
      }
      if (!ID.test(item.id)) continue
      const filter = encodeURIComponent(`system="${item.id}"&&type="1m"`)
      const series = await this.fetchOrLog(
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
      const now = this.deps.now()
      for (const finding of evaluate(samples, view, host.thresholds, now)) {
        if (finding.state === 'hold') continue
        const subject = `${name}:${finding.rule}`
        const status = finding.state === 'breach' ? 'down' : 'up'
        if (!this.shouldSend(subject, status, episodes.get(subject), now)) continue
        const signal = await this.signalOf({ item, view, host, finding, samples, subject, status, now, ps })
        if (signal) signals.push({ signal, subject, status })
      }
    }
    for (const { signal, subject, status } of signals) {
      try {
        await this.deps.sql.begin((tx) =>
          fileSignalIn(tx, signal, { repoRoots: this.deps.roots, now: this.deps.now() }),
        )
        this.sent.set(subject, status)
      } catch (error) {
        console.error('beszel intake', { subject, error: errorOf(error) })
      }
    }
  }

  private shouldSend(subject: string, status: 'down' | 'up', latest: Episode | undefined, now: Date): boolean {
    const open = latest !== undefined && latest.state !== 'closed'
    if (status === 'up') return open && this.sent.get(subject) !== 'up'
    if (open) return this.sent.get(subject) !== 'down'
    // A lead that closed it while still hot is not pestered again at once.
    return !latest || now.getTime() - latest.createdAt.getTime() >= this.deps.infra.refileAfterMin * MIN
  }

  private async signalOf(c: {
    item: z.infer<typeof Systems>['items'][number]
    view: SystemView
    host: HostRule
    finding: Finding
    samples: Sample[]
    subject: string
    status: 'down' | 'up'
    now: Date
    ps: Map<string, Promise<Process[] | undefined>>
  }): Promise<Signal | undefined> {
    const { finding, view, host, now } = c
    const at = c.status === 'down' ? finding.since : finding.recovered
    const event = `${c.status}@${minuteOf(at ?? now)}`
    const repo = join(this.deps.sourceRoot, host.repo)
    try {
      await vetIntakeRepo('beszel', repo, this.deps.roots)
    } catch (error) {
      if (!(error instanceof RepoRefused)) throw error
      console.error('beszel intake', { subject: c.subject, error: errorOf(error) })
      return undefined
    }
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
    const processes = c.status === 'down' && host.local ? await this.processesFor(finding.rule, c.ps) : {}
    const title = cleanText(`${view.name}: ${finding.label}`.slice(0, MAX_TITLE_CHARS)) || c.subject
    return {
      source: 'beszel',
      subject: c.subject,
      event,
      status: c.status,
      title,
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
      repo,
    }
  }

  /** The top processes right now, for the rules where a process is the answer; a failing `ps` is no key. */
  private async processesFor(
    rule: RuleName,
    cache: Map<string, Promise<Process[] | undefined>>,
  ): Promise<Record<string, Process[]>> {
    if (rule === 'memory' || rule === 'swap' || rule === 'swap_growth') {
      const top = await this.top(cache, 'rss')
      return top ? { processes: top } : {}
    }
    if (rule === 'load') {
      const top = await this.top(cache, 'cpu')
      return top ? { processesByCpu: top } : {}
    }
    return {}
  }

  private top(cache: Map<string, Promise<Process[] | undefined>>, by: 'rss' | 'cpu'): Promise<Process[] | undefined> {
    const cached = cache.get(by)
    if (cached) return cached
    const read = this.readPs(by)
    cache.set(by, read)
    return read
  }

  private async readPs(by: 'rss' | 'cpu'): Promise<Process[] | undefined> {
    const run = this.deps.run ?? runProcess
    try {
      const done = await run(
        ['ps', '-Axo', by === 'rss' ? 'pid=,rss=,comm=' : 'pid=,pcpu=,comm='],
        PS_TIMEOUT_MS,
        childEnv(),
      )
      if (done.exitCode !== 0) return undefined
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
}
