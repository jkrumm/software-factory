import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type Lab, startLab } from '../planning/lab.ts'
import { runLoop, working } from './support.ts'

/**
 * A repo's main checkout is shared; a lead works in its own worktree. With a live lead, a main checkout off the default
 * branch is one note to the lead (not one per pass) and a health line, against the real server, Postgres and git.
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

test('a main checkout off its default branch is noted once to the live lead and shows as a health line', async () => {
  const issue = await working(lab, 'app', 'the lead stays in its worktree')
  expect((await runLoop(lab, 'steward')).error).toBeNull()
  expect(await notes(issue)).toEqual([])

  await git('checkout', '-q', '-b', 'stray')
  const ran = await runLoop(lab, 'steward')
  expect(ran.error).toBeNull()
  expect(await notes(issue)).toHaveLength(1)
  expect((await notes(issue))[0]).toContain('stray')

  await runLoop(lab, 'steward')
  expect(await notes(issue)).toHaveLength(1)

  const health = await lab.cli(['--format', 'json', 'read', 'health'])
  expect(health.code).toBe(0)
  expect(JSON.stringify(health.json)).toContain('main-checkout:app')

  await git('checkout', '-q', 'main')
  await runLoop(lab, 'steward')
  expect(JSON.stringify((await lab.cli(['--format', 'json', 'read', 'health'])).json)).not.toContain('main-checkout:')
})
