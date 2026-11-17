import { expect, test } from 'bun:test'
import { cooldownEnd, groupOf, planLines, planUpgrades, type UpgradeRow } from '../../src/domains/loops/upgrades.ts'

const now = new Date('2026-11-17T12:00:00Z')
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000)
const row = (name: string, size: UpgradeRow['size'], age?: number): UpgradeRow => ({
  name,
  current: '1.0.0',
  latest: size === 'major' ? '2.0.0' : '1.1.0',
  size,
  ...(age === undefined ? {} : { releasedAt: daysAgo(age) }),
})

test('groups: a scope, a name stem, never @types or a bare owner/repo', () => {
  expect(groupOf('@mantine/core')).toBe('@mantine')
  expect(groupOf('eslint-plugin-react')).toBe('eslint')
  expect(groupOf('@types/node')).toBe('@types/node')
  expect(groupOf('actions/checkout')).toBe('actions/checkout')
  expect(groupOf('hono')).toBe('hono')
})

test('cooldown: 7 days, 14 for a major; the day it opens is the release plus the cooldown', () => {
  expect(cooldownEnd(row('a', 'minor', 3))?.toISOString()).toBe('2026-11-21T12:00:00.000Z')
  expect(cooldownEnd(row('a', 'major', 3))?.toISOString()).toBe('2026-11-28T12:00:00.000Z')
  expect(cooldownEnd(row('a', 'minor'))).toBeUndefined()
})

test('a version of exactly the cooldown is old enough; a younger one is held and in no batch', () => {
  const plan = planUpgrades([row('old', 'minor', 7), row('new', 'minor', 6), row('major-new', 'major', 13)], now)
  expect(plan.held.map((h) => h.row.name)).toEqual(['major-new', 'new'])
  expect(plan.batches.flatMap((b) => b.rows.map((r) => r.name))).toEqual(['old'])
})

test('batches: the rest first, then groups, then each major alone; a group of majors is one batch', () => {
  const plan = planUpgrades(
    [
      row('zeta', 'patch'),
      row('hono', 'minor'),
      row('vite', 'minor'),
      row('vite-plugin-x', 'patch'),
      row('left-pad', 'major'),
      row('@a/one', 'major'),
      row('@a/two', 'major'),
    ],
    now,
  )
  expect(plan.batches.map((b) => [b.kind, b.label, b.rows.map((r) => r.name)])).toEqual([
    ['rest', 'patches and minors', ['hono', 'zeta']],
    ['together', 'vite', ['vite', 'vite-plugin-x']],
    ['major', '@a, majors that move together', ['@a/one', '@a/two']],
    ['major', 'left-pad', ['left-pad']],
  ])
})

test('a long plan is cut at 60 packages and says so; an all-held plan says there is no batch', () => {
  const many = Array.from({ length: 70 }, (_, i) => row(`p${String(i).padStart(2, '0')}`, 'minor'))
  const lines = planLines(planUpgrades(many, now), now)
  expect(lines.filter((l) => l.startsWith('  p')).length).toBe(60)
  expect(lines.at(-1)).toContain('and 10 more')
  expect(planLines(planUpgrades([row('x', 'minor', 1)], now), now).join('\n')).toContain('none, every outdated version')
})
