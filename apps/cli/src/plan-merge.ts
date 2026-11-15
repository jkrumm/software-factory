import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { EXIT, usage } from './exit.ts'
import type { Io } from './operation.ts'

/**
 * The three-way merge of an append-only aggregator (`docs/plan.yaml`): `ours` is the file as the rebase's target has it
 * (master), `theirs` the branch's commit, `base` their common ancestor. When one side only appended to the base, the
 * result is the other side's file plus that tail, so two leads adding rows never clash on the last lines. A side that
 * also changed existing lines is no append: null, and the caller falls back to a line merge that shows the conflict.
 * Git's own `union` driver is not used: it drops the lines two appended rows share (a `why: |-` and its text) and
 * leaves a row corrupt.
 */
export function mergeAppends(input: { base: string; ours: string; theirs: string }): string | null {
  const { base, ours, theirs } = input
  if (ours === theirs) return ours
  if (theirs === base) return ours
  if (ours === base) return theirs
  const tailOf = (side: string): string | null =>
    base.endsWith('\n') && side.startsWith(base) && side.length > base.length ? side.slice(base.length) : null
  const theirsTail = tailOf(theirs)
  if (theirsTail === null) return null
  return `${ours}${ours.endsWith('\n') ? '' : '\n'}${theirsTail}`
}

/**
 * `factory plan merge <base> <ours> <theirs>`: a git merge driver (`git -c merge.plan.driver='factory plan merge %O %A %B'`
 * with `docs/plan.yaml merge=plan` in `.gitattributes`). Writes the merge into `<ours>` and exits 0, or, when a side
 * changed more than the end of the file, leaves git's own line merge with its conflict markers in `<ours>` and exits 1.
 * Offline; no server, no token.
 */
export function planMergeVerb(argv: readonly string[], io: Io): number {
  const [base, ours, theirs, ...rest] = argv
  if (base === undefined || ours === undefined || theirs === undefined || rest.length > 0) {
    throw usage(
      'usage: plan merge <base> <ours> <theirs>',
      "factory plan merge %O %A %B (as a git merge driver's command)",
    )
  }
  const merged = mergeAppends({
    base: readFileSync(base, 'utf8'),
    ours: readFileSync(ours, 'utf8'),
    theirs: readFileSync(theirs, 'utf8'),
  })
  if (merged !== null) {
    writeFileSync(ours, merged)
    return EXIT.ok
  }
  const lineMerge = spawnSync('git', ['merge-file', ours, base, theirs], { stdio: 'inherit' })
  if (lineMerge.status === 0) return EXIT.ok
  io.err('plan merge: a side changed more than the end of the file; resolve the conflict markers by hand\n')
  return 1
}
