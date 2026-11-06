import {
  AccountList,
  AskList,
  ErrorBody,
  FleetFrame,
  HealthList,
  HelloFrame,
  type Insights,
  IssueCards,
  type IssueCard,
  IssueDetail,
  IssueFrame,
  Overview,
  type ReadAsk,
  type ReadHealth,
  SessionCard,
  SessionCards,
  SessionFrame,
} from '@software-factory/contract'
import type { z } from 'zod'
import { BIN, call, DEFAULT_URL, type Io } from './client.ts'
import { FactoryError, kindForStatus, usage } from './exit.ts'

export type Format = 'json' | 'plain'

/** The flags the read verbs use; `run.ts`'s own `Flags` is a superset. */
export interface ReadFlags {
  state?: string
  limit?: string
  issue?: string
  role?: string
  live?: boolean
  since?: string
  'until-closed'?: boolean
}

const cell = (value: unknown) => (value === null || value === undefined ? '-' : String(value))
/** Prose columns are one line: a tab or a newline in model text would break the row. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (ms < 60_000) return `${Math.round(ms / 1_000)} s`
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`
}

/** `12 tool calls · 3 subagents · 1.2M tokens · 40 min working` */
export function insightsLine(i: Insights): string {
  const { input, output, cacheRead, cacheWrite } = i.tokens
  return [
    plural(i.toolCalls, 'tool call'),
    plural(i.subagents, 'subagent'),
    `${compact(input + output + cacheRead + cacheWrite)} tokens`,
    `${duration(i.workingMs)} working`,
  ].join(' · ')
}

const issueRow = (c: IssueCard) =>
  [c.id, c.state, c.repoName, oneLine(c.title), oneLine(c.summary), insightsLine(c.insights)].map(cell).join('\t')

const sessionRow = (c: SessionCard) =>
  [c.id, c.state, cell(c.role), oneLine(c.title), oneLine(c.summary), insightsLine(c.insights)].join('\t')

function issueScreen(d: IssueDetail): string {
  return [
    [d.id, d.state, d.repoName, oneLine(d.title)].join('\t'),
    oneLine(d.summary),
    insightsLine(d.insights),
    ...(d.timeline.length ? ['', 'timeline', ...d.timeline.map((t) => `${t.at}\t${t.kind}\t${oneLine(t.text)}`)] : []),
    ...(d.evidence.length
      ? ['', 'evidence', ...d.evidence.map((e) => [e.at, e.kind, cell(e.link), oneLine(e.note ?? '-')].join('\t'))]
      : []),
    ...(d.asks.length
      ? ['', 'questions', ...d.asks.map((a) => [a.askedAt, oneLine(a.question), cell(a.answer)].join('\t'))]
      : []),
    ...(d.sessions.length ? ['', 'sessions', ...d.sessions.map(sessionRow)] : []),
  ].join('\n')
}

const percent = (n: number | null) => (n === null ? '-' : `${Math.round(n)}%`)

const accountRow = (a: Overview['accounts'][number]) =>
  [
    a.account,
    `5h ${percent(a.fiveHourUsed)}`,
    `week ${percent(a.weeklyUsed)}`,
    a.exhaustedUntil ? `exhausted until ${a.exhaustedUntil}` : 'available',
    a.fresh ? 'fresh' : 'stale',
  ].join('\t')

const askRow = (a: ReadAsk) =>
  [oneLine(a.short), oneLine(a.summary), a.at, a.kind, cell(a.repo), a.stale ? 'stale' : ''].join('\t')

const healthRow = (h: ReadHealth) => [oneLine(h.short), oneLine(h.summary), h.since, h.kind, cell(h.repo)].join('\t')

function overviewScreen(o: Overview): string {
  const c = o.counts
  return [
    `${c.working} working · ${c.waiting} waiting · ${c.queued} queued · ${c.watching} watching · ${c.asks} asks · ${c.humanQueue} human queue · ${c.health} health`,
    `queue ${o.queue.effective}`,
    ...o.asks.map((a) => `ask\t${askRow(a)}`),
    ...o.humanQueue.map((a) => `human queue\t${askRow(a)}`),
    ...o.health.map((h) => `health\t${healthRow(h)}`),
    ...o.accounts.map((a) => `account\t${accountRow(a)}`),
  ].join('\n')
}

const USAGE =
  'usage: read overview|issues [--state open|closed|all] [--limit n]|issue <id>|sessions [--issue n] [--role r] [--live]|session <id>|asks|health|accounts'

