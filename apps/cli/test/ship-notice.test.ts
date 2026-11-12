import { describe, expect, test } from 'bun:test'
import type { ShipAnswer } from '@software-factory/contract'
import { shipNotice, syncNotice } from '../src/plain-forms.ts'

const SHA = 'a'.repeat(40)
const BASE = 'b'.repeat(40)

const shipped = (review: Extract<ShipAnswer['evidence'][number], { kind: 'review' }>): ShipAnswer => ({
  result: 'applied',
  issue: { id: 'issue_1', state: 'working', waitReason: null, outcome: null, version: 1 },
  evidence: [{ kind: 'commits', commits: [SHA], landedAt: SHA, mergedAt: null, deploys: true, paths: [] }, review],
})

const review = (patch: Partial<Parameters<typeof shipped>[0]>): Parameters<typeof shipped>[0] => ({
  kind: 'review',
  status: 'covered',
  tier: 'standard',
  ranges: [{ base: BASE, head: SHA }],
  uncovered: [],
  reason: null,
  ...patch,
})

describe('shipNotice', () => {
  test('a covered or not required review says nothing', () => {
    expect(shipNotice(shipped(review({})))).toBe('')
    expect(shipNotice(shipped(review({ status: 'not_required', tier: 'none' })))).toBe('')
  })

  test('an uncovered review names the commits and the ranges to /review', () => {
    const notice = shipNotice(
      shipped(
        review({
          status: 'uncovered',
          uncovered: [{ sha: SHA, subject: 'feat: x', required: 'deep' }],
          reason: 'agw does not cover the range',
        }),
      ),
    )
    expect(notice).toContain(`${SHA.slice(0, 12)} needs deep`)
    expect(notice).toContain(`Run /review on ${BASE.slice(0, 12)}..${SHA.slice(0, 12)}`)
  })

  test('an unread review names why, and an answer with no review line says nothing', () => {
    expect(shipNotice(shipped(review({ status: 'unknown', tier: null, reason: 'agw review covered exited 1' })))).toBe(
      'review: not read (agw review covered exited 1)',
    )
    expect(shipNotice({ ...shipped(review({})), evidence: [] })).toBe('')
  })
})

describe('syncNotice', () => {
  const answer = (broken: { project: string; file: 'project.yaml' | 'docs/plan.yaml'; message: string }[]) => ({
    synced: 3,
    broken: broken.map((b) => ({ ...b, issue: null })),
    retired: [],
    errors: [],
  })

  test('a clean sync says nothing', () => {
    expect(syncNotice(answer([]))).toBe('')
  })

  test('each file that does not parse is one line with its project and message', () => {
    const notice = syncNotice(
      answer([
        { project: 'basalt-ui', file: 'docs/plan.yaml', message: 'rows.4.after: at most 20' },
        { project: 'lib', file: 'project.yaml', message: 'leads: expected number' },
      ]),
    )
    expect(notice).toBe(
      'broken: basalt-ui docs/plan.yaml: rows.4.after: at most 20\nbroken: lib project.yaml: leads: expected number',
    )
  })
})
