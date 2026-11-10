import { describe, expect, test } from 'bun:test'
import { outsideProject, REPLAN_TRIGGERS, replanNote, replanTitle } from '../../src/domains/planning/replan.ts'
import { issueId } from '../../src/kernel/ids.ts'

describe('replanTitle', () => {
  test('names the project', () => expect(replanTitle('app')).toBe('Replan: app'))
})

describe('replanNote', () => {
  test('an owner Replan carries the ask and the playbook', () => {
    const note = replanNote({ project: 'app', trigger: 'owner', ask: 'drop the export work' })
    expect(note.startsWith('Replan of project app.\ntrigger: owner\nask: drop the export work')).toBe(true)
    expect(note).toContain('Playbook:')
    expect(note).toContain('factory issue ask')
    expect(note).toContain('factory issue replan')
    expect(note).not.toContain('stalled head')
  })

  test('without an ask there is no ask line', () => {
    expect(replanNote({ project: 'app', trigger: 'owner' })).not.toContain('ask:')
  })

  test('the ask is clipped to 2000 characters', () => {
    const note = replanNote({ project: 'app', trigger: 'owner', ask: 'x'.repeat(5000) })
    expect(note).toContain(`ask: ${'x'.repeat(2000)}\n`)
    expect(note).not.toContain('x'.repeat(2001))
  })

  test('a stalled Replan names the chain head', () => {
    const note = replanNote({
      project: 'app',
      trigger: 'stalled',
      stalled: {
        issue: 'issue_4',
        title: 'Wait',
        since: '2026-11-10T00:00:00.000Z',
        until: '2026-11-11T00:00:00.000Z',
        held: 3,
      },
    })
    expect(note).toContain('trigger: stalled')
    expect(note).toContain('stalled head: issue_4')
    expect(note).toContain('waiting behind it: 3')
  })

  test('stays well under 4 KB', () => {
    expect(replanNote({ project: 'app', trigger: 'owner' }).length).toBeLessThan(4096)
  })

  test('the triggers', () => expect([...REPLAN_TRIGGERS]).toEqual(['owner', 'stalled']))
})

describe('outsideProject', () => {
  const [replan, own, closed, other] = [issueId(1), issueId(2), issueId(3), issueId(4)]
  const known = new Map<ReturnType<typeof issueId>, { repo: string; state: 'open' | 'closed' }>([
    [replan, { repo: 'app', state: 'open' }],
    [own, { repo: 'app', state: 'open' }],
    [closed, { repo: 'app', state: 'closed' }],
    [other, { repo: 'lib', state: 'open' }],
  ])
  const gate = (dependents: ReturnType<typeof issueId>[], cancels: ReturnType<typeof issueId>[]) =>
    outsideProject({ replan, repo: 'app', dependents, cancels, known })

  test('the project own open Issues pass', () => expect(gate([own], [own])).toEqual([]))
  test('another repo, an unknown Issue and the Replan itself are outside', () => {
    expect(gate([other, issueId(99)], [replan])).toEqual([other, issueId(99), replan])
  })
  test('a closed dependent is outside, a closed cancel target is answered by the cancel', () => {
    expect(gate([closed], [])).toEqual([closed])
    expect(gate([], [closed])).toEqual([])
  })
})