const idArg = (raw: string | undefined, what: string): string => {
  if (raw === undefined || !/^[1-9]\d{0,14}$/.test(raw)) throw usage(`${what} must be a positive integer, got: ${raw}`)
  return raw
}

/** `factory read <resource> …`: GET the `/v1` route, parse the body with its schema, print it. */
export async function readVerb(words: string[], format: Format, flags: ReadFlags, io: Io): Promise<void> {
  const [, resource, target, ...extra] = words
  const get = async <S extends z.ZodType>(path: string, schema: S) =>
    (await call(io, path, { auth: true, schema })).body
  const print = (json: unknown, lines: string[]) => {
    if (format === 'json') return io.out(`${JSON.stringify(json)}\n`)
    if (lines.length) io.out(`${lines.join('\n')}\n`)
  }
  const single = ['issue', 'session'].includes(resource ?? '')
  if (extra.length || (single ? target === undefined : target !== undefined)) throw usage(USAGE)

  switch (resource) {
    case 'overview': {
      const body = await get('/v1/overview', Overview)
      return print(body, [overviewScreen(body)])
    }
    case 'issues': {
      const query = new URLSearchParams()
      if (flags.state !== undefined) {
        if (!['open', 'closed', 'all'].includes(flags.state)) throw usage('--state must be open, closed or all')
        query.set('state', flags.state)
      }
      if (flags.limit !== undefined) query.set('limit', idArg(flags.limit, '--limit'))
      const qs = query.size ? `?${query.toString()}` : ''
      const body = await get(`/v1/issues${qs}`, IssueCards)
      return print(body, body.issues.map(issueRow))
    }
    case 'issue': {
      const body = await get(`/v1/issues/${idArg(target, 'issue id')}`, IssueDetail)
      return print(body, [issueScreen(body)])
    }
    case 'sessions': {
      const query = new URLSearchParams()
      if (flags.issue !== undefined) query.set('issue', idArg(flags.issue, '--issue'))
      if (flags.role !== undefined) query.set('role', flags.role)
      if (flags.live) query.set('live', '1')
      const qs = query.size ? `?${query.toString()}` : ''
      const body = await get(`/v1/sessions${qs}`, SessionCards)
      return print(body, body.sessions.map(sessionRow))
    }
    case 'session': {
      const body = await get(`/v1/sessions/${encodeURIComponent(target ?? '')}`, SessionCard)
      return print(body, [sessionRow(body)])
    }
    case 'asks': {
      const body = await get('/v1/asks', AskList)
      return print(body, [...body.asks.map(askRow), ...body.humanQueue.map((a) => `human queue\t${askRow(a)}`)])
    }
    case 'health': {
      const body = await get('/v1/health', HealthList)
      return print(body, body.health.map(healthRow))
    }
    case 'accounts': {
      const body = await get('/v1/accounts', AccountList)
      return print(body, body.accounts.map(accountRow))
    }
    default:
      throw usage(USAGE)
  }
}

// --- follow -------------------------------------------------------------------------------------------------------

export const BACKOFF_FIRST_MS = 1_000
export const BACKOFF_MAX_MS = 15_000

interface Sse {
  event: string
  id: string | null
  data: string
}

/** Splits an SSE byte stream into frames; comment lines (keepalives) and frames with no data are dropped. */
async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<Sse> {
  const decoder = new TextDecoder()
  let buffer = ''
  const parse = (block: string): Sse | null => {
    let event = 'message'
    let id: string | null = null
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') event = value
      else if (field === 'id') id = value
      else if (field === 'data') data.push(value)
    }
    return data.length ? { event, id, data: data.join('\n') } : null
  }
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
    for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
      const frame = parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 2)
      if (frame) yield frame
    }
  }
}

const clock = (iso: string | null) =>
  (iso && /T(\d\d:\d\d:\d\d)/.exec(iso)?.[1]) || new Date().toISOString().slice(11, 19)

interface Shown {
  value: unknown
  /** the time column, the id column and the words */
  plain: [at: string, who: string, text: string]
  closed?: boolean
}

