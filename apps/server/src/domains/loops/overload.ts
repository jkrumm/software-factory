import { scrub } from '../../kernel/scrub.ts'
import { FRESH_MS, MINUTE_GAP_MS } from './selfwatch.ts'
import type { CapacityMinute, Finding, PsRow, QueueReasonCount, RouteLatency, SlotMinute } from './selfwatch-model.ts'

/**
 * The factory's own overload, as four conditions read from rows that already exist (the host samples with their capacity
 * facts, the slot minutes, and the server's own timing of its routes). Detection and evidence only: nothing here gates
 * admission, slots or a deploy. The evening of 2026-11-14 (load 200 twice, the Console 502) is what they are for.
 */

const iso = (date: Date): string => date.toISOString()
const oneLine = (text: string, max = 240): string => text.replace(/\s+/g, ' ').trim().slice(0, max)
const byTime = <T extends { at: Date }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => a.at.getTime() - b.at.getTime())

/** The newest unbroken run of consecutive minute samples that all satisfy `holds` (a gap past `MINUTE_GAP_MS` or a miss breaks it). */
function tailRun<T extends { at: Date }>(rows: readonly T[], holds: (row: T) => boolean): T[] {
  const run: T[] = []
  for (const row of byTime(rows)) {
    const previous = run[run.length - 1]
    if (!holds(row) || (previous !== undefined && row.at.getTime() - previous.at.getTime() > MINUTE_GAP_MS)) {
      run.length = 0
      if (!holds(row)) continue
    }
    run.push(row)
  }
  return run
}

const freshRun = <T extends { at: Date }>(run: readonly T[], now: Date): boolean => {
  const last = run[run.length - 1]
  return last !== undefined && now.getTime() - last.at.getTime() <= FRESH_MS
}

// ---- 11. load_over_ceiling --------------------------------------------------------------------------------------------------

/** The one-minute load must stay over the load ceiling in this many consecutive host samples. */
export const LOAD_SAMPLES = 10

export function loadOverCeilingFindings(
  minutes: readonly CapacityMinute[],
  rules: Pick<AdmissionRules, 'overLoad'>,
  now: Date,
): Finding[] {
  const run = tailRun(
    minutes,
    (m) => m.load !== null && m.loadCeiling !== null && rules.overLoad(m.load, m.loadCeiling),
  )
  const first = run[0]
  const last = run[run.length - 1]
  if (!first || !last || run.length < LOAD_SAMPLES || !freshRun(run, now)) return []
  const peak = Math.max(...run.map((m) => m.load ?? 0))
  return [
    {
      kind: 'load_over_ceiling',
      subject: 'host',
      title: 'Self-watch: the one-minute load of the host has been over the load ceiling for ten samples in a row',
      facts: [`the one-minute load stayed over the load ceiling in ${LOAD_SAMPLES} consecutive host samples`],
      context: [
        `${run.length} samples in a row since ${iso(first.at)}: load ${last.load?.toFixed(1)} now, ${peak.toFixed(1)} at most, ceiling ${last.loadCeiling}`,
        `Now: ${iso(now)}`,
      ],
      reproduce: 'factory read host; factory read capacity-loop (minutes over the ceiling)',
    },
  ]
}

// ---- 12. slot_line ----------------------------------------------------------------------------------------------------------

/** More callers than this waiting for a test slot... */
export const SLOT_WAITERS = 8
/** ...in this many consecutive minutes is a line that does not move. */
export const SLOT_WAIT_MINUTES = 15
/** A base slot empty while a caller waits, this many consecutive minutes: the memory rule is refusing a step the host could run. */
export const SLOT_EMPTY_MINUTES = 5

