import { afterAll, beforeAll, expect, test } from 'bun:test'
import { AdmitAnswer } from '@software-factory/contract'
import { setProcesses } from '../host.ts'
import { type Lab, startLab } from '../planning/lab.ts'
import { runLoop } from '../loops/support.ts'

/**
 * The loop closed end to end: the real host loop costs three finished leads of a repo by their worktrees and writes the
 * lead samples (nothing is seeded into `lead_samples`), and admission reads what it wrote and refuses the second heavy lead.
 */
let lab: Lab

beforeAll(async () => {
  lab = await startLab({
    repos: { heavy: { project: 'apiVersion: factory/v2\nname: heavy\nleads: 3\n' } },
    accounts: [{ id: 'a' }, { id: 'b' }],
    env: { FACTORY_LEADS_PER_ACCOUNT: '16', FACTORY_LOOP_HOST_MS: '3600000' },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
})

const sql = () => lab.world.db.sql

test('lead samples written by the host loop, under the project name, are what admission refuses on', async () => {
  const root = lab.root
  const peaksGib = [14, 15, 16]
  const worktrees: string[] = []
  for (const index of peaksGib.keys()) {
    const issue = await lab.file('heavy', `a finished heavy lead ${index}`)
    // an Issue of a second directory names the absolute path: the sample must still carry the project's name
    if (index === 2) await sql()`UPDATE factory.issues SET repo = ${`${root}/heavy`} WHERE id = ${issue}`
    const worktree = `${root}/.claude/worktrees/heavy-${index}`
    worktrees.push(worktree)
    await sql()`
      INSERT INTO factory.lead_attempts (issue_id, attempt, branch, worktree_path, repo_path, first_try_at)
      VALUES (${issue}, 1, ${`factory/${index}-1`}, ${worktree}, ${`${root}/heavy`}, now())`
  }
  await setProcesses(
    lab.world.bin,
    worktrees.map((cwd, index) => ({ pid: 6001 + index, ppid: 1, rssKib: (peaksGib[index] ?? 0) * 1024 * 1024, cwd })),
  )
  // the server shares one `ps` between readers for 10 s: the table the lab started with must age out
  await Bun.sleep(10_500)
  const ran = await runLoop(lab, 'host')
  expect(ran.error).toBeNull()
  expect(await sql()`SELECT DISTINCT repo FROM factory.lead_samples`).toEqual([{ repo: 'heavy' }])
  expect((await sql()`SELECT count(DISTINCT worktree)::int AS n FROM factory.lead_samples`)[0]?.n).toBe(3)

  // the processes are gone; 32 GiB host, 5 % in use
  await setProcesses(lab.world.bin, [])
  await sql()`DELETE FROM factory.host_samples`
  await sql()`
    INSERT INTO factory.host_samples (at, load, memory_used_pct, swap_used_pct, swapout_mb_per_300s)
    VALUES (now(), 1, 5, 10, 0)`

  const file = async (title: string) => {
    const issue = await lab.file('heavy', title)
    expect((await lab.cli(['planning', 'settle', '--body', JSON.stringify({ issue, after: [] })])).code).toBe(0)
    return issue
  }
  const admit = async () => {
    expect((await lab.cli(['capacity', 'refresh'])).code).toBe(0)
    const result = await lab.cli(['capacity', 'admit'])
    expect(result.code).toBe(0)
    return AdmitAnswer.parse(result.json)
  }
  const first = await file('the lone heavy lead')
  expect((await admit()).admitted.map((a) => a.issue)).toEqual([first])
  const second = await file('a second heavy lead')
  const answer = await admit()
  expect(answer.admitted).toEqual([])
  expect(answer.queue.find((e) => e.issue === second)?.reason).toMatchObject({ kind: 'memory' })
  expect(JSON.stringify(answer)).not.toContain(root)
}, 60_000)
