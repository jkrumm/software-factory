import { expect, test } from 'bun:test'
import {
  METHOD_FIELDS,
  allowedMethod,
  lastJudgedRun,
  makefileIn,
  nextGreens,
  probeGuard,
  readChecks,
  redRun,
  scanGuard,
} from '../src/landing.ts'

const row = (bucket: string, name = bucket) => ({ name, bucket })

test('CI by bucket: a failed or cancelled check is red, all skipped is no CI, green needs one pass', () => {
  expect(readChecks([])).toEqual({ state: 'none', failed: [] })
  expect(readChecks([row('skipping'), row('skipping')]).state).toBe('none')
  expect(readChecks([row('pass', 'a'), row('fail', 'b'), row('pending', 'c')])).toEqual({ state: 'red', failed: ['b'] })
  expect(readChecks([row('cancel', 'x')])).toEqual({ state: 'red', failed: ['x'] })
  expect(readChecks([row('pass'), row('pending')]).state).toBe('pending')
  expect(readChecks([row('pass'), row('skipping')]).state).toBe('green')
})

test('a green streak counts consecutive green readings only', () => {
  expect(nextGreens(1, readChecks([row('pass')]))).toBe(2)
  expect(nextGreens(1, readChecks([row('pending')]))).toBe(0)
})

test('the merge method is squash, else rebase, else merge', () => {
  expect(METHOD_FIELDS).toBe('squashMergeAllowed,rebaseMergeAllowed,mergeCommitAllowed')
  expect(allowedMethod({ squashMergeAllowed: true, rebaseMergeAllowed: true })).toBe('squash')
  expect(allowedMethod({ squashMergeAllowed: false, rebaseMergeAllowed: true, mergeCommitAllowed: true })).toBe(
    'rebase',
  )
  expect(allowedMethod({ mergeCommitAllowed: true })).toBe('merge')
  expect(allowedMethod({})).toBeUndefined()
  expect(allowedMethod(null)).toBeUndefined()
})

test('a branch is red when its newest judged run is not a success; cancelled, skipped and running runs judge nothing', () => {
  const done = (conclusion: string) => ({ status: 'completed', conclusion })
  expect(redRun([])).toBeUndefined()
  expect(redRun([{ status: 'in_progress' }, done('success')])).toBeUndefined()
  expect(redRun([{ status: 'in_progress' }, done('failure')])?.conclusion).toBe('failure')
  expect(redRun([done('cancelled'), done('failure')])?.conclusion).toBe('failure')
  expect(redRun([done('cancelled'), done('success')])).toBeUndefined()
  expect(lastJudgedRun([done('skipped'), done('success')])?.conclusion).toBe('success')
})

test('make reads GNUmakefile, then makefile, then Makefile', () => {
  const has =
    (...names: string[]) =>
    (name: string) =>
      names.includes(name)
  expect(makefileIn(has('Makefile', 'GNUmakefile'))).toBe('GNUmakefile')
  expect(makefileIn(has('Makefile', 'makefile'))).toBe('makefile')
  expect(makefileIn(has('Makefile'))).toBe('Makefile')
  expect(makefileIn(has())).toBeUndefined()
})

test('the guard scan finds a rule, an include that may hold one, or none', () => {
  expect(scanGuard('check:\n\ttrue\nmerge-guard:\n\t@true\n')).toBe('rule')
  expect(scanGuard('ci merge-guard: check\n')).toBe('rule')
  expect(scanGuard('MERGE_GUARD := 1\ncheck:\n')).toBe('none')
  expect(scanGuard('check:\n\t@echo merge-guard is not a target\n')).toBe('none')
  expect(scanGuard('include mk/guard.mk\n')).toBe('included')
  expect(scanGuard('-include mk/guard.mk\n')).toBe('included')
  expect(scanGuard('sinclude mk/guard.mk\n')).toBe('included')
})

test("make -n's answer: exit 0 has it, only the absent target's message is none, anything else is broken", () => {
  expect(probeGuard({ exitCode: 0, output: '' })).toBe('has')
  expect(probeGuard({ exitCode: 2, output: "make: *** No rule to make target 'merge-guard'.  Stop." })).toBe('none')
  expect(probeGuard({ exitCode: 2, output: "make: *** No rule to make target `merge-guard'.  Stop." })).toBe('none')
  expect(
    probeGuard({
      exitCode: 2,
      output: "make: *** No rule to make target 'merge-guard.stamp', needed by 'merge-guard'.  Stop.",
    }),
  ).toBe('broken')
  expect(probeGuard({ exitCode: 2, output: 'ci.mk: No such file or directory' })).toBe('broken')
})
