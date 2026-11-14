import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

const DEPLOY = join(import.meta.dir, '..', 'deploy.sh')

let dir: string
let origin: string
let clone: string

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(' ')}: ${err}`)
  return out.trim()
}

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-coalesce-')
  origin = join(dir, 'origin')
  clone = join(dir, 'repo')
  await git(dir, 'init', '--quiet', '-b', 'master', origin)
  await git(origin, 'commit', '--quiet', '--allow-empty', '-m', 'one')
  await git(dir, 'clone', '--quiet', origin, clone)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Sources deploy.sh (which runs nothing then), then runs `body` with the repo and data directories pointed at the test's. */
async function sh(body: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const script = `source "${DEPLOY}"; REPO_DIR="${clone}"; DATA_DIR="${dir}/data"; SHA_FILE="$DATA_DIR/deployed-sha"; mkdir -p "$DATA_DIR"; ${body}`
  const proc = Bun.spawn(['bash', '-c', script], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { code, out: out.trim() }
}

describe('a deploy takes the newest commit, and one that finds its commit live restarts nothing', () => {
  test('newer_on_ref prints the new head when master moved, and fails when it did not', async () => {
    const first = await git(clone, 'rev-parse', 'HEAD')
    expect(await sh(`newer_on_ref ${first}; echo "rc=$?"`)).toEqual({ code: 0, out: 'rc=1' })
    await git(origin, 'commit', '--quiet', '--allow-empty', '-m', 'two')
    await git(origin, 'commit', '--quiet', '--allow-empty', '-m', 'three')
    const newest = await git(origin, 'rev-parse', 'HEAD')
    expect((await sh(`newer_on_ref ${first}`)).out).toBe(newest)
    expect((await sh(`newer_on_ref ${newest}; echo "rc=$?"`)).out).toBe('rc=1')
  })

  test('FACTORY_DEPLOY_FORCE keeps a deploy on exactly the commit it was asked for', async () => {
    const first = await git(clone, 'rev-list', '--max-parents=0', 'HEAD')
    const result = await sh(`newer_on_ref ${first}; echo "rc=$?"`, { FACTORY_DEPLOY_FORCE: '1' })
    expect(result.out).toBe('rc=1')
  })

  test('already_live: the deployed sha, answering, is live; another sha, or one that does not answer, is not; FORCE says no', async () => {
    const body = (healthy: string, sha: string) =>
      `is_healthy() { ${healthy}; }; echo abc > "$SHA_FILE"; already_live ${sha}; echo "rc=$?"`
    expect((await sh(body('true', 'abc'))).out).toBe('rc=0')
    expect((await sh(body('true', 'def'))).out).toBe('rc=1')
    expect((await sh(body('false', 'abc'))).out).toBe('rc=1')
    expect((await sh(body('true', 'abc'), { FACTORY_DEPLOY_FORCE: '1' })).out).toBe('rc=1')
  })
})

describe('the unreachable seconds of a deploy', () => {
  test('a closed window is unreachable_s=N, an open one says down=1', async () => {
    const closed = await sh('DOWN_AT=$(( $(date +%s) - 17 )); mark_up; unreachable_detail')
    expect(closed.out).toBe('unreachable_s=17')
    const open = await sh('DOWN_AT=$(( $(date +%s) - 5 )); unreachable_detail')
    expect(open.out).toMatch(/^unreachable_s=[5-6] down=1$/)
    expect((await sh('unreachable_detail; echo end')).out).toBe('end')
  })

  test('mark_up closes the window once: a later call (a rollback after the deploy) does not move it', async () => {
    const result = await sh(
      'DOWN_AT=$(( $(date +%s) - 10 )); mark_up; DOWN_AT=$(( $(date +%s) - 99 )); mark_up; unreachable_detail',
    )
    expect(result.out).toBe('unreachable_s=10')
  })

  test('the end line splits the window into stopped_s and started_s; only the first stop counts', async () => {
    const result = await sh(
      'DOWN_AT=$(( $(date +%s) - 30 )); STOPPED_AT=$(( $(date +%s) - 12 )); STOPPED_S=18; mark_stopped; mark_up; unreachable_detail',
    )
    expect(result.out).toBe('unreachable_s=30 stopped_s=18 started_s=12')
  })

  test('a window still open names the stop it has seen; one with no stop yet names neither half', async () => {
    const stopped = await sh('DOWN_AT=$(( $(date +%s) - 20 )); STOPPED_S=14; unreachable_detail')
    expect(stopped.out).toMatch(/^unreachable_s=2[0-1] stopped_s=14 down=1$/)
    const early = await sh('DOWN_AT=$(( $(date +%s) - 3 )); unreachable_detail')
    expect(early.out).toMatch(/^unreachable_s=[3-4] down=1$/)
  })
})
