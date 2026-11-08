import { expect, test } from 'bun:test'
import { FIX_CLASS_KEYS, FIX_CLASSES } from '@software-factory/contract'
import {
  batchesOf,
  batchKey,
  checkAnswer,
  parseFixSubject,
  requestOf,
  ruleClass,
  type FixCommit,
} from '../../src/domains/loops/fix-classes.ts'

const commit = (sha: string, subject: string): FixCommit => ({
  sha,
  committedAt: new Date('2026-11-01T00:00:00Z'),
  subject,
  scope: parseFixSubject(subject)?.scope ?? null,
  body: '',
  files: [],
})

test('a conventional fix subject parses with or without scope and breaking mark; anything else does not', () => {
  expect(parseFixSubject('fix: a thing')).toEqual({ scope: null, text: 'a thing' })
  expect(parseFixSubject('fix(ci): pin it')).toEqual({ scope: 'ci', text: 'pin it' })
  expect(parseFixSubject('fix(api)!: rename')).toEqual({ scope: 'api', text: 'rename' })
  expect(parseFixSubject('feat: x')).toBeNull()
  expect(parseFixSubject('fixup: x')).toBeNull()
  expect(parseFixSubject('docs: fix a typo')).toBeNull()
})

test('the scope settles tests, docs and tooling; a subject naming a review settles review; the rest is left to the workflow', () => {
  const by = (subject: string) => ruleClass(commit('abcdef1', subject))?.class ?? null
  for (const scope of ['test', 'tests', 'scenarios', 'e2e']) expect(by(`fix(${scope}): x`)).toBe('tests')
  for (const scope of ['docs', 'doc', 'readme']) expect(by(`fix(${scope}): x`)).toBe('docs')
  for (const scope of ['ci', 'deps', 'build', 'lint', 'scripts', 'release'])
    expect(by(`fix(${scope}): x`)).toBe('tooling')
  expect(by('fix(CI): x')).toBe('tooling')
  expect(by('fix: address review findings')).toBe('review')
  expect(by('fix(server): the review round 2 findings')).toBe('review')
  expect(by('fix(server): the preview pane')).toBeNull()
  expect(by('fix(server): a race in the queue')).toBeNull()
  expect(by('fix: a race')).toBeNull()
  expect(by('fix(ci,docs): mixed')).toBeNull()
  expect(by('fix(ci, deps): both tooling')).toBe('tooling')
})

test('commits are batched by 40 and a batch key follows the repo, the shas in any order and the day', () => {
  expect(batchesOf(Array.from({ length: 85 }, (_, i) => i)).map((b) => b.length)).toEqual([40, 40, 5])
  expect(batchKey('app', ['b', 'a'], '2026-11-08')).toBe(batchKey('app', ['a', 'b'], '2026-11-08'))
  expect(batchKey('app', ['a'], '2026-11-08')).not.toBe(batchKey('app', ['a'], '2026-11-09'))
  expect(batchKey('app', ['a'], '2026-11-08')).not.toBe(batchKey('other', ['a'], '2026-11-08'))
})

test('a request carries the classes and cuts the body and the files', () => {
  const long: FixCommit = { ...commit('abcdef1', 'fix: x'), body: 'b'.repeat(2_000), files: Array(30).fill('f.ts') }
  const request = requestOf('app', [long])
  expect(request.classes).toEqual(FIX_CLASSES.map((c) => ({ key: c.key, meaning: c.meaning })))
  expect(request.commits[0]?.body).toHaveLength(800)
  expect(request.commits[0]?.files).toHaveLength(20)
})

test('an answer needs exactly one known class per asked sha', () => {
  const request = requestOf('app', [commit('aaaaaaa', 'fix: a'), commit('bbbbbbb', 'fix: b')])
  const answer = (sha: string, cls = 'logic') => ({ sha, class: cls, reason: 'r' })
  expect(FIX_CLASS_KEYS).toContain('logic')
  expect(checkAnswer(request, { answers: [answer('aaaaaaa'), answer('bbbbbbb', 'other')] }).ok).toBe(true)
  expect(checkAnswer(request, { answers: [answer('aaaaaaa')] })).toMatchObject({ ok: false })
  expect(checkAnswer(request, { answers: [answer('aaaaaaa'), answer('aaaaaaa'), answer('bbbbbbb')] })).toMatchObject({
    ok: false,
  })
  expect(checkAnswer(request, { answers: [answer('aaaaaaa'), answer('ccccccc')] })).toMatchObject({ ok: false })
  expect(checkAnswer(request, { answers: [answer('aaaaaaa', 'nonsense'), answer('bbbbbbb')] })).toMatchObject({
    ok: false,
  })
})
