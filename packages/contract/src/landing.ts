// The landing rules that the hygiene pass's pull request landing (server), `factory land` (cli), `make merge-guard` (scripts) and
// the brief's "has a merge guard" line each need. Pure, so the four read one rule and cannot drift apart.

/** A check of a pull request as `gh pr checks --json name,bucket` lists it. */
export interface CheckRow {
  name?: string
  bucket?: string
}

/**
 * What a pull request's checks say: `none` is no CI at all (no check, or only skipped ones: a path or `if` filter), `red` a
 * failed or cancelled check, `green` every check passed or skipped with one that passed, else `pending`.
 */
export interface CiReading {
  state: 'none' | 'pending' | 'green' | 'red'
  failed: string[]
}

/** Reads the CI of a pull request by check bucket. */
export function readChecks(rows: readonly CheckRow[]): CiReading {
  if (!rows.length) return { state: 'none', failed: [] }
  const failed = rows.filter((row) => row.bucket === 'fail' || row.bucket === 'cancel').map((row) => row.name ?? '?')
  if (failed.length) return { state: 'red', failed }
  const done = rows.every((row) => row.bucket === 'pass' || row.bucket === 'skipping')
  if (done && !rows.some((row) => row.bucket === 'pass')) return { state: 'none', failed: [] }
  return { state: done ? 'green' : 'pending', failed: [] }
}

/** Green is read this many times in a row: a workflow that registers a moment after the first read must not be merged past. */
export const GREEN_READS = 2

/** The green streak after one more reading. */
export const nextGreens = (greens: number, reading: CiReading): number => (reading.state === 'green' ? greens + 1 : 0)

/** The merge methods in the order a repo's allowed one is chosen: squash, else rebase, else merge. */
export const MERGE_METHODS = ['squash', 'rebase', 'merge'] as const
export type MergeMethod = (typeof MERGE_METHODS)[number]

/** The `gh repo view --json` field that says whether a method is allowed. */
export const methodField = (method: MergeMethod): string =>
  method === 'merge' ? 'mergeCommitAllowed' : `${method}MergeAllowed`

/** The `--json` field list that `allowedMethod` reads. */
export const METHOD_FIELDS = MERGE_METHODS.map(methodField).join(',')

/** The first method the repo allows, undefined when none is (or the answer is not readable). */
export function allowedMethod(allowed: Record<string, unknown> | null | undefined): MergeMethod | undefined {
  if (!allowed) return undefined
  return MERGE_METHODS.find((method) => allowed[methodField(method)] === true)
}

/** A finished or running CI run of a branch, as `gh run list --json status,conclusion,url` lists it. */
export interface BranchRun {
  status?: string
  conclusion?: string
  url?: string
}

/**
 * The run that says whether a branch is red: the newest finished one. A cancelled run was superseded and a skipped one
 * judged nothing, so neither counts; a run still running does not either. Undefined when no run says anything.
 */
export function lastJudgedRun(runs: readonly BranchRun[]): BranchRun | undefined {
  return runs.find(
    (run) => run.status === 'completed' && run.conclusion !== 'cancelled' && run.conclusion !== 'skipped',
  )
}

/** The run that makes the branch red (its last judged run is not a success), undefined when the branch is not red. */
export function redRun(runs: readonly BranchRun[]): BranchRun | undefined {
  const last = lastJudgedRun(runs)
  return last && last.conclusion !== 'success' ? last : undefined
}

/** The Makefile names `make` reads, first found wins (GNU make's order). */
export const MAKEFILE_NAMES = ['GNUmakefile', 'makefile', 'Makefile'] as const

/** The Makefile `make` reads in a directory: the first of `MAKEFILE_NAMES` that `exists`. */
export const makefileIn = (exists: (name: string) => boolean): string | undefined => MAKEFILE_NAMES.find(exists)

/** A Makefile rule named `merge-guard`, alone or among others (`a merge-guard: b`). */
const GUARD_RULE = /^(?:[\w.-]+\s+)*merge-guard(?:\s+[\w.-]+)*\s*:(?!=)/m
/** An `include` can define the rule in a file a scan of the text does not see. */
const INCLUDE = /^-?s?include\s/m

/** What the text of a Makefile says of a `merge-guard` target: it has the rule, it may have it in an included file, or it has none. */
export function scanGuard(text: string): 'rule' | 'included' | 'none' {
  if (GUARD_RULE.test(text)) return 'rule'
  return INCLUDE.test(text) ? 'included' : 'none'
}

/** make's message when no rule makes `merge-guard` itself (GNU make 3.81 opens the quote with a backtick). */
const ABSENT_GUARD = /No rule to make target [`']merge-guard'\.\s+Stop\./

/**
 * What `make -n merge-guard` (run under `LC_ALL=C`, with stderr and stdout read together) says: the repo has the guard, has none
 * (only make's message for the absent target itself), or its Makefile is broken (a missing include or prerequisite), which is
 * never read as no guard.
 */
export function probeGuard(probe: { exitCode: number; output: string }): 'has' | 'none' | 'broken' {
  if (probe.exitCode === 0) return 'has'
  return ABSENT_GUARD.test(probe.output) ? 'none' : 'broken'
}
