import { expect, test } from 'bun:test'
import * as z from 'zod'
import { agwHygiene } from '../../src/adapters/agw/hygiene.ts'
import { agwJudge } from '../../src/adapters/agw/judge.ts'
import { agwQueue } from '../../src/adapters/agw/queue.ts'
import { agwSettle, agwSteward } from '../../src/adapters/agw/steward.ts'
import { failingOnUnavailable, isUnavailable } from '../../src/adapters/agw/unavailable.ts'
import type { AgwCall, AgwPort } from '../../src/kernel/agw.ts'
import { key } from '../../src/kernel/keys.ts'
import { err, ok, portError } from '../../src/kernel/result.ts'

/** The five fail-closed workflows: an answer that says it is unavailable is a failed call; a real answer passes through. */
const Output = z.object({ reason: z.string() })
const call: AgwCall<{ reason: string }> = {
  workflow: 'factory-queue',
  input: {},
  key: key('test', 'one'),
  output: Output,
}
const answering = (reason: string): AgwPort => ({ run: async () => ok({ reason }) as never })

test('the reasons the five workflows give when their model failed are unavailable; a judgment is not', () => {
  for (const reason of [
    'judge unavailable: model_error',
    'triage unavailable: timeout',
    'steward unavailable: error',
    'queue unavailable: invalid_output',
    'hygiene unavailable: a link leaves the checkout',
  ])
    expect(isUnavailable({ reason })).toBe(true)
  for (const reason of [
    'the service is unavailable to the public, so the Issue waits',
    'nothing scripted',
    'a judge unavailable later in the day is not this',
    '',
  ])
    expect(isUnavailable({ reason })).toBe(false)
})

test('an unavailable answer is a failed call (gone), carrying the reason', async () => {
  const result = await failingOnUnavailable(answering('queue unavailable: timeout')).run(call)
  expect(result).toMatchObject({ ok: false, error: { kind: 'gone' } })
  if (!result.ok) expect(result.error.detail).toContain('queue unavailable: timeout')
})

test('an answer with a reason of its own, and a failure of the run, pass through as they are', async () => {
  expect(await failingOnUnavailable(answering('the same files')).run(call)).toEqual({
    ok: true,
    value: { reason: 'the same files' },
  })
  const failed = err(portError('timeout', 'silent'))
  expect(await failingOnUnavailable({ run: async () => failed }).run(call)).toEqual(failed)
})

test('every adapter of the five reads the answer: the Judge, steward, settle, queue and hygiene fail on it', async () => {
  const seen: string[] = []
  const agw: AgwPort = {
    run: async (c) => {
      seen.push(c.workflow)
      const what = c.workflow === 'factory-ask' ? 'judge' : c.workflow.replace('factory-', '')
      return ok({ reason: `${what} unavailable: timeout` }) as never
    },
  }
  const k = key('test', 'adapters')
  const results = [
    await agwJudge(agw).judge({} as never, k),
    await agwSteward(agw).ask({} as never, k),
    await agwSettle(agw).settle({} as never, k),
    await agwQueue(agw).ask({} as never, k),
    await agwHygiene(agw).ask({} as never, k),
  ]
  expect(seen).toEqual(['factory-ask', 'factory-steward', 'factory-triage', 'factory-queue', 'factory-hygiene'])
  expect(results.map((r) => r.ok)).toEqual([false, false, false, false, false])
})
