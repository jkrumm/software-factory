import { AsyncLocalStorage } from 'node:async_hooks'
import type { PortError, Result } from './result.ts'

/**
 * What the server tells its telemetry (`docs/operations.md` "Logs and traces"): spans for loop passes that did something or
 * failed and for the port calls inside them, logs for errors and warnings. The record shapes carry no free text: a log is a
 * fixed event name and attributes, a span a fixed name and attributes, and `cleanAttrs` lets through only the attribute
 * names listed here, with values that are one word (an id, a name, a kind, a number). A title, a note, a fact, a signal's
 * text, a path or an error message has no way in. The words stay in the local log lines.
 */
export type AttrValue = string | number | boolean
export type Attrs = Record<string, AttrValue | null | undefined>

export interface SpanRecord {
  traceId: string
  spanId: string
  parentSpanId: string | null
  name: string
  startMs: number
  endMs: number
  failed: boolean
  attrs: Record<string, AttrValue>
}

export interface LogRecord {
  atMs: number
  level: 'warn' | 'error'
  event: string
  traceId: string | null
  spanId: string | null
  attrs: Record<string, AttrValue>
}

/** Where the records go. Both calls only queue: they never throw, never wait and never touch the network. */
export interface TelemetrySink {
  span(span: SpanRecord): void
  log(log: LogRecord): void
}

/** The attribute names a record may carry; any other is dropped. Ids, names, kinds, counts and durations only. */
const ATTRIBUTE_NAMES: ReadonlySet<string> = new Set([
  'loop',
  'issue',
  'ref',
  'port',
  'workflow',
  'program',
  'verb',
  'result',
  'error.kind',
  'error.type',
  'error.code',
  'exit.code',
  'duration.ms',
  'count',
  'chars',
  'http.method',
  'http.route',
  'http.status',
  'source',
])

/** A string value is one word of safe characters: no space, so no sentence, title or message can pass. */
const WORD = /^[A-Za-z0-9_.:/-]{1,64}$/

export function cleanAttrs(attrs: Attrs): Record<string, AttrValue> {
  const clean: Record<string, AttrValue> = {}
  for (const [name, value] of Object.entries(attrs)) {
    if (!ATTRIBUTE_NAMES.has(name) || value === null || value === undefined) continue
    if (typeof value === 'string' && !WORD.test(value)) continue
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    clean[name] = value
  }
  return clean
}

let sink: TelemetrySink | null = null

/** Installs the sink the whole process records to (null: off, the default); returns what puts the previous one back. */
export function installTelemetry(next: TelemetrySink | null): () => void {
  const previous = sink
  sink = next
  return () => {
    sink = previous
  }
}

export const telemetryOn = (): boolean => sink !== null

const hex = (bytes: number): string =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')

/** What one loop pass or request collects while it runs. */
interface Scope {
  traceId: string
  spanId: string
  loop: string
  /** the calls made inside it, kept only if the pass is */
  buffer: SpanRecord[]
  /** the pass did something: it called agw or changed an Issue */
  active: boolean
  /** a call inside it failed */
  failed: boolean
}

const scopes = new AsyncLocalStorage<Scope>()

/** The pass that changed state or asked a model says so: a pass that only looked at the world is dropped, not recorded. */
export function markActive(): void {
  const scope = scopes.getStore()
  if (scope) scope.active = true
}

/** An error as attributes: its class name and its code, never its message. */
export function errorAttrs(error: unknown): Attrs {
  if (!(error instanceof Error)) return { 'error.type': typeof error }
  const code = (error as { code?: unknown }).code
  return { 'error.type': error.name, ...(typeof code === 'string' ? { 'error.code': code } : {}) }
}

/** The kind of a `PortError` (or anything that has one) as an attribute; its detail never. */
export function kindAttrs(error: unknown): Attrs {
  const kind = typeof error === 'object' && error !== null ? (error as { kind?: unknown }).kind : undefined
  return { 'error.kind': typeof kind === 'string' ? kind : null }
}

/** Writes a log record, tied to the loop pass it happens in. Never throws. */
export function logEvent(level: LogRecord['level'], event: string, attrs: Attrs = {}): void {
  if (!sink) return
  try {
    const scope = scopes.getStore()
    sink.log({
      atMs: Date.now(),
      level,
      event,
      traceId: scope?.traceId ?? null,
      spanId: scope?.spanId ?? null,
      attrs: cleanAttrs({ ...(scope ? { loop: scope.loop } : {}), ...attrs }),
    })
  } catch {
    // telemetry never reaches a pass
  }
}

let quiet = 0

/** Runs a synchronous local write that is already structured (or must not become a record): the console tap skips it. */
export function quietly<T>(run: () => T): T {
  quiet++
  try {
    return run()
  } finally {
    quiet--
  }
}

export const isQuiet = (): boolean => quiet > 0

/** A line for the local log and a structured record for the same event: the words stay local, the record has none. */
export function reportLine(level: LogRecord['level'], line: string, event: string, attrs: Attrs = {}): void {
  logEvent(level, event, attrs)
  quietly(() => (level === 'error' ? console.error(line) : console.warn(line)))
}

