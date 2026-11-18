/**
 * The step host's own retention (issue 2035). `factory-steps` on the VPS holds one worktree per project and slot (with
 * its `node_modules`, 1.6 GB for basalt-ui) and the bun cache every install shares; nothing else ever removes either, and
 * the host's disk alert pages at 85 %. One ssh of this script, at most every `TRIM_EVERY_MS`, keeps both bounded:
 *
 * - a slot copy (`<project>/<n>` and `<project>/<n>.run`) whose `.run` directory, rewritten by every step of the slot, has
 *   not changed for `COPY_IDLE_DAYS` is removed, then the project's bare repository prunes the worktree record. The bare
 *   repository (50 to 140 MB) stays, so the next snapshot pushes only what is new.
 * - a bun cache entry (a whole `<name>@<version>@@@1` directory, never a part of one: bun takes a half entry for a whole
 *   one) no install has read for `CACHE_IDLE_DAYS` is removed; while the cache is still over `CACHE_CAP_GIB` the age
 *   tightens to 7, 3 and then 1 day. The mount is `relatime`, so a read marks a file's access time within a day.
 *
 * It does nothing while a step container runs or when docker does not answer, so it never removes what an install is
 * reading. A step that starts mid-trim and meets a removed copy fails as a host failure and runs on the mini.
 */
import { CACHE_CAP_GIB, CACHE_IDLE_DAYS, COPY_IDLE_DAYS } from '../../domains/capacity/remote.ts'

const KIB_PER_GIB = 1024 * 1024

/** The shell script the step host runs (POSIX sh, run from the remote user's home); its last line says what it did. */
export function trimScript(input: {
  /** the label every step container carries: one running means nothing is removed */
  stepLabel: string
  copyDays?: number
  cacheDays?: number
  cacheCapGib?: number
  root?: string
}): string {
  const copyDays = input.copyDays ?? COPY_IDLE_DAYS
  const cacheDays = input.cacheDays ?? CACHE_IDLE_DAYS
  const capKib = Math.round((input.cacheCapGib ?? CACHE_CAP_GIB) * KIB_PER_GIB)
  const root = input.root ?? 'factory-steps'
  // the age the cache is trimmed at, then the tighter ones that apply only while it is over its ceiling
  const ages = [cacheDays, ...[7, 3, 1].filter((days) => days < cacheDays)]
  return [
    'cd "$HOME" || exit 0',
    `[ -d ${root} ] || exit 0`,
    // docker not answering reads as "a step may be running": fail closed
    `running=$(docker ps -q --filter label=${input.stepLabel}) || { echo "trim: docker did not answer, nothing removed"; exit 0; }`,
    '[ -z "$running" ] || { echo "trim: a step is running, nothing removed"; exit 0; }',
    'copies=0; entries=0',
    `for run in ${root}/*/[0-9]*.run; do`,
    '  [ -d "$run" ] || continue',
    `  [ -z "$(find "$run" -maxdepth 0 -mtime -${copyDays})" ] || continue`,
    '  proj=$(dirname "$run")',
    '  rm -rf "$proj/$(basename "$run" .run)" "$run" && copies=$((copies + 1))',
    '  git -C "$proj.git" worktree prune 2>/dev/null',
    '  rmdir "$proj" 2>/dev/null',
    'done',
    `cache=${root}/.cache/bun`,
    'if [ -d "$cache" ]; then',
    `  for days in ${ages.join(' ')}; do`,
    `    [ "$days" = ${cacheDays} ] || [ "$(du -sk "$cache" | cut -f1)" -gt ${capKib} ] || break`,
    '    for entry in "$cache"/*@*@@@* "$cache"/@*/*@@@*; do',
    '      [ -d "$entry" ] || continue',
    '      [ -z "$(find "$entry" -type f -atime -"$days" -print -quit)" ] || continue',
    '      rm -rf "$entry" && entries=$((entries + 1))',
    '    done',
    '    rmdir "$cache"/@* 2>/dev/null',
    '  done',
    'fi',
    `echo "trim: removed $copies idle slot copies and $entries bun cache entries, the step host holds $(du -sk ${root} 2>/dev/null | cut -f1) KiB"`,
  ].join('\n')
}
