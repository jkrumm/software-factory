import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pollGap } from '../src/land.ts'

/**
 * `factory land` against a scratch repo: a bare origin, a clone on a factory branch, and a fake `gh` and `agw` on PATH
 * whose answers live in files of a state directory. The fake `gh pr merge` moves origin's master to the head it is given.
 */
const BIN = join(import.meta.dir, '..', 'bin', 'factory.ts')
const BRANCH = 'factory/7-1'

let dir = ''
let origin = ''
let work = ''
let state = ''
let locks = ''
const sleepers: ReturnType<typeof Bun.spawn>[] = []

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, env: { ...process.env, ...GIT_ENV }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(' ')}: ${err}`)
  return out.trim()
}

const FAKE_GH = `#!/bin/sh
S="$LAND_STATE"
echo "gh $*" >> "$S/calls"
case "$1 $2" in
  "pr view")
    [ -f "$S/no-pr" ] && { echo "no pull requests found" >&2; exit 1; }
    [ -f "$S/blip" ] && [ "$(grep -c '^gh pr view' "$S/calls")" = 2 ] && { echo "dial tcp: i/o timeout" >&2; exit 1; }
    [ -f "$S/blip-twice" ] && case "$(grep -c '^gh pr view' "$S/calls")" in 2|4) echo "dial tcp: i/o timeout" >&2; exit 1 ;; esac
    [ -f "$S/gh-fail" ] && { echo "GraphQL: Could not resolve to a Repository with the name 'o/app'." >&2; exit 1; }
    head=$(git --git-dir="$LAND_ORIGIN" rev-parse "refs/heads/$LAND_BRANCH" 2>/dev/null)
    if [ -f "$S/merged" ]; then
      printf '{"number":7,"state":"MERGED","url":"https://github.com/o/app/pull/7","headRefOid":"%s","mergeCommit":{"oid":"%s"}}' "$head" "$(cat "$S/merged")"
    else
      printf '{"number":7,"state":"OPEN","url":"https://github.com/o/app/pull/7","headRefOid":"%s","mergeCommit":null}' "$head"
    fi ;;
  "pr checks") [ -f "$S/checks-none" ] && { echo "no checks reported on the 'factory/7-1' branch" >&2; exit 1; }; [ -f "$S/checks-none-out" ] && { echo "no checks reported on the 'factory/7-1' branch"; exit 1; }; [ -f "$S/checks-blip" ] && [ "$(grep -c '^gh pr checks' "$S/calls")" = 2 ] && { echo "dial tcp: i/o timeout" >&2; exit 1; }; cat "$S/checks" ;;
  "pr merge")
    sha=""; prev=""
    for a in "$@"; do [ "$prev" = "--match-head-commit" ] && sha="$a"; prev="$a"; done
    git --git-dir="$LAND_ORIGIN" update-ref refs/heads/master "$sha" || exit 1
    echo "$sha" > "$S/merged"
    [ -f "$S/break-origin" ] && mv "$LAND_ORIGIN" "$LAND_ORIGIN.gone"
    exit 0 ;;
  "repo view") echo '{"squashMergeAllowed":true,"rebaseMergeAllowed":false,"mergeCommitAllowed":false}' ;;
  "run list") cat "$S/master-runs" ;;
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac
`

const FAKE_AGW = `#!/bin/sh
echo "agw $*" >> "$LAND_STATE/calls"
cat "$LAND_STATE/covered"
`

const GREEN =
  '[{"name":"ci","bucket":"pass","link":"https://github.com/o/app/actions/runs/1/job/1"},{"name":"lint","bucket":"skipping"}]'
const COVERED = '{"covered":true,"commits":[],"uncovered":[],"state":"covered"}'

beforeEach(async () => {
  dir = await mkdtemp('/tmp/factory-land-')
  origin = join(dir, 'origin.git')
  work = join(dir, 'work')
  state = join(dir, 'state')
  locks = join(dir, 'locks')
  await mkdir(state)
  await mkdir(join(dir, 'projects'))
  await mkdir(join(dir, 'bin'))
  await writeFile(join(dir, 'bin', 'gh'), FAKE_GH)
  await writeFile(join(dir, 'bin', 'agw'), FAKE_AGW)
  await chmod(join(dir, 'bin', 'gh'), 0o755)
  await chmod(join(dir, 'bin', 'agw'), 0o755)
  await writeFile(join(state, 'checks'), GREEN)
  await writeFile(join(state, 'covered'), COVERED)
  await writeFile(join(state, 'master-runs'), '[{"status":"completed","conclusion":"success","url":"https://ci/m"}]')

  await git(dir, 'init', '--quiet', '--bare', '--initial-branch=master', origin)
  await git(dir, 'clone', '--quiet', origin, work)
  await git(work, 'checkout', '--quiet', '-B', 'master')
  await writeFile(join(work, 'project.yaml'), 'name: app\nship:\n  - { via: pr }\n')
  await writeFile(join(work, 'README.md'), 'app\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '--quiet', '-m', 'init')
  await git(work, 'push', '--quiet', 'origin', 'master')
  await git(work, 'remote', 'set-head', 'origin', 'master')
  await git(work, 'checkout', '--quiet', '-b', BRANCH)
  await writeFile(join(work, 'feature.txt'), 'one\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '--quiet', '-m', 'feat: the feature')
  await git(work, 'push', '--quiet', 'origin', BRANCH)
  // master moves after the branch was cut, so the land rebases
  const other = join(dir, 'other')
  await git(dir, 'clone', '--quiet', origin, other)
  await writeFile(join(other, 'other.txt'), 'other\n')
  await git(other, 'add', '.')
  await git(other, 'commit', '--quiet', '-m', 'chore: someone else')
  await git(other, 'push', '--quiet', 'origin', 'master')
})

afterEach(async () => {
  for (const proc of sleepers.splice(0)) proc.kill()
  await rm(dir, { recursive: true, force: true })
})

function land(args: string[] = [], env: Record<string, string> = {}, cwd = work) {
  const proc = Bun.spawn(['bun', BIN, 'land', ...args], {
    cwd,
    env: {
      ...process.env,
      ...GIT_ENV,
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      LAND_STATE: state,
      LAND_ORIGIN: origin,
      LAND_BRANCH: BRANCH,
      FACTORY_DEPLOY_LOCK_DIR: locks,
      FACTORY_PROJECTS_DIR: join(dir, 'projects'),
      FACTORY_DEPLOY_LOCK_POLL_MS: '20',
      FACTORY_LAND_POLL_MS: '20',
      FACTORY_URL: 'http://127.0.0.1:1',
      FACTORY_TOKEN: 'test-token',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    proc,
    done: (async () => ({
      code: await proc.exited,
      out: await new Response(proc.stdout).text(),
      err: await new Response(proc.stderr).text(),
    }))(),
  }
}

const masterOf = () => git(origin, 'rev-parse', 'refs/heads/master')
const calls = async () => {
  const file = Bun.file(join(state, 'calls'))
  return (await file.exists()) ? await file.text() : ''
}

/** A land spawns bun, git and the fakes many times: seconds each on a loaded host. */
setDefaultTimeout(60_000)

describe('factory land', () => {
  test('a green run rebases, pushes, merges and prints the landed commits', async () => {
    const result = await land().done
    expect(result.err).not.toContain('refused')
    expect(result.code).toBe(0)
    const head = await git(work, 'rev-parse', 'HEAD')
    expect(await masterOf()).toBe(head)
    expect(await git(work, 'log', '-1', '--format=%s', 'HEAD~1')).toBe('chore: someone else')
    expect(result.err).toContain('land: rebase: onto origin/master')
    expect(result.err).toContain('land: ci: green')
    expect(result.err).toContain('land: merge: #7 by squash')
    expect(result.err).toContain('land: landed on master:')
    // stdout is data: the landed commits and nothing else
    expect(result.out).toMatch(/^ {2}[0-9a-f]+ feat: the feature\n$/)
    expect(await calls()).toContain(`gh pr merge 7 --squash --match-head-commit ${head}`)
    expect(await Bun.file(join(locks, 'app.merge.lock')).exists()).toBe(false)
  })

  test('an unreviewed range is refused with the review command, and nothing is pushed or merged', async () => {
    await writeFile(
      join(state, 'covered'),
      JSON.stringify({
        covered: false,
        commits: [
          { sha: 'aaaaaaaaaa', subject: 'feat: the feature', required: 'standard', coveredBy: null, reason: 'stale' },
          { sha: 'bbbbbbbbbb', subject: 'chore: small', required: 'light', coveredBy: null },
        ],
        uncovered: ['aaaaaaaaaa', 'bbbbbbbbbb'],
      }),
    )
    const before = await masterOf()
    const pushed = await git(origin, 'rev-parse', `refs/heads/${BRANCH}`)
    const result = await land().done
    expect(result.code).toBe(1)
    expect(result.err).toContain('land: review: refused: 1 commit(s) need a review: aaaaaaa (standard, stale)')
    expect(result.err).toMatch(/land: next: \/review [0-9a-f]{40}\.\.HEAD --thread factory-7-rebase/)
    expect(await masterOf()).toBe(before)
    expect(await git(origin, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(pushed)
    expect(await calls()).not.toContain('gh pr merge')
  })

  test('a light commit needs no review', async () => {
    await writeFile(
      join(state, 'covered'),
      '{"covered":false,"commits":[{"sha":"b","required":"light","coveredBy":null}],"uncovered":["b"]}',
    )
    expect((await land().done).code).toBe(0)
  })

  test('an uncovered commit agw lists without an entry of its own is refused', async () => {
    await writeFile(join(state, 'covered'), '{"covered":false,"commits":[],"uncovered":["cccccccccc"]}')
    const result = await land().done
    expect(result.code).toBe(1)
    expect(result.err).toContain('land: review: refused: 1 commit(s) need a review: ccccccc (unknown)')
    expect(await calls()).not.toContain('gh pr merge')
  })

  test('a check set that is all skipped is no CI: refused, never merged', async () => {
    await writeFile(join(state, 'checks'), '[{"name":"ci","bucket":"skipping"}]')
    const result = await land([], { FACTORY_LAND_NO_RUN_MS: '200' }).done
    expect(result.code).toBe(1)
    expect(result.err).toContain('land: ci: refused: no CI check on')
    expect(await calls()).not.toContain('gh pr merge')
  })

  test('a status from another service that passes before the CI workflow run registers is not green: waits, never merged', async () => {
    await writeFile(join(state, 'checks'), '[{"name":"Vercel","bucket":"pass","link":"https://vercel.com/o/app"}]')
    const result = await land([], { FACTORY_LAND_CI_MINUTES: '0.02', FACTORY_LAND_POLL_MS: '10' }).done
    expect(result.code).toBe(1)
    expect(result.err).toContain('land: ci: waiting for the CI workflow run on')
    expect(result.err).toContain('factory land --no-ci')
    expect(result.err).not.toContain('ci: green')
    expect(await calls()).not.toContain('gh pr merge')
  })

  test('a skipped workflow run is no CI: a status from another service that passes beside it waits, never merged', async () => {
    await writeFile(
      join(state, 'checks'),
      '[{"name":"Vercel","bucket":"pass","link":"https://vercel.com/o/app"},{"name":"ci","bucket":"skipping","link":"https://github.com/o/app/actions/runs/1/job/1"}]',
    )
    const result = await land([], { FACTORY_LAND_CI_MINUTES: '0.02', FACTORY_LAND_POLL_MS: '10' }).done
    expect(result.code).toBe(1)
    expect(result.err).toContain('land: ci: waiting for the CI workflow run on')
    expect(await calls()).not.toContain('gh pr merge')
  })

  test('a second run after a failed push resumes and lands', async () => {
    const hook = join(origin, 'hooks', 'pre-receive')
    await writeFile(hook, `#!/bin/sh\n[ -f "${join(state, 'reject')}" ] && { echo rejected >&2; exit 1; }\nexit 0\n`)
    await chmod(hook, 0o755)
    await writeFile(join(state, 'reject'), '')
    const before = await masterOf()
    const failed = await land().done
    expect(failed.code).toBe(1)
    expect(failed.err).toContain('land: push: refused:')
    expect(failed.err).toContain('land: next: factory land again')
    expect(await masterOf()).toBe(before)
    expect(await Bun.file(join(locks, 'app.merge.lock')).exists()).toBe(false)

    await rm(join(state, 'reject'))
    const again = await land().done
    expect(again.code).toBe(0)
    expect(again.err).toContain('land: rebase: already on origin/master')
    expect(await masterOf()).toBe(await git(work, 'rev-parse', 'HEAD'))

    const third = await land().done
    expect({ code: third.code, err: third.err }).toMatchObject({ code: 0 })
    expect(third.err).toContain('land: pr: #7 is already merged')
  })

  test('a held merge lock is waited for, then the land goes on', async () => {
    const holder = Bun.spawn(['sleep', '60'])
    sleepers.push(holder)
    await mkdir(locks, { recursive: true })
    await symlink(String(holder.pid), join(locks, 'app.merge.lock'))
    const before = await masterOf()
    const run = land()
    await Bun.sleep(1_500)
    expect(run.proc.exitCode).toBeNull()
    expect(await masterOf()).toBe(before)
    holder.kill()
    const result = await run.done
    expect(result.code).toBe(0)
    expect(await masterOf()).not.toBe(before)
  })

  /** Master moves again, as another lead landing in the window does: a file the branch also adds, or one it does not touch. */
  async function masterMoves(file: string, text: string): Promise<void> {
    const other = join(dir, 'other')
    await git(other, 'pull', '--quiet', '--rebase', 'origin', 'master')
    await writeFile(join(other, file), text)
    await git(other, 'add', '.')
    await git(other, 'commit', '--quiet', '-m', `chore: ${file}`)
    await git(other, 'push', '--quiet', 'origin', 'master')
  }

  test('a conflict with master is refused before the window is asked for, with the lock still held by another', async () => {
    await masterMoves('feature.txt', 'theirs\n')
    const holder = Bun.spawn(['sleep', '60'])
    sleepers.push(holder)
    await mkdir(locks, { recursive: true })
    await symlink(String(holder.pid), join(locks, 'app.merge.lock'))
    const before = await masterOf()
    const result = await land().done
    expect(result.code).toBe(1)
    expect(result.err).toContain('land: rebase: refused: the rebase onto origin/master stopped on a conflict')
    expect(result.err).not.toContain('lock: holding')
    expect(await masterOf()).toBe(before)
  })

  test('master moving under a wait for the window: a clean move is rebased onto, a conflict ends the wait at once', async () => {
    const holder = Bun.spawn(['sleep', '60'])
    sleepers.push(holder)
    await mkdir(locks, { recursive: true })
    await symlink(String(holder.pid), join(locks, 'app.merge.lock'))
    const run = land([], { FACTORY_LAND_REBASE_POLL_MS: '0' })
    await Bun.sleep(1_500)
    await masterMoves('second.txt', 'second\n')
    await Bun.sleep(1_500)
    expect(run.proc.exitCode).toBeNull()
    await masterMoves('feature.txt', 'theirs\n')
    const result = await run.done
    expect(result.code).toBe(1)
    expect(result.err).toContain('land: rebase: onto origin/master')
    expect(result.err).toContain('land: rebase: refused: the rebase onto origin/master stopped on a conflict')
    expect(result.err).not.toContain('lock: holding')
  })

  test('a clean move of master during the wait is landed on top of', async () => {
    const holder = Bun.spawn(['sleep', '60'])
    sleepers.push(holder)
    await mkdir(locks, { recursive: true })
    await symlink(String(holder.pid), join(locks, 'app.merge.lock'))
    const run = land([], { FACTORY_LAND_REBASE_POLL_MS: '0' })
    await Bun.sleep(1_500)
    await masterMoves('second.txt', 'second\n')
    await Bun.sleep(1_500)
    holder.kill()
    const result = await run.done
    expect(result.code).toBe(0)
    expect(await git(work, 'log', '-1', '--format=%s', 'HEAD~1')).toBe('chore: second.txt')
    expect(await masterOf()).toBe(await git(work, 'rev-parse', 'HEAD'))
  })

  test('a held lock past the wait is exit 75 and nothing moves', async () => {
    const holder = Bun.spawn(['sleep', '60'])
    sleepers.push(holder)
    await mkdir(locks, { recursive: true })
    await symlink(String(holder.pid), join(locks, 'app.merge.lock'))
    const before = await masterOf()
    const result = await land([], { FACTORY_MERGE_LOCK_WAIT_MS: '100' }).done
    expect(result.code).toBe(75)
    expect(await masterOf()).toBe(before)
  })

  test('red CI is refused with the failing check, and nothing is merged', async () => {
    await writeFile(
      join(state, 'checks'),
      '[{"name":"unit","bucket":"fail","link":"https://ci/9"},{"name":"lint","bucket":"pass"}]',
    )
    const before = await masterOf()
    const result = await land().done
    expect(result.code).toBe(1)
    expect(result.err).toContain('land: ci: refused: CI on')
    expect(result.err).toContain('unit fail (https://ci/9)')
    expect(await masterOf()).toBe(before)
    expect(await calls()).not.toContain('gh pr merge')
  })

  test('a head that never gets a check is refused, never merged', async () => {
    await writeFile(join(state, 'checks'), '[]')
    const result = await land([], { FACTORY_LAND_NO_RUN_MS: '200' }).done
    expect(result.code).toBe(1)
    expect(result.err).toContain('land: ci: refused: no CI check on')
    expect(result.err).toContain('factory land --no-ci')
    expect(await calls()).not.toContain('gh pr merge')
  })

  test("the repo's make merge-guard runs, its output goes to stderr and stdout keeps the landed commits alone", async () => {
    await writeFile(join(work, 'Makefile'), 'merge-guard:\n\t@echo guard-clear\n')
    await git(work, 'add', 'Makefile')
    await git(work, 'commit', '--quiet', '-m', 'chore: a guard')
    const result = await land().done
    expect(result.code).toBe(0)
    expect(result.err).toContain('guard-clear')
    expect(result.err).toContain('land: guard: make merge-guard is clear')
    expect(result.out).not.toContain('guard-clear')
    expect(result.out).toMatch(/^( {2}[0-9a-f]+ [^\n]+\n)+$/)
  })

  test('a merge-guard whose prerequisite is missing is refused, never skipped', async () => {
    await writeFile(join(work, 'Makefile'), 'merge-guard: merge-guard.stamp\n\t@echo guard-clear\n')
    await git(work, 'add', 'Makefile')
    await git(work, 'commit', '--quiet', '-m', 'chore: a broken guard')
    const result = await land().done
    expect(result.code).toBe(1)
    expect(result.err).toContain('land: guard: refused: make merge-guard refused')
    expect(await calls()).not.toContain('gh pr merge')
  })

  test('an included merge-guard whose prerequisite is missing is refused, never skipped', async () => {
    await writeFile(join(work, 'Makefile'), 'include ci.mk\n')
    await writeFile(join(work, 'ci.mk'), 'merge-guard: merge-guard.stamp\n\t@echo guard-clear\n')
    await git(work, 'add', 'Makefile', 'ci.mk')
    await git(work, 'commit', '--quiet', '-m', 'chore: an included guard')
    const result = await land().done
    expect(result.code).toBe(1)
    expect(result.err).toContain('land: guard: refused: make -n merge-guard failed')
    expect(await calls()).not.toContain('gh pr merge')
  })

  test("a GNUmakefile's merge-guard runs, and it shadows a Makefile without one", async () => {
    await writeFile(join(work, 'GNUmakefile'), 'merge-guard:\n\t@echo gnu-guard-clear\n')
    await writeFile(join(work, 'Makefile'), 'check:\n\t@true\n')
    await git(work, 'add', 'GNUmakefile', 'Makefile')
    await git(work, 'commit', '--quiet', '-m', 'chore: a GNUmakefile guard')
    const result = await land().done
    expect(result.code).toBe(0)
    expect(result.err).toContain('gnu-guard-clear')
    expect(result.err).toContain('land: guard: make merge-guard is clear')
  })

  test('a merge-guard from an sinclude file runs', async () => {
    await writeFile(join(work, 'Makefile'), 'sinclude ci.mk\n')
    await writeFile(join(work, 'ci.mk'), 'merge-guard:\n\t@echo guard-clear\n')
    await git(work, 'add', 'Makefile', 'ci.mk')
    await git(work, 'commit', '--quiet', '-m', 'chore: an sincluded guard')
    const result = await land().done
    expect(result.code).toBe(0)
    expect(result.err).toContain('guard-clear')
    expect(result.err).toContain('land: guard: make merge-guard is clear')
  })

  test('an included Makefile that defines no merge-guard falls back to the rule held here', async () => {
    await writeFile(join(work, 'Makefile'), 'include ci.mk\n')
    await writeFile(join(work, 'ci.mk'), 'check:\n\t@true\n')
    await git(work, 'add', 'Makefile', 'ci.mk')
    await git(work, 'commit', '--quiet', '-m', 'chore: an include without a guard')
    const result = await land().done
    expect(result.code).toBe(0)
    expect(result.err).toContain('land: guard: contains the default branch')
  })

  test('a fetch that fails after the merge is a warning: exit 0, and a rerun says merged', async () => {
    await writeFile(join(state, 'break-origin'), '')
    const result = await land().done
    expect(result.code).toBe(0)
    expect(result.err).toContain('land: merge: #7 by squash')
    expect(result.err).toContain('land: report: landed, but the landed commits cannot be read')
    const again = await land().done
    expect(again.code).toBe(0)
    expect(again.err).toContain('land: pr: #7 is already merged')
  })

  test('a red master is refused by the guard unless --allow-red', async () => {
    await writeFile(join(state, 'master-runs'), '[{"status":"completed","conclusion":"failure","url":"https://ci/m"}]')
    const refused = await land().done
    expect(refused.code).toBe(1)
    expect(refused.err).toContain("land: guard: refused: master's last finished CI run is failure")
    const allowed = await land(['--allow-red']).done
    expect(allowed.code).toBe(0)
  })

  test('no pull request: refused before the window, naming gh pr create', async () => {
    await writeFile(join(state, 'no-pr'), '')
    const result = await land().done
    expect(result.code).toBe(1)
    expect(result.err).toContain('land: pr: refused: no pull request for factory/7-1')
    expect(result.err).toContain('gh pr create --fill --base master')
  })

  test('a repo whose project file is host-local lands by pull request, as the file in FACTORY_PROJECTS_DIR says', async () => {
    await git(work, 'rm', '--quiet', 'project.yaml')
    await git(work, 'commit', '--quiet', '-m', 'chore: the project file is host-local')
    await writeFile(join(dir, 'projects', 'work.yaml'), 'name: work\nship:\n  - { via: pr }\n')
    await writeFile(join(state, 'no-pr'), '')
    const result = await land().done
    expect(result.code).toBe(1)
    expect(result.err).toContain('land: pr: refused: no pull request for factory/7-1')
  })

  test('a worktree outside .claude/worktrees (the wtp layout) is named by its main checkout, so its host-local file is read', async () => {
    await git(work, 'rm', '--quiet', 'project.yaml')
    await git(work, 'commit', '--quiet', '-m', 'chore: the project file is host-local')
    await writeFile(join(dir, 'projects', 'work.yaml'), 'name: work\nship:\n  - { via: pr }\n')
    await writeFile(join(state, 'no-pr'), '')
    const elsewhere = join(dir, 'wtp', 'work-factory-7-1')
    await git(work, 'checkout', '--quiet', '--detach')
    await git(work, 'worktree', 'add', '--quiet', elsewhere, BRANCH)
    const result = await land([], {}, elsewhere).done
    expect(result.code).toBe(1)
    expect(result.err).toContain('land: pr: refused: no pull request for factory/7-1')
  })

  test('a relative FACTORY_PROJECTS_DIR is refused by name, as the server refuses it', async () => {
    await git(work, 'rm', '--quiet', 'project.yaml')
    await git(work, 'commit', '--quiet', '-m', 'chore: the project file is host-local')
    const result = await land([], { FACTORY_PROJECTS_DIR: 'projects' }).done
    expect(result.code).toBe(1)
    expect(result.err).toContain('FACTORY_PROJECTS_DIR must be an absolute path, got: projects')
  })

  test('a gh failure is not "no pull request": it names gh stderr and GH_CONFIG_DIR first', async () => {
    await writeFile(join(state, 'gh-fail'), '')
    const result = await land().done
    expect(result.code).toBe(1)
    expect(result.err).toContain(
      'land: pr: refused: gh could not read the pull request for factory/7-1: GraphQL: Could not resolve to a Repository',
    )
    expect(result.err).toContain('check the gh account first')
    expect(result.err).toContain('GH_CONFIG_DIR')
    expect(result.err).not.toContain('no pull request for')
  })

  test('a gh failure while CI is polled is named once, the poll goes on and the land merges', async () => {
    await writeFile(join(state, 'blip'), '')
    const result = await land().done
    expect(result.code).toBe(0)
    expect(result.err).toContain('gh could not read the pull request for #7: dial tcp: i/o timeout')
    expect(result.err).toContain('polling again')
    expect(await calls()).toContain('gh pr merge 7')
  })

  test('a gh failure past the no-check bound is not read as "no CI check": the poll goes on', async () => {
    await writeFile(join(state, 'blip'), '')
    const result = await land([], { FACTORY_LAND_NO_RUN_MS: '0' }).done
    expect(result.err).not.toContain('no CI check')
    expect(result.code).toBe(0)
  })

  test('a blip that comes back after a good read is named again, cause and "polling again" included', async () => {
    await writeFile(join(state, 'blip-twice'), '')
    const result = await land().done
    expect(result.code).toBe(0)
    expect(result.err.split('dial tcp: i/o timeout; polling again').length - 1).toBe(2)
    expect(await calls()).toContain('gh pr merge 7')
  })

  test('a failed checks read with no JSON is named and polled again, not read as no CI check', async () => {
    await writeFile(join(state, 'checks-blip'), '')
    const result = await land([], { FACTORY_LAND_NO_RUN_MS: '0' }).done
    expect(result.code).toBe(0)
    expect(result.err).toContain('gh could not read the checks on')
    expect(result.err).toContain('dial tcp: i/o timeout; polling again')
    expect(result.err).toContain('the checks on')
    expect(result.err).toContain('not read yet')
    expect(result.err).not.toContain('no check yet')
    expect(result.err).not.toContain('no CI check')
    expect(await calls()).toContain('gh pr merge 7')
  })

  test('gh saying no checks reported is no CI check, not a blip: refused once the bound passes', async () => {
    await writeFile(join(state, 'checks-none'), '')
    const result = await land([], { FACTORY_LAND_NO_RUN_MS: '200' }).done
    expect(result.code).toBe(1)
    expect(result.err).toContain('land: ci: refused: no CI check on')
    expect(result.err).not.toContain('could not read the checks')
  })

  test('gh printing no checks reported on stdout is no CI check too', async () => {
    await writeFile(join(state, 'checks-none-out'), '')
    const result = await land([], { FACTORY_LAND_NO_RUN_MS: '200' }).done
    expect(result.code).toBe(1)
    expect(result.err).toContain('land: ci: refused: no CI check on')
    expect(result.err).not.toContain('could not read the checks')
  })

  test('a repo that ships by push lands by pushing to the default branch, with no CI wait and no merge', async () => {
    await writeFile(join(work, 'project.yaml'), 'name: app\nship:\n  - { via: push }\n')
    await git(work, 'commit', '--quiet', '-am', 'chore: ship by push')
    const result = await land().done
    expect(result.code).toBe(0)
    expect(await masterOf()).toBe(await git(work, 'rev-parse', 'HEAD'))
    expect(result.err).toContain('land: push:')
    expect(await calls()).not.toContain('gh pr')
  })
})

describe('pollGap', () => {
  test('grows from the base to four times it, and no further', () => {
    expect(pollGap(15_000, 0, '')).toBe(15_000)
    expect(pollGap(15_000, 4, '')).toBe(30_000)
    expect(pollGap(15_000, 12, '')).toBe(60_000)
    expect(pollGap(15_000, 100, '')).toBe(60_000)
  })

  test('a secondary limit and abuse detection read as rate limited too', () => {
    expect(pollGap(15_000, 1, 'You have exceeded a secondary rate limit')).toBe(60_000)
    expect(pollGap(15_000, 1, 'abuse detection mechanism')).toBe(60_000)
  })

  test('a rate-limited read waits the longest gap at once', () => {
    expect(pollGap(15_000, 1, 'gh: API rate limit exceeded for user ID 1')).toBe(60_000)
  })
})