const emit = (span: SpanRecord): void => {
  try {
    sink?.span(span)
  } catch {
    // telemetry never reaches a pass
  }
}

/**
 * One loop pass. The calls inside it buffer; at the end the pass and its calls are recorded when the pass failed, a call in it
 * failed, or it did something (`markActive`: it called agw or changed an Issue). A pass that looked and found nothing records
 * nothing, so the volume follows what happened, not the tick. A failed pass writes one error log and is the one error span; a
 * pass that only holds a failed call is recorded but not marked failed.
 */
export async function tracePass<E = PortError>(
  loop: string,
  run: () => Promise<Result<unknown, E>>,
): Promise<Result<unknown, E>> {
  if (!sink) return run()
  const scope: Scope = { traceId: hex(16), spanId: hex(8), loop, buffer: [], active: false, failed: false }
  const startMs = Date.now()
  let outcome: Attrs = { result: 'ok' }
  let failed = false
  try {
    const result = await scopes.run(scope, run)
    if (!result.ok) {
      failed = true
      const kind = (result.error as { kind?: unknown } | null)?.kind
      outcome = {
        result: typeof kind === 'string' ? kind : 'failed',
        'error.kind': typeof kind === 'string' ? kind : null,
      }
    }
    return result
  } catch (error) {
    failed = true
    outcome = { result: 'crashed', ...errorAttrs(error) }
    throw error
  } finally {
    const endMs = Date.now()
    if (failed) scopes.run(scope, () => logEvent('error', 'loop.pass_failed', outcome))
    if (failed || scope.failed || scope.active) {
      emit({
        traceId: scope.traceId,
        spanId: scope.spanId,
        parentSpanId: null,
        name: `loop.${loop}`,
        startMs,
        endMs,
        failed,
        attrs: cleanAttrs({ loop, ...outcome, count: scope.buffer.length, 'duration.ms': endMs - startMs }),
      })
      for (const span of scope.buffer) emit(span)
    }
  }
}

/** How a port call ended: the Result kind it is recorded under, whether that is a failure, and whether it counts as work done. */
export interface Judged {
  result: string
  failed: boolean
  /** an agw call: a model ran, so the pass it is in did something */
  work?: boolean
  /** more attributes of the span (an exit code) */
  attrs?: Attrs
}

/**
 * One port call (`agw`, `process`): a span with its duration and Result kind. Inside a pass it is buffered with the pass; outside
 * one it is recorded only when it failed or was work. A failed call writes one error log (the port, what it was, the Result
 * kind, the loop and the Issue when known) with no text. A throw is a failed call of kind `threw` and goes on.
 */
export async function tracePort<T>(
  call: { name: string; port: string; attrs?: Attrs },
  run: () => Promise<T>,
  judge: (value: T) => Judged,
): Promise<T> {
  if (!sink) return run()
  const scope = scopes.getStore()
  const spanId = hex(8)
  const startMs = Date.now()
  let judged: Judged = { result: 'unknown', failed: false }
  let thrown: Attrs = {}
  try {
    const value = await run()
    judged = judge(value)
    return value
  } catch (error) {
    judged = { result: 'threw', failed: true }
    thrown = errorAttrs(error)
    throw error
  } finally {
    const endMs = Date.now()
    const { result, failed, work } = judged
    const attrs: Attrs = {
      port: call.port,
      ...call.attrs,
      ...judged.attrs,
      result,
      'error.kind': failed ? result : null,
      ...thrown,
      'duration.ms': endMs - startMs,
    }
    if (failed) logEvent('error', 'port.failed', { port: call.port, ...call.attrs, 'error.kind': result, ...thrown })
    const span: SpanRecord = {
      traceId: scope?.traceId ?? hex(16),
      spanId,
      parentSpanId: scope?.spanId ?? null,
      name: call.name,
      startMs,
      endMs,
      failed,
      attrs: cleanAttrs({ ...(scope ? { loop: scope.loop } : {}), ...attrs }),
    }
    if (scope) {
      scope.buffer.push(span)
      if (failed) scope.failed = true
      if (work) scope.active = true
    } else if (failed || work) emit(span)
  }
}

/** The kind a Result is recorded under: `ok`, or the PortError's kind. */
export const judgeResult = (result: Result<unknown, PortError>): Judged =>
  result.ok ? { result: 'ok', failed: false } : { result: result.error.kind, failed: true }

/** The request that ended 5xx: one error span and one error log, by route pattern and status, no path, no body. */
export function recordServerError(request: { method: string; route: string; status: number; startMs: number }): void {
  if (!sink) return
  const endMs = Date.now()
  const attrs: Attrs = {
    'http.method': request.method,
    'http.route': request.route,
    'http.status': request.status,
    'duration.ms': endMs - request.startMs,
  }
  logEvent('error', 'api.server_error', attrs)
  emit({
    traceId: hex(16),
    spanId: hex(8),
    parentSpanId: null,
    name: 'http.request',
    startMs: request.startMs,
    endMs,
    failed: true,
    attrs: cleanAttrs(attrs),
  })
}
