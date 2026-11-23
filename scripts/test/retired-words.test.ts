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
  'specs not needed': { failing: 'specs_not_needed', passing: 'asks_not_needed' },
  'spec screen': { failing: 'specScreen(deps)', passing: 'specPathOf(input) // a screen of signals' },
  'needed me': { failing: 'needed_me', passing: 'asks_not_needed // he needed it; tell me' },
  'ask judge': { failing: 'FACTORY_ASK_JUDGE', passing: 'FACTORY_JUDGE // ask the Judge? no: ask, then judge' },
  'light review': { failing: 'lightReview', passing: 'standardReview' },
  'per-commit coverage': { failing: '// per-commit coverage', passing: '// per commit' },
  'taste gate': { failing: 'taste-gate', passing: 'checkpoint' },
  'decision card': { failing: 'DecisionCard', passing: 'Decision' },
  'hands-only': { failing: '// hands-only asks', passing: '// errands' },
  'human queue': { failing: 'humanQueue', passing: 'errandQueue' },
  'zero-touch': { failing: 'zero_touch', passing: 'avoidable_touch' },
  classify: { failing: 'classifier.run()', passing: 'triage.run() // classification of nothing' },
  board: { failing: '// the board of Issues', passing: '// the Flow screen // dashboard, keyboard' },
  dedup: { failing: 'dedupe(signals)', passing: 'triage(signals)' },
  'seat bonus': { failing: 'seatBonus(input)', passing: 'allowanceBonus(input) // the seat a lead runs on' },
  'idle seat': { failing: 'idleSeatHours', passing: 'idleAllowanceHours' },
  'seat-hours': { failing: "'Idle seat-hours'", passing: "'Idle allowance-hours' // seat: tier and effort" },
  'free seat': {
    failing: "'Ready: waits only for a free seat.'",
    passing: "'Ready: waits only for room in the allowance.'",
  },
  'judge hold': {
    failing: "// the Judge's hold on a stall",
    passing: '// a lead holds a claim; the Judge gave a backoff',
  },
  'remote hold': {
    failing: "import { holdOf } from './remote-hold.ts'",
    passing: "import { benchOf } from './remote-bench.ts'",
  },
  'held signal': { failing: '// a held signal waits in Needs you', passing: '// a quarantined signal; a Held Issue' },
  'held class': { failing: "'Held finding classes'", passing: "'Muted finders' // held back by the cap" },
  settler: { failing: 'type Settler = string', passing: 'type Answerer = string // settled_by' },
  'settle decision': { failing: 'settleDecision(deps, id)', passing: 'tryAnswer(deps, id) // the Issue settled' },
  'settle loop': {
    failing: "import { settle } from './intake-settle.ts' // the settle pass",
    passing: '// the heal pass; the Issue is settling',
  },
  'finding class': { failing: 'FindingClassesModel', passing: 'FindersModel // a finding' },
  'fix class': { failing: 'FIX_CLASSES', passing: 'FIX_CAUSES // fix the class name' },
  'step class': { failing: 'stepClassOf(name)', passing: 'exclusiveStepOf(name) // the step: class lead' },
  'refusal class': { failing: 'refusalClass(detail)', passing: 'refusalKind(detail)' },
  'resource class': {
    failing: '// a resource class inside a repo',
    passing: '// a resource inside a repo; memory by class',
  },
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
