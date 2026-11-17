import { expect, test } from 'bun:test'
import { repeatedStall } from '../../src/app/loops/steward.ts'
import { QUICK_REBLOCK_MS, SAME_STALL, sameWords } from '../../src/domains/loops/stall.ts'
import type { IssueId } from '../../src/kernel/ids.ts'
import type { AnyIssueEvent } from '../../src/domains/work/events.ts'
import { filedIssue } from '../../src/domains/work/explore.ts'
import { type AppliedRecord, apply } from '../../src/domains/work/machine.ts'

const ID = 'issue_9' as IssueId
const T0 = new Date('2026-11-15T12:00:00Z')
const decision = { id: 'decision_1', summary: 'Keep paused?' }

/** The events an Issue took, each applied at its own time, as the log the steward reads. */
type Step = { at: number; event: AnyIssueEvent }

function log(steps: readonly Step[]): AppliedRecord[] {
  let issue = filedIssue(ID)
  const records: AppliedRecord[] = [
    {
      kind: 'filed',
      payload: { repo: issue.repo, title: issue.title, kind: issue.kind, origin: issue.origin },
      actor: 'factory',
      at: T0,
      version: 1,
      transition: { from: null, to: 'settling', wait: null, outcome: null },
    },
  ]
  for (const { at, event } of steps) {
    const now = new Date(T0.getTime() + at)
    const decided = apply(issue, event, { now })
    if (decided.result !== 'applied') throw new Error(`${event.kind}: ${decided.result} (${decided.detail})`)
    issue = decided.issue
    records.push({
      kind: event.kind,
      payload: event.payload,
      actor: event.actor,
      at: now,
      version: issue.version,
      transition: decided.transition,
    })
  }
  return records
}

const block = (detail: string, at: number): Step => ({
  at,
  event: { kind: 'stalled', payload: { attempt: 1, cause: 'blocked', detail }, actor: 'lead' },
})
const MIN = 60_000

/** A lead blocks, the steward asks, the Judge answers "keep paused": versions 2 to 7, the answer at minute 5. */
const FIRST = 'Paused by the owner stand-down of 2026-11-15: everything started is stopped on all hosts'
const START: Step[] = [
  { at: 0, event: { kind: 'settled', payload: {}, actor: 'factory' } },
  { at: 0, event: { kind: 'admitted', payload: {}, actor: 'factory' } },
  { at: 0, event: { kind: 'lead_started', payload: { attempt: 1, terminal: 't' }, actor: 'factory' } },
  block(FIRST, MIN),
  { at: 3 * MIN, event: { kind: 'asked', payload: { attempt: 1, decision }, actor: 'steward' } },
  {
    at: 5 * MIN,
    event: {
      kind: 'answered',
      payload: { decision: 'decision_1', answer: 'Keep paused' },
      actor: 'judge',
    },
  },
]
const REWORDED = "Still blocked, as the Judge's default answer says; no word from the owner, nothing runs anywhere"

test('the wording the lead gives its first block after the answer is far from the block before it', () => {
  expect(sameWords(FIRST, REWORDED)).toBeLessThan(SAME_STALL)
})

test('a block straight after the answer is the same stall, whatever its words', () => {
  const records = log([...START, block(REWORDED, 5 * MIN + 15_000)])
  const since = records.at(-1)?.version ?? 0
  expect(repeatedStall(ID, records, 'blocked', REWORDED, since)).toEqual({ answeredAt: 7, held: false })
})

test('a block long after the answer, in other words, is a new question', () => {
  const at = 5 * MIN + QUICK_REBLOCK_MS + MIN
  const records = log([...START, block(REWORDED, at)])
  expect(repeatedStall(ID, records, 'blocked', REWORDED, records.at(-1)?.version ?? 0)).toBeNull()
})

test('a block after a report of the lead (a ship) is a new question, however fast', () => {
  const records = log([
    ...START,
    { at: 5 * MIN + 10_000, event: { kind: 'shipped', payload: { attempt: 1 }, actor: 'lead' } },
    {
      at: 5 * MIN + 20_000,
      event: { kind: 'regressed', payload: { watch: 1, detail: 'a probe failed' }, actor: 'factory' },
    },
  ])
  expect(repeatedStall(ID, records, 'blocked', REWORDED, records.at(-1)?.version ?? 0)).toBeNull()
})

test('a note from the owner after the answer is news, however fast the block', () => {
  const records = log([
    ...START,
    { at: 5 * MIN + 5_000, event: { kind: 'noted', payload: { text: 'go on' }, actor: 'owner' } },
    block(REWORDED, 5 * MIN + 15_000),
  ])
  expect(repeatedStall(ID, records, 'blocked', REWORDED, records.at(-1)?.version ?? 0)).toBeNull()
})
