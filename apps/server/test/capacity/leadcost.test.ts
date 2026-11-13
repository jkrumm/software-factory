import { expect, test } from 'bun:test'
import { attribute, learnedLeadMib, type ProcInfo, type WorktreeRef } from '../../src/domains/capacity/leadcost.ts'
import { joinProcesses, parseLsofCwd, processTable } from '../../src/adapters/planning/processes.ts'

const tree = (path: string, issue: number): WorktreeRef => ({ path, repo: 'app', issue, attempt: 1 })
const proc = (
  pid: number,
  ppid: number,
  rssMib: number,
  cwd: string | null,
  footprintMib: number | null = null,
): ProcInfo => ({
  pid,
  ppid,
  rssKib: rssMib * 1024,
  footprintKib: footprintMib === null ? null : footprintMib * 1024,
  cwd,
})

test('attribute: a child with a foreign cwd is counted with its lead', () => {
  const costs = attribute(
    [
      proc(1, 0, 10, '/'),
      proc(10, 1, 300, '/w/a'),
      proc(11, 10, 700, '/Users/x/Library/chrome'),
      proc(12, 11, 100, null),
    ],
    [tree('/w/a', 1)],
  )
  expect(costs).toEqual([
    { path: '/w/a', repo: 'app', issue: 1, attempt: 1, rssMib: 1100, footprintMib: null, procs: 3 },
  ])
})

test('attribute: the footprint is summed beside RSS, shared pages left out', () => {
  const costs = attribute(
    [proc(10, 1, 300, '/w/a', 120), proc(11, 10, 700, '/elsewhere', 400), proc(12, 11, 100, null, 30)],
    [tree('/w/a', 1)],
  )
  expect(costs.map((c) => [c.rssMib, c.footprintMib])).toEqual([[1100, 550]])
})

test('attribute: a process top did not list counts at its RSS in the footprint; none listed is null', () => {
  const tree1 = attribute([proc(10, 1, 300, '/w/a', 120), proc(11, 10, 200, null)], [tree('/w/a', 1)])
  expect(tree1.map((c) => [c.rssMib, c.footprintMib])).toEqual([[500, 320]])
  const tree2 = attribute([proc(10, 1, 300, '/w/a'), proc(11, 10, 200, null)], [tree('/w/a', 1)])
  expect(tree2.map((c) => [c.rssMib, c.footprintMib])).toEqual([[500, null]])
})

test('attribute: the longest prefix wins, and /a/b is not inside /a/bc', () => {
  const costs = attribute(
    [proc(10, 1, 100, '/a/b/sub/dir'), proc(20, 1, 50, '/a/bc'), proc(30, 1, 7, '/a/b')],
    [tree('/a/b', 1), tree('/a/b/sub', 2), tree('/a/bcd', 3)],
  )
  expect(costs.map((c) => [c.path, c.rssMib, c.procs])).toEqual([
    ['/a/b', 7, 1],
    ['/a/b/sub', 100, 1],
  ])
})

test('attribute: a pid two worktrees claim is counted once, for the first', () => {
  const costs = attribute(
    [proc(10, 1, 100, '/w/a'), proc(11, 10, 200, '/w/b'), proc(12, 1, 50, '/w/b')],
    [tree('/w/a', 1), tree('/w/b', 2)],
  )
  expect(costs.map((c) => [c.path, c.rssMib, c.procs])).toEqual([
    ['/w/a', 300, 2],
    ['/w/b', 50, 1],
  ])
})

test('attribute: a worktree with no process has no row, an unknown cwd claims nothing, a ppid cycle ends', () => {
  const costs = attribute(
    [proc(10, 11, 1, '/w/a'), proc(11, 10, 1, null), proc(12, 1, 5, null)],
    [tree('/w/a', 1), tree('/w/z', 2)],
  )
  expect(costs.map((c) => [c.path, c.procs])).toEqual([['/w/a', 2]])
})

test('learnedLeadMib: p80 nearest rank of the newest ten, null under three attempts', () => {
  expect(learnedLeadMib([])).toBeNull()
  expect(learnedLeadMib([100, 200])).toBeNull()
  expect(learnedLeadMib([300, 100, 200])).toBe(300)
  expect(learnedLeadMib([100, 200, 300, 400, 500])).toBe(400)
  const twelve = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 9999, 9999]
  expect(learnedLeadMib(twelve)).toBe(80)
})

test('parseLsofCwd: pid and path lines pair up; noise is skipped', () => {
  const cwds = parseLsofCwd('p12\nn/w/a b\np13\nn/\npx\nn/lost\np14\n')
  expect([...cwds]).toEqual([
    [12, '/w/a b'],
    [13, '/'],
  ])
  const rows = [{ pid: 12, ppid: 1, cpuPct: 0, rssKib: 5, command: 'x' }]
  expect(joinProcesses(rows, cwds)).toEqual([{ pid: 12, ppid: 1, rssKib: 5, footprintKib: null, cwd: '/w/a b' }])
  expect(joinProcesses(rows, cwds, new Map([[12, 3]]))).toEqual([
    { pid: 12, ppid: 1, rssKib: 5, footprintKib: 3, cwd: '/w/a b' },
  ])
})

test('processTable: the footprints join in; a failed or throwing top leaves them null, never an error', async () => {
  const rows = async () => [{ pid: 12, ppid: 1, cpuPct: 0, rssKib: 5, command: 'x' }]
  const lsofBin = '/usr/bin/true'
  expect(await processTable({ rows, lsofBin, footprints: async () => new Map([[12, 3]]) }).read()).toEqual([
    { pid: 12, ppid: 1, rssKib: 5, footprintKib: 3, cwd: null },
  ])
  expect(await processTable({ rows, lsofBin, footprints: async () => null }).read()).toEqual([
    { pid: 12, ppid: 1, rssKib: 5, footprintKib: null, cwd: null },
  ])
  const throwing = async (): Promise<null> => {
    throw new Error('top')
  }
  expect(await processTable({ rows, lsofBin, footprints: throwing }).read()).toEqual([
    { pid: 12, ppid: 1, rssKib: 5, footprintKib: null, cwd: null },
  ])
})

test('processTable: a failed ps or lsof is null, never an error', async () => {
  const rows = async () => [{ pid: 12, ppid: 1, cpuPct: 0, rssKib: 5, command: 'x' }]
  expect(await processTable({ rows, lsofBin: '/nonexistent/lsof' }).read()).toBeNull()
  expect(await processTable({ rows: async () => null, lsofBin: '/usr/bin/true' }).read()).toBeNull()
  expect(await processTable({ rows, lsofBin: '/usr/bin/false' }).read()).toBeNull()
})
