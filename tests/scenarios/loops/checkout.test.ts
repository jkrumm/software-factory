import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type Lab, startLab } from '../planning/lab.ts'
import { runLoop, working } from './support.ts'

/**
 * A repo's main checkout is shared; a lead works in its own worktree. With a live lead, a main checkout off the default
 * branch is a health line, and a note only to the lead whose branch it is (once, not one per pass), never to every lead of
 * the repo, against the real server, Postgres and git.
 */
let lab: Lab

beforeAll(async () => {
  lab = await startLab({
    leads: true,
    repos: { app: { project: 'apiVersion: factory/v2\nname: app\nleads: 8\n' } },
    env: { FACTORY_LEADS_PER_ACCOUNT: '16', FACTORY_STEWARD_MIN_STALL_MS: '0' },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(() => lab.stop())

const git = async (...args: string[]) => {
  const proc = Bun.spawn(['git', '-C', join(lab.root, 'app'), ...args], { stdout: 'pipe', stderr: 'pipe' })
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(' ')}: ${await proc.stderr.text()}`)
}

const notes = async (issue: string): Promise<string[]> => {
  const rows = await lab.world.db
    .sql`SELECT payload->>'text' AS text FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'noted' AND actor = 'steward' AND result = 'applied' ORDER BY version`
  return rows.map((row: { text: string }) => row.text).filter((text: string) => text.includes('main checkout'))
}

test('a main checkout off its default branch is a health line, and reaches no lead unless it is that lead’s branch', async () => {
  const leads = [
    await working(lab, 'app', 'the first lead stays in its worktree'),
    await working(lab, 'app', 'the second lead stays in its worktree'),
    await working(lab, 'app', 'the third lead stays in its worktree'),
  ]
  const noted = async () => (await Promise.all(leads.map(notes))).flat()
  expect((await runLoop(lab, 'steward')).error).toBeNull()
  expect(await noted()).toEqual([])

  // a branch no lead owns (the owner's, or a plan-owning session's): the health line alone, for any number of passes
  await git('checkout', '-q', '-b', 'stray')
  for (let pass = 0; pass < 2; pass++) expect((await runLoop(lab, 'steward')).error).toBeNull()
  expect(await noted()).toEqual([])
  const health = await lab.cli(['--format', 'json', 'read', 'health'])
  expect(health.code).toBe(0)
  expect(JSON.stringify(health.json)).toContain('main-checkout:app')

  await git('checkout', '-q', 'main')
  await runLoop(lab, 'steward')
  expect(JSON.stringify((await lab.cli(['--format', 'json', 'read', 'health'])).json)).not.toContain('main-checkout:')

  // the branch of one lead: that lead hears it once, and the other two never do
  const mine = leads[1] as string
  // (attempt 9: the lead's own branch, attempt 1, is checked out in its worktree)
  await git('checkout', '-q', '-b', `factory/${mine.slice('issue_'.length)}-9`)
  for (let pass = 0; pass < 2; pass++) await runLoop(lab, 'steward')
  expect(await notes(mine)).toHaveLength(1)
  expect((await notes(mine))[0]).toContain('factory/')
  expect(await noted()).toHaveLength(1)

  await git('checkout', '-q', 'main')
  await runLoop(lab, 'steward')
  expect(JSON.stringify((await lab.cli(['--format', 'json', 'read', 'health'])).json)).not.toContain('main-checkout:')
})