function showFrame(frame: Sse): Shown {
  let raw: unknown
  try {
    raw = JSON.parse(frame.data)
  } catch {
    throw new FactoryError('contract_mismatch', `a ${frame.event} frame did not carry JSON`)
  }
  const parse = <S extends z.ZodType>(schema: S): z.output<S> => {
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      throw new FactoryError(
        'contract_mismatch',
        `a ${frame.event} frame did not match the expected shape: ${parsed.error.issues[0]?.message ?? 'unparseable'}`,
        { hint: 'the server and the CLI are from different releases' },
      )
    }
    return parsed.data
  }
  switch (frame.event) {
    case 'issue': {
      const f = parse(IssueFrame)
      return { value: f, plain: [clock(f.at), String(f.issue), oneLine(f.text)], closed: f.to === 'closed' }
    }
    case 'session': {
      const f = parse(SessionFrame)
      return {
        value: f,
        plain: [clock(f.at), f.session, `${f.kind}${f.state ? ` (${f.state})` : ''}`],
      }
    }
    case 'fleet': {
      const f = parse(FleetFrame)
      return { value: f, plain: [clock(f.builtAt), '-', 'the fleet view changed'] }
    }
    case 'hello': {
      const f = parse(HelloFrame)
      return { value: f, plain: [clock(null), '-', 'following'] }
    }
    // An event this CLI does not know is a newer server's addition: shown as it came.
    default:
      return { value: raw, plain: [clock(null), '-', frame.event] }
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })

/**
 * `factory follow`: the change stream, one line per frame, until a signal (exit 0), an error, or with `--until-closed` the
 * close of the Issue. A dropped connection is reopened with `Last-Event-ID` (backoff 1 s to 15 s); a refusal is an error.
 */
export async function follow(format: Format, flags: ReadFlags, io: Io): Promise<void> {
  if (flags['until-closed'] && flags.issue === undefined) throw usage('--until-closed needs --issue <id>')
  const issue = flags.issue === undefined ? undefined : idArg(flags.issue, '--issue')
  const token = io.env.FACTORY_TOKEN
  if (!token) {
    throw new FactoryError('auth', 'no FACTORY_TOKEN set', {
      hint: 'run it under secrets-run with the repo .env.tpl, or export FACTORY_TOKEN',
    })
  }
  const base = (io.env.FACTORY_URL || DEFAULT_URL).replace(/\/+$/, '')

  // Already closed: nothing will ever be said about it.
  if (flags['until-closed'] && issue !== undefined) {
    const { body } = await call(io, `/v1/issues/${issue}`, { auth: true, schema: IssueDetail })
    if (body.state === 'closed') return
  }

  const stop = new AbortController()
  const onSignal = () => stop.abort()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    let cursor = flags.since ?? null
    let backoff = BACKOFF_FIRST_MS
    let connected = false
    while (!stop.signal.aborted) {
      const query = new URLSearchParams()
      if (issue !== undefined) query.set('issue', issue)
      if (cursor !== null && !connected) query.set('since', cursor)
      let response: Response | undefined
      try {
        response = await fetch(`${base}/v1/stream${query.size ? `?${query.toString()}` : ''}`, {
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'text/event-stream',
            ...(cursor !== null ? { 'last-event-id': cursor } : {}),
          },
          signal: stop.signal,
        })
      } catch (error) {
        if (stop.signal.aborted) return
        if (!connected) {
          const reason = error instanceof Error ? error.message : String(error)
          throw new FactoryError('network', `server unreachable at ${base}: ${reason}`, {
            hint: `is the server up? ${BIN} version works offline`,
          })
        }
      }
      if (response && !response.ok) {
        const text = await response.text().catch(() => '')
        // A server that is down or restarting is waited for once we have been connected; a refusal never is.
        if (!(connected && response.status >= 500)) {
          const message = ErrorBody.safeParse(safeJson(text))
          const detail = message.success ? message.data.error : `HTTP ${response.status}`
          throw new FactoryError(kindForStatus(response.status), detail, {
            hint:
              response.status === 410
                ? `the cursor is unknown to the server: read the resources again (${BIN} read overview) and follow without --since`
                : '',
            details: { status: response.status },
          })
        }
      } else if (response?.body) {
        connected = true
        try {
          for await (const frame of sseFrames(response.body)) {
            if (frame.id !== null) cursor = frame.id
            backoff = BACKOFF_FIRST_MS
            const shown = showFrame(frame)
            io.out(
              format === 'json'
                ? `${JSON.stringify({ event: frame.event, id: frame.id, data: shown.value })}\n`
                : `${shown.plain.join('\t')}\n`,
            )
            if (flags['until-closed'] && shown.closed) return
          }
        } catch (error) {
          if (error instanceof FactoryError) throw error
          // A dropped connection: reopen below.
        }
      }
      if (stop.signal.aborted) return
      await sleep(backoff, stop.signal)
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    stop.abort()
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
