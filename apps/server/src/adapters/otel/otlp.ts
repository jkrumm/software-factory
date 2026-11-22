import type { LogRecord, SpanRecord } from '../../kernel/telemetry.ts'

/** One data point of a gauge: a value and the attributes that tell its series apart. */
export interface GaugePoint {
  value: number
  attributes?: Record<string, string>
}

export interface Gauge {
  name: string
  unit: string
  points: GaugePoint[]
}

type Value = string | number | boolean

const anyValue = (value: Value) =>
  typeof value === 'string'
    ? { stringValue: value }
    : typeof value === 'boolean'
      ? { boolValue: value }
      : Number.isInteger(value)
        ? { intValue: String(value) }
        : { doubleValue: value }

const attrs = (record: Record<string, Value>) =>
  Object.entries(record).map(([key, value]) => ({ key, value: anyValue(value) }))

/** The resource every signal carries: one service, the deployed version as an attribute. */
export const resourceOf = (version: string): Record<string, string> => ({
  'service.name': 'software-factory',
  'service.namespace': 'software-factory',
  'service.version': version.slice(0, 7),
  'deployment.environment.name': 'prod',
  'host.name': 'mini',
})

const nano = (ms: number): string => (BigInt(Math.round(ms)) * 1_000_000n).toString()

const SEVERITY = { warn: { number: 13, text: 'WARN' }, error: { number: 17, text: 'ERROR' } } as const

/**
 * An OTLP/HTTP JSON `ExportTraceServiceRequest` (`POST /v1/traces`). Trace and span ids are lowercase hex in JSON, a status
 * code 2 is an error. A span has no status message: the words of a failure stay in the local log.
 */
export function encodeSpans(input: { resource: Record<string, string>; scope: string; spans: readonly SpanRecord[] }) {
  return {
    resourceSpans: [
      {
        resource: { attributes: attrs(input.resource) },
        scopeSpans: [
          {
            scope: { name: input.scope },
            spans: input.spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              name: span.name,
              kind: 1,
              startTimeUnixNano: nano(span.startMs),
              endTimeUnixNano: nano(span.endMs),
              attributes: attrs(span.attrs),
              status: { code: span.failed ? 2 : 1 },
            })),
          },
        ],
      },
    ],
  }
}

/** An OTLP/HTTP JSON `ExportLogsServiceRequest` (`POST /v1/logs`): the body is the fixed event name, never a message. */
export function encodeLogs(input: { resource: Record<string, string>; scope: string; logs: readonly LogRecord[] }) {
  return {
    resourceLogs: [
      {
        resource: { attributes: attrs(input.resource) },
        scopeLogs: [
          {
            scope: { name: input.scope },
            logRecords: input.logs.map((log) => ({
              timeUnixNano: nano(log.atMs),
              observedTimeUnixNano: nano(log.atMs),
              severityNumber: SEVERITY[log.level].number,
              severityText: SEVERITY[log.level].text,
              body: { stringValue: log.event },
              attributes: attrs(log.attrs),
              ...(log.traceId ? { traceId: log.traceId } : {}),
              ...(log.spanId ? { spanId: log.spanId } : {}),
            })),
          },
        ],
      },
    ],
  }
}

/**
 * An OTLP/HTTP JSON `ExportMetricsServiceRequest` of gauges (`POST /v1/metrics`, `Content-Type: application/json`). Field names
 * are lowerCamelCase, a timestamp is a decimal string of nanoseconds (built with a BigInt: it passes 2^53). A gauge has no
 * temporality, so a push that is lost or repeated changes nothing. A gauge with no point is left out.
 */
export function encodeGauges(input: { resource: Record<string, string>; scope: string; at: Date; gauges: Gauge[] }) {
  const timeUnixNano = (BigInt(input.at.getTime()) * 1_000_000n).toString()
  return {
    resourceMetrics: [
      {
        resource: { attributes: attrs(input.resource) },
        scopeMetrics: [
          {
            scope: { name: input.scope },
            metrics: input.gauges
              .filter((gauge) => gauge.points.length > 0)
              .map((gauge) => ({
                name: gauge.name,
                unit: gauge.unit,
                gauge: {
                  dataPoints: gauge.points.map((point) => ({
                    timeUnixNano,
                    asDouble: point.value,
                    attributes: attrs(point.attributes ?? {}),
                  })),
                },
              })),
          },
        ],
      },
    ],
  }
}
