import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { highlightRanges, highlightRuns, queryWords } from '../src/lib/highlight.ts'
import {
  type CommandEntry,
  type IssueEntry,
  issueScore,
  MAX_ISSUES,
  type PaletteSource,
  searchPalette,
  textScore,
} from '../src/lib/palette.ts'

const issue = (number: number, title: string, over: Partial<IssueEntry> = {}): IssueEntry => ({
  number,
  title,
  repo: 'argo',
  kind: 'feature',
  state: 'working',
  updatedAt: `2026-11-0${(number % 9) + 1}T10:00:00.000Z`,
  ...over,
})
const commands: CommandEntry[] = [
  { id: 'go-flow', title: 'Go to Flow', keywords: '' },
  { id: 'go-improve', title: 'Go to Improve', keywords: '' },
  { id: 'theme-dark', title: 'Switch theme: dark', keywords: 'appearance' },
]
const source = (issues: IssueEntry[]): PaletteSource => ({
  issues,
  projects: [{ name: 'argo', open: 3 }],
  artifacts: [{ id: 'art_1', title: 'Export button spec', kind: 'spec' }],
  commands,
})

test('queryWords lower-cases, splits and drops a leading #', () => {
  expect(queryWords('  #534  Export ')).toEqual(['534', 'export'])
  expect(queryWords('   ')).toEqual([])
})

test('highlightRanges marks every occurrence of every word, case-insensitively, merged', () => {
  expect(highlightRanges('Export the export button', 'export')).toEqual([
    [0, 6],
    [11, 17],
  ])
  expect(highlightRanges('Export button', 'exp but')).toEqual([
    [0, 3],
    [7, 10],
  ])
  expect(highlightRanges('abcd', 'ab bc')).toEqual([[0, 3]])
  expect(highlightRanges('#534', '#534')).toEqual([[1, 4]])
  expect(highlightRanges('nothing', 'zzz')).toEqual([])
  expect(highlightRanges('anything', '')).toEqual([])
})

test('highlightRuns cuts the text into matched and plain runs that join back to it', () => {
  const runs = highlightRuns('Fix the Export button', 'export')
  expect(runs).toEqual([
    { text: 'Fix the ', match: false },
    { text: 'Export', match: true },
    { text: ' button', match: false },
  ])
  expect(runs.map((run) => run.text).join('')).toBe('Fix the Export button')
  expect(highlightRuns('plain', 'x')).toEqual([{ text: 'plain', match: false }])
})

test('textScore: the whole query as a prefix beats words starting words, which beat a substring; every word must match', () => {
  expect(textScore('Export button', 'export')).toBe(300)
  expect(textScore('Fix export button', 'export')).toBe(200)
  expect(textScore('Fix reexport', 'export')).toBe(100)
  expect(textScore('Fix export button', 'export but')).toBe(200)
  expect(textScore('Fix export button', 'export nope')).toBe(0)
  expect(textScore('Spec', 'dark', 'appearance dark')).toBe(100)
  expect(textScore('Anything', '  ')).toBe(0)
})

test('issueScore: the exact number first, a number prefix next, then the title', () => {
  const a = issue(534, 'Palette finds issues')
  expect(issueScore(a, '534')).toBe(1000)
  expect(issueScore(a, '#534')).toBe(1000)
  expect(issueScore(a, '53')).toBe(400)
  expect(issueScore(a, '9')).toBe(0)
  expect(issueScore(issue(1, 'Build 534 things'), '534')).toBe(200)
  expect(issueScore(a, 'palette')).toBe(300)
})

test('a number finds its Issue first, even when other titles mention it', () => {
  const found = searchPalette(
    '#534',
    source([issue(7, 'Rework 534 handling'), issue(534, 'Palette'), issue(5341, 'x')]),
  )
  expect(found.issues.map((i) => i.number)).toEqual([534, 5341, 7])
})

test('words rank by prefix, then word start, then substring, and equal scores keep the API order', () => {
  const found = searchPalette(
    'export',
    source([
      issue(1, 'Fix reexport'),
      issue(2, 'Fix export button'),
      issue(3, 'Export report'),
      issue(4, 'Export again'),
      issue(5, 'Unrelated'),
    ]),
  )
  expect(found.issues.map((i) => i.number)).toEqual([3, 4, 2, 1])
})

test('at most eight Issues are listed and the rest are counted', () => {
  const many = Array.from({ length: 11 }, (_, i) => issue(i + 1, `Export ${i}`))
  const found = searchPalette('export', source(many))
  expect(found.issues).toHaveLength(MAX_ISSUES)
  expect(found.moreIssues).toBe(3)
  expect(searchPalette('export', source(many.slice(0, 2))).moreIssues).toBe(0)
})

test('a query also finds projects, artifacts and commands, each by its own words', () => {
  const found = searchPalette('arg', source([]))
  expect(found.projects.map((p) => p.name)).toEqual(['argo'])
  expect(searchPalette('spec', source([])).artifacts.map((a) => a.id)).toEqual(['art_1'])
  expect(searchPalette('art_1', source([])).artifacts).toHaveLength(1)
  expect(searchPalette('improve', source([])).commands.map((c) => c.id)).toEqual(['go-improve'])
  expect(searchPalette('dark', source([])).commands.map((c) => c.id)).toEqual(['theme-dark'])
  expect(searchPalette('zzz', source([issue(1, 'a')]))).toMatchObject({ issues: [], projects: [], commands: [] })
})

test('an empty query shows every command and the five most recently active open Issues, no projects or artifacts', () => {
  const issues = [
    ...Array.from({ length: 7 }, (_, i) => issue(i + 1, `Open ${i}`, { updatedAt: `2026-11-0${i + 1}T00:00:00.000Z` })),
    issue(99, 'Closed latest', { state: 'closed', updatedAt: '2026-11-09T00:00:00.000Z' }),
  ]
  const found = searchPalette('  ', source(issues))
  expect(found.issues.map((i) => i.number)).toEqual([7, 6, 5, 4, 3])
  expect(found.commands).toHaveLength(commands.length)
  expect(found.projects).toEqual([])
  expect(found.artifacts).toEqual([])
  expect(found.moreIssues).toBe(0)
})

describe('the palette loads before it is opened', () => {
  const shell = readFileSync(join(import.meta.dir, '../src/components/shell.tsx'), 'utf8')

  test('its chunk is fetched on idle and on hover or focus of the search button, and it mounts closed once loaded', () => {
    expect(shell).toContain('requestIdleCallback(preload')
    expect(shell).toContain('onPointerEnter={preload}')
    expect(shell).toContain('onFocus={preload}')
    expect(shell).toContain('(open || preloaded) && !mounted')
  })

  test('its data is fetched when the chunk loads, and watched only while it is open', () => {
    const palette = readFileSync(join(import.meta.dir, '../src/components/palette.tsx'), 'utf8')
    expect(shell).toContain('setTimeout(prefetchPalette, prefetchAfterMs)')
    expect(palette).toContain('useIssueCards(open)')
    expect(palette).toContain('usePaletteArtifacts(open)')
  })
})