export function slotLineFindings(minutes: readonly SlotMinute[], now: Date): Finding[] {
  const found: Finding[] = []
  const waiting = tailRun(minutes, (m) => m.waiters > SLOT_WAITERS)
  const waitingLast = waiting[waiting.length - 1]
  if (waitingLast && waiting.length >= SLOT_WAIT_MINUTES && freshRun(waiting, now)) {
    const most = Math.max(...waiting.map((m) => m.waiters))
    found.push({
      kind: 'slot_line',
      subject: 'waiting',
      title: 'Self-watch: more than eight callers have waited for a test slot for fifteen minutes',
      facts: [`more than ${SLOT_WAITERS} callers waited for a test slot in ${SLOT_WAIT_MINUTES} consecutive minutes`],
      context: [
        `${waiting.length} minutes in a row since ${iso(waiting[0]?.at ?? waitingLast.at)}: ${waitingLast.waiters} waiting now, ${most} at most, ${waitingLast.holders} of ${waitingLast.liveSlots} base slots held`,
        `Now: ${iso(now)}`,
      ],
      reproduce: 'factory capacity state (the slot lines); factory slot list',
    })
  }
  const empty = tailRun(minutes, (m) => m.holders < m.liveSlots && m.waiters > 0)
  const emptyLast = empty[empty.length - 1]
  if (emptyLast && empty.length >= SLOT_EMPTY_MINUTES && freshRun(empty, now)) {
    found.push({
      kind: 'slot_line',
      subject: 'base_empty',
      title: 'Self-watch: a base test slot sits empty while callers wait for memory',
      facts: [`a base test slot was empty while a caller waited in ${SLOT_EMPTY_MINUTES} consecutive minutes`],
      context: [
        `${empty.length} minutes in a row since ${iso(empty[0]?.at ?? emptyLast.at)}: ${emptyLast.holders} of ${emptyLast.liveSlots} base slots held, ${emptyLast.waiters} waiting`,
        `Now: ${iso(now)}`,
      ],
      reproduce: 'factory capacity state (the slot lines name the reason of each waiter)',
    })
  }
  return found
}

// ---- 13. gates_passed -------------------------------------------------------------------------------------------------------

/** The newest samples within this long of the newest one are looked at for a lead that was admitted past a gate. */
export const GATE_WINDOW_MS = 10 * 60_000

/**
 * The admission rules, as the capacity layer holds them (`overLoad`, `overMemory` in `domains/capacity/host.ts`): passed in
 * by the app, so these conditions judge by the very comparisons admission makes and a changed rule moves both.
 */
export interface AdmissionRules {
  overLoad(load: number, ceiling: number): boolean
  overMemory(reading: { swapoutMbPer300s: number; swapUsedPct: number }): boolean
}

/** A lead admitted: an Issue's `admitted` event (an attempt begins). A resume of a waiting lead is no admission and has none. */
export interface Admission {
  at: Date
  issue: string
}

const loadOver = (m: CapacityMinute, rules: AdmissionRules): boolean =>
  m.load !== null && m.loadCeiling !== null && rules.overLoad(m.load, m.loadCeiling)
const memoryOver = (m: CapacityMinute, rules: AdmissionRules): boolean =>
  m.swapUsedPct !== null &&
  m.swapoutMbPer300s !== null &&
  rules.overMemory({ swapUsedPct: m.swapUsedPct, swapoutMbPer300s: m.swapoutMbPer300s })

/**
 * More leads working than the admission rules allow, judged per admission (an `admitted` event; a lead that resumes from a
 * wait takes its claim again without these gates and is no admission). Each is set against the host samples on either side
 * of it, within `MINUTE_GAP_MS`: it passed the load rule when the load was over its ceiling in both, the memory rule when
 * swap use or the swapout rate was over its ceiling in both (a lead the rule let in has one of the two under), and the cap
 * when the leads already filled the accounts' seats in the sample after it. Judged over the ten minutes before the newest
 * sample; one signal, the passed gates are its facts.
 */
