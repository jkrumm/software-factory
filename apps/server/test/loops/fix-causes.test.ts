import { expect, test } from 'bun:test'
import { causeOf, parseFixSubject, type FixCommit } from '../../src/domains/hygiene/fix-causes.ts'

const commit = (sha: string, subject: string): FixCommit => ({
  sha,
  committedAt: new Date('2026-11-01T00:00:00Z'),
  subject,
  scope: parseFixSubject(subject)?.scope ?? null,
})

test('a conventional fix subject parses with or without scope and breaking mark; anything else does not', () => {
  expect(parseFixSubject('fix: a thing')).toEqual({ scope: null, text: 'a thing' })
  expect(parseFixSubject('fix(ci): pin it')).toEqual({ scope: 'ci', text: 'pin it' })
  expect(parseFixSubject('fix(api)!: rename')).toEqual({ scope: 'api', text: 'rename' })
  expect(parseFixSubject('feat: x')).toBeNull()
  expect(parseFixSubject('fixup: x')).toBeNull()
  expect(parseFixSubject('docs: fix a typo')).toBeNull()
})

test('the scope settles tests, docs and tooling; a subject naming a review settles review; the rest is other', () => {
  const by = (subject: string) => causeOf(commit('abcdef1', subject)).cause
  for (const scope of ['test', 'tests', 'scenarios', 'e2e']) expect(by(`fix(${scope}): x`)).toBe('tests')
  for (const scope of ['docs', 'doc', 'readme']) expect(by(`fix(${scope}): x`)).toBe('docs')
  for (const scope of ['ci', 'deps', 'build', 'lint', 'scripts', 'release'])
    expect(by(`fix(${scope}): x`)).toBe('tooling')
  expect(by('fix(CI): x')).toBe('tooling')
  expect(by('fix: address review findings')).toBe('review')
  expect(by('fix(server): the review round 2 findings')).toBe('review')
  expect(by('fix(server): the preview pane')).toBe('other')
  expect(by('fix(server): a race in the queue')).toBe('other')
  expect(by('fix: a race')).toBe('other')
  expect(by('fix(ci,docs): mixed')).toBe('other')
  expect(by('fix(ci, deps): both tooling')).toBe('tooling')
})
