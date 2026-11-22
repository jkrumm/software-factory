/**
 * The step host's own retention (issue 2035). `factory-steps` on the VPS holds one worktree per project and slot (with
 * its `node_modules`, 1.6 GB for basalt-ui) and the bun cache every install shares; nothing else ever removes either, and
 * the host's disk alert pages at 85 %. One ssh of this script, at most every `TRIM_EVERY_MS`, keeps both bounded:
 *
 * - a scratch directory `~/exp<issue>` (a lead's experiment on the VPS, which nothing else ever removes) in which no
 *   file or directory changed for `EXP_IDLE_DAYS` is removed. This part needs neither the step directory nor docker; files a
 *   container left root-owned are removed by a container (the step image, else any local image) when docker answers.
 * - a slot copy (`<project>/<n>` and `<project>/<n>.run`) whose `.run` directory, rewritten by every step of the slot, has
 *   not changed for `COPY_IDLE_DAYS` is removed, then the project's bare repository prunes the worktree record. The bare
 *   repository (50 to 140 MB) stays, so the next snapshot pushes only what is new.
 * - a bun cache entry (a whole `<name>@<version>@@@1` directory, never a part of one: bun takes a half entry for a whole
 *   one) no install has read for `CACHE_IDLE_DAYS` is removed; while the cache is still over `CACHE_CAP_GIB` the age
 *   tightens to 7, 3 and then 1 day. The mount is `relatime`, so a read marks a file's access time within a day.
 *
 * The closed-Issue sweep (`scratchScript`, `sweepScript`) comes before this script: the host's `~/vps/scripts/exp-sweep.sh`
 * removes the `~/exp<issue>` and `~/agw<issue>` directories of the Issues the factory says are closed (any age, as root, so
 * a container's files go too); the VPS has no factory CLI, so the probe lists the directories and passes the closed ids.
 *
 * The slot and cache parts do nothing while a step container runs or when docker does not answer, so they never remove what
 * an install is reading; the exp part runs regardless of a running step or an unanswering docker, and uses docker only for the
 * root-owned fallback. A step that starts mid-trim and meets a removed copy fails as a host failure and runs on the mini.
 */
import { CACHE_CAP_GIB, CACHE_IDLE_DAYS, COPY_IDLE_DAYS, EXP_IDLE_DAYS } from '../../domains/capacity/remote.ts'

const KIB_PER_GIB = 1024 * 1024

/** The sweep script of the `vps` repo's checkout in the remote user's home. */
const SWEEP_SCRIPT = 'vps/scripts/exp-sweep.sh'

/** The shell script that prints `scratch <issue>` for each `~/exp<issue>` and `~/agw<issue>` directory (a symlink is skipped). */
export function scratchScript(): string {
  return [
    'cd "$HOME" || exit 0',
    'for dir in exp[0-9]* agw[0-9]*; do',
    '  [ -d "$dir" ] && [ ! -L "$dir" ] || continue',
    `  id="\${dir#exp}"; id="\${id#agw}"`,
    '  case "$id" in ""|*[!0-9]*) continue ;; esac',
    '  echo "scratch $id"',
    'done',
  ].join('\n')
}

/** The issue numbers `scratchScript` printed, in order and without a repeat (an `exp7` and an `agw7` are one Issue). */
export function parseScratch(stdout: string): number[] {
  const ids = stdout.split('\n').flatMap((line) => {
    const match = /^scratch (\d{1,9})$/.exec(line.trim())
    // an Issue number starts at 1: an `exp0` is not an Issue's directory
    const id = Number(match?.[1])
    return id >= 1 ? [id] : []
  })
  return [...new Set(ids)]
}

/**
 * The shell script that has the host's sweep remove the scratch directories of these closed Issues, as root (`sudo -n`:
 * never a password prompt). A host without the script or without passwordless sudo says so in a `trim:` line and exits 0.
 */
export function sweepScript(closed: readonly number[]): string {
  const ids = closed.filter((id) => Number.isSafeInteger(id) && id > 0).join(' ')
  return [
    'cd "$HOME" || exit 0',
    `[ -x ${SWEEP_SCRIPT} ] || { echo "trim: no ${SWEEP_SCRIPT} on the step host, closed Issues' scratch directories stay"; exit 0; }`,
    `sudo -n "$HOME/${SWEEP_SCRIPT}" --closed ${ids} 2>&1 || echo "trim: exp-sweep.sh did not finish cleanly"`,
  ].join('\n')
}

/** The shell script the step host runs (POSIX sh, run from the remote user's home); it prints a `trim:` line per kind of removal, and the probe logs each one. */
export function trimScript(input: {
  /** the label every step container carries: one running means nothing is removed */
  stepLabel: string
  copyDays?: number
  cacheDays?: number
  cacheCapGib?: number
  expDays?: number
  root?: string
}): string {
  const copyDays = input.copyDays ?? COPY_IDLE_DAYS
  const expDays = input.expDays ?? EXP_IDLE_DAYS
  const cacheDays = input.cacheDays ?? CACHE_IDLE_DAYS
  const capKib = Math.round((input.cacheCapGib ?? CACHE_CAP_GIB) * KIB_PER_GIB)
  const root = input.root ?? 'factory-steps'
  // the age the cache is trimmed at, then the tighter ones that apply only while it is over its ceiling
  const ages = [cacheDays, ...[7, 3, 1].filter((days) => days < cacheDays)]
  return [
    'cd "$HOME" || exit 0',
    // `exp` and digits only: anything else in the home is not ours; a symlink is skipped, never followed
    'exps=0',
    'for dir in exp[0-9]*; do',
    '  [ -d "$dir" ] && [ ! -L "$dir" ] || continue',
    `  case "\${dir#exp}" in *[!0-9]*) continue ;; esac`,
    `  [ -z "$(find "$dir" -mtime -${expDays} -print -quit)" ] || continue`,
    '  rm -rf "$dir" 2>/dev/null',
    // a container leaves root-owned files (cargo's target, bun's cache): rm cannot remove them, a container can
    '  if [ -d "$dir" ]; then',
    '    img=$(docker images -q --filter label=factory.image=step 2>/dev/null | head -n 1)',
    '    [ -n "$img" ] || img=$(docker images -q 2>/dev/null | head -n 1)',
    `    [ -z "$img" ] || docker run --rm --entrypoint sh -v "$PWD/$dir:/x" "$img" -c 'rm -rf /x/* /x/.[!.]* /x/..?*' >/dev/null 2>&1`,
    '    rm -rf "$dir" 2>/dev/null',
    '  fi',
    '  [ -d "$dir" ] || exps=$((exps + 1))',
    'done',
    '[ "$exps" -eq 0 ] || echo "trim: removed $exps idle exp dirs"',
    `[ -d ${root} ] || exit 0`,
    // docker not answering reads as "a step may be running": fail closed
    `running=$(docker ps -q --filter label=${input.stepLabel}) || { echo "trim: docker did not answer, no slot copy or cache entry removed"; exit 0; }`,
    '[ -z "$running" ] || { echo "trim: a step is running, no slot copy or cache entry removed"; exit 0; }',
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
