import { describe, expect, test } from 'bun:test'
import { Fleet, NO_DIGEST } from '@software-factory/contract'
import { fleetScreen } from '../src/run.ts'

const fleet = Fleet.parse({
  builtAt: '2026-11-05T10:00:00.000Z',
  fingerprint: 'f',
  summary: { working: 0, idle: 0, done: 0, asks: 0, staleAsks: 0 },
  asks: [],
  health: [
    {
      id: 'health:issue:7:silent:abc123',
      kind: 'silent',
      text: 'Issue 7: no hook event for 25 min',
      repo: '/work/repo',
      issue: 7,
      since: '2026-11-05T09:30:00.000Z',
    },
  ],
  repos: [],
  unplaced: [],
  errors: [],
  digest: NO_DIGEST,
  issues: [
    {
      id: 7,
      title: 'Fix the thing',
      repo: '/work/repo',
      state: 'working',
      kind: 'bug',
      size: 's',
      lead: 'lead-7-1',
      updatedAt: '2026-11-05T09:00:00.000Z',
    },
  ],
  quota: [],
  queue: { effective: 'run', spawns: [] },
})

describe('fleetScreen', () => {
  test('the health lines come after the asks and before the Issues and repos', () => {
    const lines = fleetScreen(fleet).split('\n')
    const at = (title: string) => lines.indexOf(title)
    expect(at('ASKS')).toBeLessThan(at('HEALTH'))
    expect(at('HEALTH')).toBeLessThan(at('ISSUES'))
    expect(at('ISSUES')).toBeLessThan(at('REPOS'))
    expect(lines[at('ISSUES') + 1]).toBe('  7\tworking\trepo\tbug\ts\tlead-7-1\tFix the thing')
    expect(lines[at('HEALTH') + 1]).toBe(
      '  health:issue:7:silent:abc123\tsilent\trepo\t2026-11-05T09:30:00.000Z\tIssue 7: no hook event for 25 min',
    )
  })

  test('no health line is a dash', () => {
    const lines = fleetScreen({ ...fleet, health: [] }).split('\n')
    expect(lines[lines.indexOf('HEALTH') + 1]).toBe('  -')
  })
})
