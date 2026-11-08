import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import {
  ALLOW_FILE,
  checkRetiredWords,
  checkRetiredWordsIn,
  findingsIn,
  normalize,
  RETIRED,
  ROOT,
} from '../retired-words.ts'

let root: string | undefined

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function check(files: Record<string, string>, allow = '') {
  root = await mkdtemp('/tmp/factory-words-')
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), text)
  }
  return checkRetiredWords(root, allow)
}

/** Each term: text that uses it (in an identifier, a string or a comment) and the nearest text that does not. */
const FIXTURES: Record<string, { failing: string; passing: string }> = {
  mother: { failing: 'const motherSession = 1', passing: 'const leadSession = 1' },
  wave: { failing: "const name = 'wave 3'", passing: "const name = 'plan row 3' // microwave" },
  initiative: { failing: '// the initiative', passing: '// the plan' },
  park: { failing: 'type ParkedIssue = 1', passing: 'type StalledIssue = 1 // sparkle, Parker' },
  manifest: { failing: 'readManifest()', passing: 'readProject()' },
  ticket: { failing: 'ticket_id', passing: 'issue_id' },
  'linked issue': { failing: 'linkedIssues', passing: 'chainedIssues' },
  scorer: { failing: 'new Scorer()', passing: 'new Loop()' },
  babysitter: { failing: "'babysitter'", passing: "'steward'" },
  'ask judge': { failing: 'FACTORY_ASK_JUDGE', passing: 'FACTORY_JUDGE // ask the Judge? no: ask, then judge' },
  'light review': { failing: 'lightReview', passing: 'standardReview' },
  'per-commit coverage': { failing: '// per-commit coverage', passing: '// per commit' },
  'taste gate': { failing: 'taste-gate', passing: 'checkpoint' },
  'decision card': { failing: 'DecisionCard', passing: 'Decision' },
  'hands-only': { failing: '// hands-only asks', passing: '// errands' },
  'human queue': { failing: 'humanQueue', passing: 'errandQueue' },
  'zero-touch': { failing: 'zero_touch', passing: 'avoidable_touch' },
  classify: { failing: 'classifier.run()', passing: 'triage.run() // classification of nothing' },
  dedup: { failing: 'dedupe(signals)', passing: 'triage(signals)' },
}

describe('every retired term has a failing and a passing fixture', () => {
  test('the fixtures cover the whole list', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(RETIRED.map((r) => r.term).sort())
  })
  for (const { term } of RETIRED) {
    test(term, () => {
      const fixture = FIXTURES[term]
      expect(findingsIn('x.ts', fixture?.failing ?? '').map((f) => f.term)).toContain(term)
      expect(findingsIn('x.ts', fixture?.passing ?? '')).toEqual([])
    })
  }
})

test('identifiers are split into words, case-insensitive', () => {
  expect(normalize('askJudge ASK_JUDGE ask-judge HTTPParkedState')).toBe(
    'ask judge ask judge ask judge http parked state',
  )
})

describe('the scan', () => {
  test('scans apps, packages, tests and scripts; not docs', async () => {
    const problems = await check({
      'apps/server/src/a.ts': 'const wave = 1\n',
      'docs/b.md': 'wave\n',
    })
    expect(problems).toEqual([
      'apps/server/src/a.ts:1: "wave" is retired (docs/language.md); say plan (rows of docs/plan.yaml)',
    ])
  })

  test('an exception with a reason lets one term through in one file', async () => {
    const files = { 'scripts/old.sh': 'parked=1\nwave=2\n' }
    expect(await check(files, 'scripts/old.sh park  # the old core')).toEqual([
      'scripts/old.sh:2: "wave" is retired (docs/language.md); say plan (rows of docs/plan.yaml)',
    ])
    expect(await check(files, 'scripts/old.sh *  # the old core')).toEqual([])
  })

  test('an exception without a reason, for no term, or matching nothing fails', async () => {
    const files = { 'scripts/old.sh': 'parked=1\n' }
    expect(await check(files, 'scripts/old.sh park')).toContain(
      'retired-words.allow:1: needs "<path> <term or *>  # <reason>"',
    )
    expect(await check(files, 'scripts/old.sh hold  # x')).toContain(
      'retired-words.allow:1: "hold" is not a retired term',
    )
    expect(await check({}, 'scripts/gone.sh park  # x')).toEqual([
      'retired-words.allow:1: scripts/gone.sh park matches nothing any more; delete it',
    ])
  })
})

describe('--files mode', () => {
  test('scans exactly the named files, docs included, and applies their exceptions', async () => {
    root = await mkdtemp('/tmp/factory-words-')
    await writeFile(join(root, 'a.md'), 'a wave\nparked\n')
    await writeFile(join(root, 'b.md'), 'the initiative\n')
    expect(await checkRetiredWordsIn(root, ['a.md'], 'a.md park  # history')).toEqual([
      'a.md:1: "wave" is retired (docs/language.md); say plan (rows of docs/plan.yaml)',
    ])
  })

  test('an exception that matches nothing in the named files is not reported', async () => {
    root = await mkdtemp('/tmp/factory-words-')
    await writeFile(join(root, 'a.md'), 'clean\n')
    expect(await checkRetiredWordsIn(root, ['a.md'], 'a.md park  # history')).toEqual([])
  })

  test('the script prints findings on stderr, exits 1, and says "no retired words" when clean', async () => {
    root = await mkdtemp('/tmp/factory-words-')
    await writeFile(join(root, 'dirty.md'), 'a wave\n')
    const dirty = Bun.spawnSync([
      'bun',
      join(ROOT, 'scripts/retired-words.ts'),
      '--files',
      relative(ROOT, join(root, 'dirty.md')),
    ])
    expect(dirty.exitCode).toBe(1)
    expect(dirty.stderr.toString()).toContain('"wave" is retired (docs/language.md); say plan')
    const clean = Bun.spawnSync(['bun', join(ROOT, 'scripts/retired-words.ts'), '--files', 'README.md'])
    expect(clean.exitCode).toBe(0)
    expect(clean.stdout.toString()).toBe('no retired words\n')
  })
})

test('the repo holds', async () => {
  expect(await checkRetiredWords(ROOT, await readFile(ALLOW_FILE, 'utf8'))).toEqual([])
})
