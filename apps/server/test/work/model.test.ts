import { expect, test } from 'bun:test'
import { ACTORS } from '../../src/kernel/events.ts'
import type { IssueId } from '../../src/kernel/ids.ts'
import { type AnyIssueEvent, PAYLOADS } from '../../src/domains/work/events.ts'
import { candidates, filedIssue } from '../../src/domains/work/explore.ts'
import {
  type Issue,
  type State,
  STATES,
  WAIT_REASONS,
  WAITS,
  type Wait,
  type WaitReason,
} from '../../src/domains/work/issue.ts'
import { type AppliedRecord, apply, replay } from '../../src/domains/work/machine.ts'
import { TABLE } from '../../src/domains/work/table.ts'

/**
 * The model test (`docs/architecture.md` §The Issue state machine): random event sequences, each from its own seed,
 * against the invariants. A failure names its seed; `WORK_MODEL_SEED=<seed> bun test apps/server/test/work` plays that
 * sequence alone.
 */
const SEQUENCES = 20_000
const MAX_STEPS = 60
const DAY_MS = 24 * 60 * 60_000

/** mulberry32: a small seeded PRNG, the same numbers for the same seed everywhere. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const pick = <T>(random: () => number, list: readonly T[]): T => {
  const value = list[Math.floor(random() * list.length)]
  if (value === undefined) throw new Error('pick from an empty list')
  return value
}

const describeEvent = (event: AnyIssueEvent) => `${event.kind} by ${event.actor} ${JSON.stringify(event.payload)}`

interface Seen {
  states: Set<State>
  waits: Set<WaitReason>
  applied: Set<string>
}

/** One sequence; throws with the seed, the step and the trace when an invariant breaks. */
function play(seed: number, seen: Seen, extra?: (issue: Issue) => string | null): void {
  const random = prng(seed)
  const trace: string[] = []
  const fail = (step: number, what: string): never => {
    throw new Error(`model seed ${seed}, step ${step}: ${what}\n  ${trace.join('\n  ')}`)
  }
  const id = 'issue_model' as IssueId
  let now = new Date('2026-01-01T00:00:00Z')
  let issue: Issue = filedIssue(id)
  const records: AppliedRecord[] = [
    {
      kind: 'filed',
      payload: { repo: 'r', title: 't', kind: 'bug', origin: 'you' },
      actor: 'factory',
      at: now,
      version: 1,
      transition: { from: null, to: 'settling', wait: null, outcome: null },
    },
  ]
  const effectPayloads = new Map<string, string>()
  /** notes recorded while the Issue waits: the move back to work must tell the lead every one */
  let waitingNotes: number[] = []
  const steps = 1 + Math.floor(random() * MAX_STEPS)

  for (let step = 1; step <= steps; step++) {
    const jump = random()
    now = new Date(now.getTime() + (jump < 0.05 ? 31 * DAY_MS : Math.floor(jump * 2 * 60 * 60_000)))
    const options = candidates(issue, now)
    // Half the picks move the Issue, so a sequence gets deep: a third lead gone, a third regression, a reopen.
    const moving = options.filter((option) => apply(issue, option, { now }).result === 'applied')
    const chosen = pick(random, random() < 0.5 && moving.length ? moving : options)
    // Now and then from a sender of the wrong kind: the sender rule must refuse it.
    const event = random() < 0.1 ? { ...chosen, actor: pick(random, ACTORS) } : chosen
    if (!PAYLOADS[event.kind].safeParse(event.payload).success)
      fail(step, `a candidate does not parse: ${describeEvent(event)}`)

    let decided: ReturnType<typeof apply>
    try {
      decided = apply(issue, event, { now })
    } catch (error) {
      return fail(step, `the cell for ${issue.state} × ${event.kind} threw: ${String(error)}`)
    }
    trace.push(
      `${step}: ${issue.state}${issue.wait ? `(${issue.wait.reason})` : ''} ${describeEvent(event)} -> ${decided.result}${decided.result === 'applied' ? ` ${decided.transition.to}` : ` (${decided.detail})`}`,
    )

    if (decided.result !== 'applied') {
      if (!decided.detail) fail(step, 'a refusal or an ignore names no reason')
      continue
    }
    const next = decided.issue
    if (next.version !== issue.version + 1) fail(step, `version ${issue.version} became ${next.version}`)
    if (decided.transition.from !== issue.state) fail(step, 'the transition names another state it came from')
    if (issue.state === 'closed' && event.kind !== 'reopened') fail(step, `${event.kind} moved a closed Issue`)
    if (issue.state === 'closed' && next.state !== 'queued') fail(step, `reopened went to ${next.state}`)
    for (const effect of decided.effects) {
      const payload = JSON.stringify([effect.kind, effect.payload])
      const before = effectPayloads.get(effect.key)
      if (before !== undefined && before !== payload) fail(step, `key ${effect.key} names two different effects`)
      effectPayloads.set(effect.key, payload)
    }
    if (issue.state === 'waiting' && next.state === 'waiting' && event.kind === 'noted') waitingNotes.push(next.version)
    if (issue.state === 'waiting' && next.state === 'working') {
      const told = decided.effects.find((effect) => effect.kind === 'note_lead')
      const covered = (v: number) => told?.kind === 'note_lead' && told.payload.from <= v && v <= told.payload.version
      if (!waitingNotes.every(covered))
        fail(step, `notes ${waitingNotes.join(', ')} recorded while waiting never reach the lead`)
    }
    if (next.state !== 'waiting') waitingNotes = []
    records.push({
      kind: event.kind,
      payload: event.payload,
      actor: event.actor,
      at: now,
      version: next.version,
      transition: decided.transition,
    })
    seen.applied.add(`${issue.state}:${event.kind}`)
    issue = next
    seen.states.add(issue.state)
    checkShape(issue, now, (what) => fail(step, what))
    const broken = extra?.(issue)
    if (broken) fail(step, broken)
    if (issue.wait) seen.waits.add(issue.wait.reason)
  }

  const replayed = replay(id, records)
  if (!Bun.deepEquals(replayed, issue)) fail(steps, 'replaying the applied events gives another Issue')
}

