import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
    head=$(git --git-dir="$LAND_ORIGIN" rev-parse "refs/heads/$LAND_BRANCH" 2>/dev/null)
    if [ -f "$S/merged" ]; then
      printf '{"number":7,"state":"MERGED","url":"https://github.com/o/app/pull/7","headRefOid":"%s","mergeCommit":{"oid":"%s"}}' "$head" "$(cat "$S/merged")"
    else
      printf '{"number":7,"state":"OPEN","url":"https://github.com/o/app/pull/7","headRefOid":"%s","mergeCommit":null}' "$head"
    fi ;;
  "pr checks") cat "$S/checks" ;;
  "pr merge")
    sha=""; prev=""
    for a in "$@"; do [ "$prev" = "--match-head-commit" ] && sha="$a"; prev="$a"; done
    git --git-dir="$LAND_ORIGIN" update-ref refs/heads/master "$sha" || exit 1
    echo "$sha" > "$S/merged" ;;
  "repo view") echo '{"squashMergeAllowed":true,"rebaseMergeAllowed":false,"mergeCommitAllowed":false}' ;;
  "run list") cat "$S/master-runs" ;;
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac
`

const FAKE_AGW = `#!/bin/sh
echo "agw $*" >> "$LAND_STATE/calls"
cat "$LAND_STATE/covered"
`

const GREEN = '[{"name":"ci","bucket":"pass","link":"https://ci/1"},{"name":"lint","bucket":"skipping"}]'
const COVERED = '{"covered":true,"commits":[],"uncovered":[],"state":"covered"}'

beforeEach(async () => {
  dir = await mkdtemp('/tmp/factory-land-')
  origin = join(dir, 'origin.git')
  work = join(dir, 'work')
  state = join(dir, 'state')
  locks = join(dir, 'locks')
  await mkdir(state)
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

function land(args: string[] = [], env: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', BIN, 'land', ...args], {
    cwd: work,
    env: {
      ...process.env,
      ...GIT_ENV,
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      LAND_STATE: state,
      LAND_ORIGIN: origin,
      LAND_BRANCH: BRANCH,
      FACTORY_DEPLOY_LOCK_DIR: locks,
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
