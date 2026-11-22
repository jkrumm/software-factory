import * as z from 'zod'
import { QUEUE_REASONS } from '@software-factory/contract'
import type { Clock } from '../../kernel/clock.ts'
import type { CapacityGauges } from '../../read/capacity-gauges.ts'
import { quietly } from './console.ts'
import { encodeGauges, type Gauge, resourceOf } from './otlp.ts'

const HTTP_TIMEOUT_MS = 8_000

/** What the collector answers: the points it refused, when it refused any (int64 fields come as numbers or strings). */
const Answer = z.looseObject({
  partialSuccess: z.looseObject({ rejectedDataPoints: z.coerce.number().optional() }).optional(),
})

export interface OtelExporterDeps {
  clock: Clock
  /** the ingest URL without a path; null is off */
  endpoint: string | null
  /** sent as the `authorization` header, the way HyperDX's ingest takes its key */
  key: string | null
  /** the deployed commit: `service.version` is its short form */
  version: string
  /** the settings in force the load is read against (seat caps per account) */
  allowanceCaps: { perAccount: number; byAccount: Record<string, number> }
  read: () => Promise<CapacityGauges>
  /** the logs and spans the export dropped since the start, by signal (`telemetry.ts`) */
  dropped?: () => { logs: number; spans: number }
  fetch?: typeof fetch
  log?: (line: string) => void
}

/** Where a step its project declared remote ran and why (`PlacementReason`): a placement is rare, so every pair is a series, 0 until one happens. */
const PLACEMENTS: readonly (readonly [host: string, reason: string])[] = [
  ['vps', 'vps'],
  ['mini', 'free'],
  ['mini', 'no_room'],
  ['mini', 'not_sooner'],
  ['mini', 'held'],
]

/** The series, named under the `factory.` prefix the telemetry contract asks for (the product's namespace). */
export function gaugesOf(
  figures: CapacityGauges,
  caps: OtelExporterDeps['allowanceCaps'],
  dropped?: { logs: number; spans: number },
): Gauge[] {
  // every queue kind is a series, 0 when nothing waits for it, so a chart falls to 0 instead of leaving a gap
  const kinds = [...new Set<string>([...QUEUE_REASONS, ...figures.queue.map((q) => q.reason)])]
  const queued = new Map(figures.queue.map((q) => [q.reason, q.issues]))
  const placed = new Map(figures.placements.map((p) => [`${p.host}/${p.reason}`, p.steps]))
  const placementPairs = [
    ...PLACEMENTS,
    ...figures.placements
      .map((p) => [p.host, p.reason] as const)
      .filter(([host, reason]) => !PLACEMENTS.some(([h, r]) => h === host && r === reason)),
  ]
  const accounts = [...new Set([...Object.keys(caps.byAccount), ...figures.seats.map((s) => s.account)])].sort()
  const used = new Map(figures.seats.map((s) => [s.account, s.used]))
  return [
    {
      name: 'factory.queue.issues',
      unit: '{issue}',
      points: kinds.map((reason) => ({ value: queued.get(reason) ?? 0, attributes: { reason } })),
    },
    {
      name: 'factory.slot.waits',
      unit: '{wait}',
      points: figures.slotWaits.map((w) => ({ value: w.waits, attributes: { reason: w.reason, repo: w.repo } })),
    },
    {
      name: 'factory.slot.wait.ms',
      unit: 'ms',
      points: figures.slotWaits.map((w) => ({ value: w.totalMs, attributes: { reason: w.reason, repo: w.repo } })),
    },
    {
      name: 'factory.slot.wait.p90.ms',
      unit: 'ms',
      points: figures.slotWaitP90.map((w) => ({ value: w.p90Ms, attributes: { reason: w.reason } })),
    },
    {
      name: 'factory.step.placements',
      unit: '{step}',
      points: placementPairs.map(([host, reason]) => ({
        value: placed.get(`${host}/${reason}`) ?? 0,
        attributes: { host, reason },
      })),
    },
    {
      name: 'factory.seats.used',
      unit: '{lead}',
      points: accounts.map((account) => ({ value: used.get(account) ?? 0, attributes: { account } })),
    },
    {
      name: 'factory.seats.cap',
      unit: '{lead}',
      points: accounts.map((account) => ({
        value: caps.byAccount[account] ?? caps.perAccount,
        attributes: { account },
      })),
    },
    {
      name: 'factory.host.load',
      unit: '1',
      points: figures.host ? [{ value: figures.host.load }] : [],
    },
    {
      name: 'factory.host.load.ceiling',
      unit: '1',
      points: figures.host?.loadCeiling != null ? [{ value: figures.host.loadCeiling }] : [],
    },
    {
      // the logs and spans an export lost (a failed push, a full queue) since the server started: a series, 0 until one is lost
      name: 'factory.telemetry.dropped',
      unit: '{record}',
      points: dropped
        ? [
            { value: dropped.logs, attributes: { signal: 'logs' } },
            { value: dropped.spans, attributes: { signal: 'spans' } },
          ]
        : [],
    },
  ]
}

/**
 * The capacity figures pushed to ClickStack as OTLP/HTTP JSON gauges (`POST <endpoint>/v1/metrics`), one push per pass. A
 * gauge keeps no state here: a lost push is a gap in a chart, nothing more. `pass` never throws and nothing it does reaches
 * a loop: a failure is logged once when it starts and once when the push works again.
 */
export function otelExporter(deps: OtelExporterDeps): { enabled: boolean; pass(): Promise<void> } {
  const log = deps.log ?? ((line: string) => quietly(() => console.error(line)))
  const doFetch = deps.fetch ?? fetch
  const endpoint = deps.endpoint?.trim() ? deps.endpoint.trim() : null
  const enabled = endpoint !== null
  let failing = false

  const fail = (reason: string) => {
    if (!failing) log(`otel export: ${reason}`)
    failing = true
  }

  async function pass(): Promise<void> {
    if (endpoint === null) return
    try {
      const at = deps.clock.now()
      const body = encodeGauges({
        resource: resourceOf(deps.version),
        scope: 'factory.capacity',
        at,
        gauges: gaugesOf(await deps.read(), deps.allowanceCaps, deps.dropped?.()),
      })
      const response = await doFetch(`${endpoint}/v1/metrics`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'software-factory',
          ...(deps.key ? { Authorization: deps.key } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      if (!response.ok) return fail(`HTTP ${response.status}`)
      const answer = Answer.safeParse(await response.json().catch(() => null))
      const rejected = answer.success ? (answer.data.partialSuccess?.rejectedDataPoints ?? 0) : 0
      if (rejected > 0) return fail(`${rejected} data points rejected`)
      if (failing) log('otel export: working again')
      failing = false
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }

  return { enabled, pass }
}