/** The invariants of an Issue as it stands. */
function checkShape(issue: Issue, now: Date, fail: (what: string) => never): void {
  if ((issue.state === 'waiting') !== (issue.wait !== null))
    fail(`${issue.state} with wait ${JSON.stringify(issue.wait)}`)
  if ((issue.state === 'closed') !== (issue.outcome !== null)) fail(`${issue.state} with outcome ${issue.outcome}`)
  const { wait } = issue
  if (!wait) return
  const exits = candidates(issue, now).filter((event) => event.kind !== 'cancelled')
  // A review wait with Decisions open has no single leaving event: it ends with the verdict and the last answer.
  const outstanding = (w: Wait | null): number =>
    w?.reason === 'review' ? (w.verdictGiven ? 0 : 1) + (w.decisions?.length ?? 0) : 1
  const leaves = (event: AnyIssueEvent) => {
    const decided = apply(issue, event, { now })
    if (decided.result !== 'applied') return false
    return (
      decided.transition.to !== 'waiting' ||
      (wait.reason === 'review' && outstanding(decided.transition.wait) < outstanding(wait))
    )
  }
  if (WAITS[wait.reason].exit === 'machine') {
    // The lead's own verbs leave a timer wait too, but the lead is not the machine: the clock or the steward must.
    if (!exits.some((event) => (event.actor === 'factory' || event.actor === 'steward') && leaves(event))) {
      fail(`the machine wait ${wait.reason} has no exit`)
    }
    return
  }
  if (!('holds' in wait) || !wait.holds.id.trim() || !wait.holds.summary.trim()) {
    fail(`the wait on a person ${wait.reason} does not state what it holds`)
  }
  if (!exits.some(leaves)) fail(`the wait on a person ${wait.reason} has no exit`)
}

test(`the Issue machine holds its invariants over ${SEQUENCES} random sequences`, () => {
  const seen: Seen = { states: new Set(), waits: new Set(), applied: new Set() }
  const only = process.env.WORK_MODEL_SEED
  if (only) {
    play(Number(only), seen)
    return
  }
  for (let seed = 1; seed <= SEQUENCES; seed++) play(seed, seen)
  // The walk reached everything, so the invariants were tested where they matter.
  expect([...seen.states].sort()).toEqual([...STATES].sort())
  expect([...seen.waits].sort()).toEqual([...WAIT_REASONS].sort())
  expect(seen.applied.has('closed:reopened')).toBe(true)
}, 30_000)

test('a failing sequence names its seed, and the seed plays it again', () => {
  const seen: Seen = { states: new Set(), waits: new Set(), applied: new Set() }
  const working = (issue: Issue) => (issue.state === 'working' ? 'a planted invariant: never working' : null)
  const failure = (seed: number): string => {
    try {
      play(seed, seen, working)
    } catch (error) {
      return String(error)
    }
    return ''
  }
  const seed = [...Array(200).keys()].map((n) => n + 1).find((n) => failure(n) !== '')
  expect(seed).toBeDefined()
  const message = failure(seed ?? 0)
  expect(message).toContain(`model seed ${seed}, step`)
  expect(message).toContain('a planted invariant')
  expect(failure(seed ?? 0)).toBe(message)
})

test('a timer wait with no exit from the machine breaks the invariant', () => {
  const seen: Seen = { states: new Set(), waits: new Set(), applied: new Set() }
  const original = TABLE.waiting.woken
  TABLE.waiting.woken = (ctx) => (ctx.issue.wait?.reason === 'timer' ? { ignore: 'x' } : original(ctx))
  try {
    const failure = (seed: number): string => {
      try {
        play(seed, seen)
      } catch (error) {
        return String(error)
      }
      return ''
    }
    const messages = [...Array(2000).keys()].map((n) => failure(n + 1)).filter((message) => message !== '')
    expect(messages[0]).toContain('the machine wait timer has no exit')
  } finally {
    TABLE.waiting.woken = original
  }
})