export function gatesPassedFindings(
  minutes: readonly CapacityMinute[],
  admissions: readonly Admission[],
  rules: AdmissionRules,
  now: Date,
): Finding[] {
  const ordered = byTime(minutes)
  const newest = ordered[ordered.length - 1]
  if (!newest || now.getTime() - newest.at.getTime() > FRESH_MS) return []
  const facts: string[] = []
  const context: string[] = []
  const passed: { load?: string; memory?: string; seats?: string } = {}
  for (const admission of byTime(admissions)) {
    if (newest.at.getTime() - admission.at.getTime() > GATE_WINDOW_MS) continue
    const t = admission.at.getTime()
    const before = [...ordered].reverse().find((m) => m.at.getTime() <= t)
    const after = ordered.find((m) => m.at.getTime() >= t)
    if (!before || !after || t - before.at.getTime() > MINUTE_GAP_MS || after.at.getTime() - t > MINUTE_GAP_MS) continue
    const seen = `${admission.issue} admitted at ${iso(admission.at)}: load ${after.load?.toFixed(1) ?? 'unread'} (ceiling ${after.loadCeiling ?? 'unread'}), swap ${after.swapUsedPct ?? 'unread'}%, swapouts ${after.swapoutMbPer300s ?? 'unread'} MiB/300s, ${after.leads ?? 'unread'} leads of ${after.seats ?? 'unread'} seats`
    if (loadOver(before, rules) && loadOver(after, rules)) passed.load ??= seen
    if (memoryOver(before, rules) && memoryOver(after, rules)) passed.memory ??= seen
    if (after.leads !== null && after.seats !== null && after.leads > after.seats) passed.seats ??= seen
  }
  if (passed.load) {
    facts.push('a lead was admitted while the load was over its ceiling')
    context.push(`load rule: ${passed.load}`)
  }
  if (passed.memory) {
    facts.push('a lead was admitted while swap was over its ceiling')
    context.push(`memory rule: ${passed.memory}`)
  }
  if (passed.seats) {
    facts.push('a lead was admitted while the leads already filled the accounts seats')
    context.push(`seat cap: ${passed.seats}`)
  }
  if (facts.length === 0) return []
  return [
    {
      kind: 'gates_passed',
      subject: 'host',
      title: 'Self-watch: leads were admitted past the admission gates',
      facts,
      context: [...context, `Now: ${iso(now)}`],
      reproduce:
        'factory read host (leads, load, load ceiling per minute); factory queue order; factory capacity state',
    },
  ]
}

// ---- 14. routes_slow --------------------------------------------------------------------------------------------------------

/** The p95 of the server's routes over the window above this is a server that is up but useless. */
export const ROUTE_P95_LIMIT_MS = 2_000
/** Fewer answers than this in the window say nothing about the p95. */
export const ROUTE_MIN_SAMPLES = 10

export function routesSlowFindings(latency: RouteLatency, now: Date): Finding[] {
  if (latency.p95Ms === null || latency.samples < ROUTE_MIN_SAMPLES || latency.p95Ms <= ROUTE_P95_LIMIT_MS) return []
  return [
    {
      kind: 'routes_slow',
      subject: 'routes',
      title: "Self-watch: the server's own routes answer slowly, their p95 is over two seconds",
      facts: [`the p95 of the server's route answer times over five minutes is above ${ROUTE_P95_LIMIT_MS / 1000} s`],
      context: [
        `p95 ${Math.round(latency.p95Ms)} ms over ${latency.samples} requests in the last ${Math.round(latency.windowMs / 60_000)} minutes (a request still unanswered counts at its age)`,
        `Now: ${iso(now)}`,
      ],
      reproduce: 'curl the server GET /health (heartbeat.routeP95Ms); factory read loops',
    },
  ]
}

/** The kinds of a pass that need the evidence block (`overloadEvidence`). */
export const OVERLOAD_KINDS: ReadonlySet<string> = new Set([
  'load_over_ceiling',
  'slot_line',
  'gates_passed',
  'routes_slow',
])

// ---- the evidence -----------------------------------------------------------------------------------------------------------

/** `ps -axo pid=,pri=,pcpu=,rss=,command=`: pid, scheduling priority, CPU share, resident KiB, then the command. */
const PS_LINE = /^\s*(\d+)\s+(-?\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/

export function parsePs(output: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of output.split('\n')) {
    const match = PS_LINE.exec(line)
    if (!match) continue
    const [, pid = '', pri = '', pcpu = '', rss = '', command = ''] = match
    rows.push({
      pid: Number(pid),
      pri: Number(pri),
      pcpu: Number(pcpu),
      rssMib: Math.round(Number(rss) / 1024),
      command,
    })
  }
  return rows
}

/** The program of a command line; a postgres backend retitles itself `postgres: <role> <db> …`, so a trailing colon goes. */
const program = (command: string): string => ((command.split(/\s+/)[0] ?? '').split('/').pop() ?? '').replace(/:$/, '')

