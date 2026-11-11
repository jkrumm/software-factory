import { afterAll, beforeAll, expect, test } from 'bun:test'
import { setProcesses, setSessionProcesses } from '../host.ts'
import { type Lab, startLab } from '../planning/lab.ts'
import { runLoop } from './support.ts'

/**
 * The reaper against the real server and Postgres: the process table is a fake `ps`, but the processes it lists are real
 * `sleep`s this test starts (detached, so none is a child of the server) with the `FACTORY_SESSION` a lead's terminal gives.
 */
let lab: Lab
const spawned: ReturnType<typeof Bun.spawn>[] = []

const sleeper = (session: string | null) => {
  const proc = Bun.spawn(['sleep', '300'], {
    env: session === null ? process.env : { ...process.env, FACTORY_SESSION: session },
    detached: true,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  })
  spawned.push(proc)
  return proc
}

const alive = (proc: ReturnType<typeof Bun.spawn>) => proc.exitCode === null && proc.signalCode === null

const goneWithin = async (proc: ReturnType<typeof Bun.spawn>, ms: number): Promise<boolean> =>
  Promise.race([proc.exited.then(() => true), Bun.sleep(ms).then(() => false)])

beforeAll(async () => {
  lab = await startLab({ leads: true, repos: { app: { project: 'apiVersion: factory/v2\nname: app\nleads: 8\n' } } })
})

afterAll(async () => {
  for (const proc of spawned) if (alive(proc)) proc.kill('SIGKILL')
  await lab.stop()
})

const sql = () => lab.world.db.sql

const attempt = async (issue: number, finalizedAt: Date | null, keptAt: string | null = null) => {
  await sql()`
    INSERT INTO factory.lead_attempts (issue_id, attempt, branch, worktree_path, first_try_at)
    VALUES (${`issue_${issue}`}, 1, ${`factory/${issue}-1`}, ${`/nowhere/worktrees/${issue}-1`}, now())`
  if (finalizedAt)
    await sql()`
      INSERT INTO factory.lead_finalizations (issue_id, attempt, done_at, worktree_kept, worktree_path)
      VALUES (${`issue_${issue}`}, 1, ${finalizedAt}, ${keptAt === null ? null : 'uncommitted changes'}, ${keptAt})`
}

test('a process of a closed attempt is ended and recorded; a live attempt and an unknown key are left alone', async () => {
  await attempt(9001, new Date(Date.now() - 2 * 86_400_000))
  await attempt(9002, null)
  const leak = sleeper('lead-9001-1')
  const live = sleeper('lead-9002-1')
  const unknown = sleeper('lead-9999-1')
  const bystander = sleeper(null)
  const row = (p: ReturnType<typeof sleeper>, session: string | null) => ({
    pid: p.pid,
    env: session === null ? [] : [`FACTORY_SESSION=${session}`, 'HOME=/x'],
  })
  await setSessionProcesses(lab.world.bin, [
    row(leak, 'lead-9001-1'),
    row(live, 'lead-9002-1'),
    row(unknown, 'lead-9999-1'),
    row(bystander, null),
  ])

  const ran = await runLoop(lab, 'reaper')
  expect(ran.error).toBeNull()
  expect(ran.summary).toBe('reaped 1 process(es) of 1 closed attempt(s), 0 escalated')

  expect(await goneWithin(leak, 5_000)).toBe(true)
  expect([alive(live), alive(unknown), alive(bystander)]).toEqual([true, true, true])
  const rows = await sql()`SELECT pid, session, worktree, comm, signal, reason, age_s FROM factory.reaped_processes`
  expect(rows).toEqual([
    {
      pid: leak.pid,
      session: 'lead-9001-1',
      worktree: '/nowhere/worktrees/9001-1',
      comm: 'sleep',
      signal: 'SIGTERM',
      reason: 'session',
      age_s: 1800,
    },
  ])
  // the command line and environment are not stored anywhere
  expect(JSON.stringify(rows)).not.toContain('HOME=')
})

test('a second pass finds nothing left to reap', async () => {
  const ran = await runLoop(lab, 'reaper')
  expect(ran.summary).toBe('nothing to reap')
})

test('a shell in a kept worktree is left; one in a removed worktree is ended by its path', async () => {
  const old = new Date(Date.now() - 2 * 86_400_000)
  await attempt(9004, old, '/nowhere/worktrees/9004-1')
  await attempt(9005, old)
  const rescue = sleeper(null)
  const stale = sleeper(null)
  await setSessionProcesses(lab.world.bin, [
    { pid: rescue.pid, env: [] },
    { pid: stale.pid, env: [] },
  ])
  await setProcesses(lab.world.bin, [
    { pid: rescue.pid, ppid: 1, rssKib: 1024, cwd: '/nowhere/worktrees/9004-1/src' },
    { pid: stale.pid, ppid: 1, rssKib: 1024, cwd: '/nowhere/worktrees/9005-1' },
  ])
  const ran = await runLoop(lab, 'reaper')
  expect(ran.error).toBeNull()
  expect(await goneWithin(stale, 5_000)).toBe(true)
  expect(alive(rescue)).toBe(true)
  const rows = await sql()`SELECT pid, reason FROM factory.reaped_processes WHERE pid = ${stale.pid}`
  expect(rows).toEqual([{ pid: stale.pid, reason: 'worktree' }])
  await setSessionProcesses(lab.world.bin, [])
})

test('a process table that cannot be read fails the pass and ends nothing', async () => {
  await attempt(9003, new Date(Date.now() - 2 * 86_400_000))
  const leak = sleeper('lead-9003-1')
  await setSessionProcesses(lab.world.bin, [{ pid: leak.pid, env: ['FACTORY_SESSION=lead-9003-1'] }], { psFails: true })
  const ran = await runLoop(lab, 'reaper')
  expect(ran.error).toContain('nothing was ended')
  expect(await goneWithin(leak, 500)).toBe(false)
  await setSessionProcesses(lab.world.bin, [])
})
