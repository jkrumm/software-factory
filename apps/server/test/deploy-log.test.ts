import { expect, test } from 'bun:test'
import { deployDays } from '../src/read/deploy-log.ts'

const window = { from: new Date('2026-11-12T00:00:00Z'), to: new Date('2026-11-14T12:00:00Z') }

const log = `
2026-11-11T23:50:00Z start pid=1 ref=master
2026-11-11T23:50:30Z end pid=1 rc=0
2026-11-12T08:00:00Z start pid=2 ref=master
2026-11-12T08:00:30Z end pid=2 rc=0
2026-11-13T08:00:00Z start pid=3 ref=master
2026-11-13T08:00:40Z end pid=3 rc=0 unreachable_s=17
2026-11-13T09:00:00Z start pid=4 ref=master
2026-11-13T09:00:05Z end pid=4 rc=0 skipped=live
2026-11-13T10:00:00Z start pid=5 ref=master
2026-11-13T10:10:00Z end pid=5 rc=1 unreachable_s=600
2026-11-13T11:00:00Z start pid=6 ref=master
2026-11-13T11:00:02Z end pid=6 rc=1
2026-11-14T08:00:00Z start pid=7 ref=master
2026-11-14T08:00:30Z end pid=7 rc=0 unreachable_s=9
2026-11-14T09:00:00Z start pid=8 ref=master
garbage line
`

test('deploys by the UTC day they ended: restarts, skips, failures and the unreachable seconds', () => {
  expect(deployDays(log, window)).toEqual([
    { day: '2026-11-12', deploys: 1, restarts: 1, skipped: 0, failed: 0, unreachableSeconds: 0, longestSeconds: 0 },
    { day: '2026-11-13', deploys: 4, restarts: 2, skipped: 1, failed: 2, unreachableSeconds: 617, longestSeconds: 600 },
    { day: '2026-11-14', deploys: 1, restarts: 1, skipped: 0, failed: 0, unreachableSeconds: 9, longestSeconds: 9 },
  ])
})

test('no log, or no deploy in the window, has no days', () => {
  expect(deployDays('', window)).toEqual([])
  expect(deployDays(log, { from: new Date('2027-01-01T00:00:00Z'), to: new Date('2027-01-02T00:00:00Z') })).toEqual([])
})
