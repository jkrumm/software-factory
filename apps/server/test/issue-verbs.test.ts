import { describe, expect, test } from 'bun:test'
import { answerIssue } from '../src/app/issue-answer.ts'
import { requestNote } from '../src/app/issue-new.ts'
import { issueRef } from '../src/api/issue-ref.ts'
import type { DecisionRecord } from '../src/domains/checkpoints/ports.ts'
import { issueId } from '../src/kernel/ids.ts'
import { ok } from '../src/kernel/result.ts'

const open = (id: string) => ({ id }) as unknown as DecisionRecord

function uses(ids: string[]) {
  const answered: string[] = []
  return {
    answered,
    decisions: async () => ok(ids.map(open)),
    answer: async (input: { decisionId: string; answer: unknown }) => {
      answered.push(`${input.decisionId}=${String(input.answer)}`)
      return ok({ decision: open(input.decisionId), issue: null })
    },
  }
}

describe('issueRef', () => {
  test('takes issue_12 and the bare 12, nothing else', () => {
    expect(issueRef('issue_12')).toBe(issueId(12))
    expect(issueRef('12')).toBe(issueId(12))
    expect(issueRef('0')).toBeNull()
    expect(issueRef('twelve')).toBeNull()
    expect(issueRef('decision_12')).toBeNull()
  })
})

describe('issue answer', () => {
  const issue = issueId(7)

  test('one open Decision is the one answered', async () => {
    const u = uses(['decision_a'])
    expect((await answerIssue(u as never, { issueId: issue, answer: 'yes' })).ok).toBe(true)
    expect(u.answered).toEqual(['decision_a=yes'])
  })

  test('several open and none named is ambiguous, with their ids; naming one answers it', async () => {
    const u = uses(['decision_a', 'decision_b'])
    const refused = await answerIssue(u as never, { issueId: issue, answer: 'yes' })
    expect(refused).toMatchObject({ ok: false, error: { kind: 'ambiguous', decisions: ['decision_a', 'decision_b'] } })
    expect(u.answered).toEqual([])
    expect((await answerIssue(u as never, { issueId: issue, answer: 'no', decision: 'decision_b' })).ok).toBe(true)
    expect(u.answered).toEqual(['decision_b=no'])
  })

  test('none open, and a named one that is not open, are refused', async () => {
    expect(await answerIssue(uses([]) as never, { issueId: issue, answer: 'x' })).toMatchObject({
      ok: false,
      error: { kind: 'no_open_decision' },
    })
    expect(
      await answerIssue(uses(['decision_a']) as never, { issueId: issue, answer: 'x', decision: 'decision_z' }),
    ).toMatchObject({
      ok: false,
      error: { kind: 'not_found' },
    })
  })
})

describe('the note an Issue filed by hand starts with', () => {
  test('the text, then the facts as name: value lines; nothing when there is neither', () => {
    expect(requestNote({ text: 'It loops', facts: { url: '/login', count: 3, deep: { a: 1 } } })).toBe(
      'It loops\nurl: /login\ncount: 3\ndeep: {"a":1}',
    )
    expect(requestNote({})).toBe('')
  })
})
