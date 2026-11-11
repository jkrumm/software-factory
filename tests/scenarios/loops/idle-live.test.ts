import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { bearer } from '../harness.ts'
import { hook, sessionOf } from '../flow.ts'
import { type Lab, startLab } from '../planning/lab.ts'
import { runLoop, working } from './support.ts'

/**
 * A lead whose turn ended with nothing listed as background work, but whose work is in flight all the same: a test slot
 * its command holds or queues for (started in its worktree), or a CI run of its branch that is queued or in progress. The
 * steward does not nudge it on the short threshold (0 here; the background one is an hour, so a nudge could only come
 * from counting the wait as idle), and nudges it once that work ends.
 */
const REPO = 'app'

let lab: Lab
let github: FakeGithub

interface FakeGithub {
  url: string
  /** the runs the fake lists, each on a branch */
  runs: { branch: string; status: string }[]
  stop(): void
}

function fakeGithub(): FakeGithub {
  const state: FakeGithub = { url: '', runs: [], stop: () => undefined }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== `/repos/o/${REPO}/actions/runs`) return new Response('not found', { status: 404 })
      const branch = url.searchParams.get('branch')
      return Response.json({
        workflow_runs: state.runs
          .filter((run) => run.branch === branch)
          .map((run, i) => ({
            id: 1 + i,
            name: 'CI',
            head_sha: 'a'.repeat(40),
            status: run.status,
            conclusion: run.status === 'completed' ? 'success' : null,
            html_url: 'https://example.com/run',
            created_at: new Date().toISOString(),
          })),
      })
    },
  })
  state.url = `http://127.0.0.1:${server.port}`
  state.stop = () => void server.stop(true)
  return state
}

const git = async (...args: string[]): Promise<string> => {
  const proc = Bun.spawn(['git', '-C', join(lab.root, REPO), ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(' ')}: ${err}`)
  return out.trim()
}

beforeAll(async () => {
  github = fakeGithub()
  lab = await startLab({
    leads: true,
    repos: { [REPO]: { project: `apiVersion: factory/v2\nname: ${REPO}\nleads: 8\n` } },
    env: {
      FACTORY_LEADS_PER_ACCOUNT: '16',
      FACTORY_GITHUB_TOKEN: 'ghp_fake_0123456789',
      FACTORY_GITHUB_API_URL: github.url,
      FACTORY_STEWARD_MIN_STALL_MS: '0',
      FACTORY_STEWARD_IDLE_MS: '0',
      FACTORY_STEWARD_IDLE_BACKGROUND_MS: '3600000',
    },
  })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
  github.stop()
})

/**
 * The lead's last turn ends with nothing listed as background work and nothing reported. The Stop hook lets that through
 * for a turn the owner typed (the factory's brief and notes are sent back), so the quiet turn is one.
 */
async function goQuiet(issue: string): Promise<void> {
  const session = sessionOf(issue)
  await hook(lab.world, 'user-prompt-submit', session, { session_id: `c-${issue}` })
  await hook(lab.world, 'stop', session, { stop_hook_active: false, background_tasks: [] })
}

/** A working Issue whose lead has gone quiet after the brief's turn, which ended with a task running. */
async function quiet(title: string): Promise<{ issue: string; worktree: string; branch: string }> {
  const issue = await working(lab, REPO, title)
  const session = sessionOf(issue)
  await hook(lab.world, 'session-start', session, { source: 'startup', session_id: `c-${issue}` })
  await hook(lab.world, 'user-prompt-submit', session, { session_id: `c-${issue}` })
  await hook(lab.world, 'stop', session, { stop_hook_active: false, background_tasks: [{ status: 'running' }] })
  await goQuiet(issue)
  const [row] = await lab.world.db
    .sql`SELECT worktree_path, branch FROM factory.lead_attempts WHERE issue_id = ${issue} AND attempt = 1`
  return { issue, worktree: row.worktree_path as string, branch: row.branch as string }
}

/** The lead takes a new turn, so the session reads working and no later pass looks at it. */
const resume = (issue: string) =>
  hook(lab.world, 'user-prompt-submit', sessionOf(issue), { session_id: `again-${issue}` })

const idleNotes = async (issue: string): Promise<number> =>
  (
    await lab.world.db
      .sql`SELECT 1 FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'noted' AND actor = 'steward' AND result = 'applied'`
  ).length

/** The repo's origin is a github.com address while `fn` runs (the CI reader names the repository by it), the bare repo after. */
async function onGithub<T>(fn: () => Promise<T>): Promise<T> {
  const bare = await git('remote', 'get-url', 'origin')
  await git('remote', 'set-url', 'origin', `https://github.com/o/${REPO}.git`)
  try {
    return await fn()
  } finally {
    await git('remote', 'set-url', 'origin', bare)
  }
}

const woken = async (): Promise<string> => {
  const ran = await runLoop(lab, 'steward')
  expect(ran.error).toBeNull()
  return ran.summary ?? ''
}

const slotCall = (id: string, method: 'PUT' | 'DELETE', cwd?: string) =>
  fetch(`${lab.server.url}/slots/${id}`, {
    method,
    headers: { 'content-type': 'application/json', ...bearer() },
    ...(method === 'PUT' ? { body: JSON.stringify({ name: 'make', ...(cwd ? { cwd } : {}) }) } : {}),
  })

test('a lead whose command holds a test slot from its worktree is not nudged; it is once the slot is given back', async () => {
  const lead = await quiet('the lead waits on its slot run')
  // another lead's slot, and a slot with no directory, are not this lead's
  expect((await slotCall('other', 'PUT', join(lab.root, 'elsewhere'))).status).toBe(200)
  expect((await slotCall('nowhere', 'PUT')).status).toBe(200)

  expect((await slotCall('mine', 'PUT', join(lead.worktree, 'apps', 'server'))).status).toBe(200)
  for (let pass = 0; pass < 2; pass++) expect(await woken()).toContain('woken 0')
  expect(await idleNotes(lead.issue)).toBe(0)

  await slotCall('mine', 'DELETE')
  expect(await woken()).toContain('woken 1')
  expect(await idleNotes(lead.issue)).toBe(1)
  await resume(lead.issue)
  await slotCall('other', 'DELETE')
  await slotCall('nowhere', 'DELETE')
})

test('a lead whose branch has a CI run queued or in progress is not nudged; it is once the run is completed', async () => {
  const first = await quiet('the lead waits on a finished CI run')
  const second = await quiet('the lead waits on its branch CI')
  await resume(second.issue)

  // a run of another branch, and a finished run of this one, are not live
  await onGithub(async () => {
    github.runs = [
      { branch: 'factory/other-1', status: 'in_progress' },
      { branch: first.branch, status: 'completed' },
    ]
    expect(await woken()).toContain('woken 1')
    expect(await idleNotes(first.issue)).toBe(1)
    await resume(first.issue)
    await goQuiet(second.issue)

    for (const status of ['in_progress', 'queued']) {
      github.runs = [{ branch: second.branch, status }]
      for (let pass = 0; pass < 2; pass++) expect(await woken()).toContain('woken 0')
      expect(await idleNotes(second.issue)).toBe(0)
    }

    github.runs = [{ branch: second.branch, status: 'completed' }]
    expect(await woken()).toContain('woken 1')
    expect(await idleNotes(second.issue)).toBe(1)
  })
})
