import * as z from 'zod'
import type { LogRecord, SpanRecord, TelemetrySink } from '../../kernel/telemetry.ts'
import { quietly } from './console.ts'
import { encodeLogs, encodeSpans, resourceOf } from './otlp.ts'

const HTTP_TIMEOUT_MS = 8_000
/** The most records one request carries. */
const BATCH = 1_000
/** The most records kept between two flushes per signal; a record past it is dropped and counted. */
const MAX_QUEUED = 5_000

const Answer = z.looseObject({
  partialSuccess: z
    .looseObject({
      rejectedSpans: z.coerce.number().optional(),
      rejectedLogRecords: z.coerce.number().optional(),
    })
    .optional(),
})

export interface TelemetryExporterDeps {
  /** the ingest URL without a path; null is off */
  endpoint: string | null
  key: string | null
  version: string
  maxQueued?: number
  fetch?: typeof fetch
  log?: (line: string) => void
}

export interface TelemetryExporter {
  enabled: boolean
  sink: TelemetrySink
  /** sends what is queued (`POST <endpoint>/v1/traces` and `/v1/logs`); never throws; a batch that fails is dropped, not retried */
  flush(): Promise<void>
  /** what was lost since the start: a full queue, a failed push, a refused record; read by the `factory.telemetry.dropped` gauge */
  dropped(): { logs: number; spans: number }
}

/**
 * The logs and spans pushed to ClickStack as OTLP/HTTP JSON beside the gauges. `sink` only queues, so a pass never waits for
 * the network; `flush` runs on its own schedule. An export that fails drops its batch and counts it: it never fails or delays
 * a pass. One local line when pushing starts to fail and one when it works again.
 */
export function otelTelemetry(deps: TelemetryExporterDeps): TelemetryExporter {
  const endpoint = deps.endpoint?.trim() ? deps.endpoint.trim().replace(/\/+$/, '') : null
  const log = deps.log ?? ((line: string) => quietly(() => console.error(line)))
  const doFetch = deps.fetch ?? fetch
  const max = deps.maxQueued ?? MAX_QUEUED
  const spans: SpanRecord[] = []
  const logs: LogRecord[] = []
  const lost = { logs: 0, spans: 0 }
  const resource = resourceOf(deps.version)
  let failing = false

  const fail = (reason: string) => {
    if (!failing) log(`telemetry export: ${reason}`)
    failing = true
  }

  async function push(path: string, body: unknown, count: number, signal: 'logs' | 'spans'): Promise<boolean> {
    try {
      const response = await doFetch(`${endpoint}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'software-factory',
          ...(deps.key ? { Authorization: deps.key } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      if (!response.ok) {
        lost[signal] += count
        fail(`${path} HTTP ${response.status}`)
        return false
      }
      const answer = Answer.safeParse(await response.json().catch(() => null))
      const rejected = answer.success
        ? (answer.data.partialSuccess?.rejectedSpans ?? 0) + (answer.data.partialSuccess?.rejectedLogRecords ?? 0)
        : 0
      if (rejected > 0) {
        lost[signal] += rejected
        fail(`${path} ${rejected} records rejected`)
        return false
      }
      return true
    } catch (error) {
      lost[signal] += count
      fail(`${path} ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  async function flush(): Promise<void> {
    if (endpoint === null) return
    let allSent = true
    // a few rounds at most: a backlog drains over the next flushes, never in one long call
    for (let round = 0; round < 5 && (spans.length > 0 || logs.length > 0); round++) {
      const sendSpans = spans.splice(0, BATCH)
      const sendLogs = logs.splice(0, BATCH)
      const results = await Promise.all([
        sendSpans.length
          ? push(
              '/v1/traces',
              encodeSpans({ resource, scope: 'factory.server', spans: sendSpans }),
              sendSpans.length,
              'spans',
            )
          : true,
        sendLogs.length
          ? push('/v1/logs', encodeLogs({ resource, scope: 'factory.server', logs: sendLogs }), sendLogs.length, 'logs')
          : true,
      ])
      allSent &&= results.every(Boolean)
      if (!allSent) break
    }
    if (allSent && failing) {
      log('telemetry export: working again')
      failing = false
    }
  }

  return {
    enabled: endpoint !== null,
    sink: {
      span(span) {
        if (spans.length >= max) lost.spans++
        else spans.push(span)
      },
      log(record) {
        if (logs.length >= max) lost.logs++
        else logs.push(record)
      },
    },
    flush,
    dropped: () => ({ ...lost }),
  }
}