/** Which of the processes the control plane's priority is compared across a row is, if any. */
function roleOf(row: PsRow, serverPid: number): 'server' | 'door' | 'postgres' | 'lead' | null {
  if (row.pid === serverPid) return 'server'
  if (/\bapps\/door\//.test(row.command)) return 'door'
  const name = program(row.command)
  if (name === 'postgres' || name === 'postmaster') return 'postgres'
  if (name === 'claude') return 'lead'
  return null
}

const ROLES = ['server', 'door', 'postgres', 'lead'] as const
const PRIORITY_LABEL = {
  server: 'the server',
  door: 'the door',
  postgres: 'postgres',
  lead: "a lead's claude",
} as const

/** One line: the scheduling priority of the control plane against a lead's process (a launchd job that ran throttled was cause one). */
export function priorityLine(rows: readonly PsRow[], serverPid: number): string {
  const parts = ROLES.map((role) => {
    const mine = rows.filter((row) => roleOf(row, serverPid) === role)
    if (mine.length === 0) return `${PRIORITY_LABEL[role]}: not found`
    const priorities = [...new Set(mine.map((row) => row.pri))].sort((a, b) => a - b).join('/')
    return `${PRIORITY_LABEL[role]}: ${priorities}${mine.length > 1 ? ` (${mine.length} processes)` : ''}`
  })
  return `Scheduling priority (ps -o pri, a higher number is scheduled sooner): ${parts.join('; ')}`
}

export const BUSIEST = 15
export const SLOT_LINES_LISTED = 12

export interface EvidenceInputs {
  now: Date
  /** `slotLines(rows, now)`: a held slot past half its limit, and a waiter with its reason */
  slotLines: readonly string[]
  queue: readonly QueueReasonCount[]
  /** the newest host sample with its capacity facts; null: none */
  host: CapacityMinute | null
  /** `ps`'s output, or why it was not read */
  ps: { output: string } | { failure: string }
  serverPid: number
  deployLines: readonly string[]
}

const figure = (value: number | null, unit = ''): string =>
  value === null ? 'unread' : `${Math.round(value * 10) / 10}${unit}`

/**
 * What a lead needs to find the cause instead of the symptom: the slot lines with their reasons, the queue by reason, the
 * host's memory, compressor and swap, the busiest processes with their scheduling priority, the priority of the server, the
 * door and Postgres against a lead's process, and the last deploy lines. Read when a signal is filed, never hashed.
 */
export function overloadEvidence(input: EvidenceInputs): string[] {
  const lines: string[] = ['Evidence at the time of filing:']

  lines.push(`- Test slot lines (${input.slotLines.length}):${input.slotLines.length === 0 ? ' none' : ''}`)
  for (const line of input.slotLines.slice(0, SLOT_LINES_LISTED)) lines.push(`- slot line: ${oneLine(scrub(line))}`)
  if (input.slotLines.length > SLOT_LINES_LISTED)
    lines.push(`- slot lines: and ${input.slotLines.length - SLOT_LINES_LISTED} more`)

  lines.push(
    input.queue.length === 0
      ? '- Queue by reason: nothing queued'
      : `- Queue by reason: ${input.queue
          .map(
            (q) =>
              `${q.kind} ${q.count} (oldest ${Math.max(0, Math.round((input.now.getTime() - q.since.getTime()) / 60_000))} min)`,
          )
          .join(', ')}`,
  )

  const host = input.host
  lines.push(
    host
      ? `- Host at ${iso(host.at)}: load ${figure(host.load)} (ceiling ${figure(host.loadCeiling)}), leads ${figure(host.leads)} of ${figure(host.seats)} seats, memory used ${figure(host.memoryUsedPct, '%')}, compressor ${figure(host.compressorMib, ' MiB')}, swap ${figure(host.swapUsedPct, '%')}, swapouts ${figure(host.swapoutMbPer300s, ' MiB/300s')}, pressure level ${figure(host.pressureLevel)}`
      : '- Host: no sample',
  )

  if ('failure' in input.ps) {
    lines.push(`- Processes: not read: ${oneLine(input.ps.failure)}`)
  } else {
    const rows = parsePs(input.ps.output)
    const busiest = [...rows].sort((a, b) => b.pcpu - a.pcpu || a.pid - b.pid).slice(0, BUSIEST)
    lines.push(`- The ${busiest.length} busiest processes of ${rows.length} by CPU:`)
    for (const row of busiest)
      lines.push(
        `- process pid=${row.pid} pri=${row.pri} cpu=${row.pcpu}% rss=${row.rssMib}MiB cmd=${oneLine(scrub(row.command), 140)}`,
      )
    lines.push(`- ${priorityLine(rows, input.serverPid)}`)
  }

  lines.push(`- Last deploy lines:${input.deployLines.length === 0 ? ' none read' : ''}`)
  for (const line of input.deployLines) lines.push(`- deploy log: ${oneLine(scrub(line), 200)}`)
  return lines
}
