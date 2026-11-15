import { afterEach, beforeEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { statePathOf, withState } from '../fakes/hc-state.ts'
import { type LeadsWorld, startLeadsWorld } from './support.ts'

/**
 * A host restart brings every kept terminal back as a login shell: live, no status, no agent. The lead of a working Issue
 * whose terminal is that is lost, yet revivable: its session starts again, a note is never typed into the shell, the health
 * lines name the Issue while it has no agent, and the friction read counts the lost lead.
 */
let w: LeadsWorld
let issue = ''
const SESSION = 'lead-1-1'

/** What the core does with a kept terminal after a restart. */
const fallBackToShell = () =>
  withState(statePathOf(join(w.world.bin, 'calls.jsonl')), (state) => {
    for (const terminal of Object.values(state.terminals)) {
      if (terminal.labels['factory.key'] !== SESSION || terminal.state !== 'live') continue
      terminal.argv = ['/bin/zsh', '-l']
      terminal.status = null
      terminal.reported = false
    }
  })

const lead = () => w.terminals().filter((t) => t.labels['factory.key'] === SESSION)
const health = async () => {
  const run = await w.cli(['--format', 'json', 'read', 'health'])
  return run.out
}
const lostLeads = async () => {
  const friction = JSON.parse((await w.cli(['--format', 'json', 'read', 'friction', '--days', '1'])).out) as {
    counts: { key: string; count: number }[]
  }
  return friction.counts.find((count) => count.key === 'lead_gone')?.count
}

const start = async (env: Record<string, string> = {}) => {
  w = await startLeadsWorld(env)
  issue = await w.admitted()
  await w.tick()
  // The lead's session ran: its id is on file, which is what the start again resumes.
  await w.hook('session-start', SESSION, { source: 'startup', session_id: 's-1', transcript_path: '/x/s-1.jsonl' })
  await w.hook('user-prompt-submit', SESSION, { session_id: 's-1' })
}

beforeEach(async () => {
  w = undefined as unknown as LeadsWorld
})

afterEach(async () => {
  await w.stop()
})

test('a terminal that fell back to a shell: the session starts again over it, once, and the loss is counted', async () => {
  await start()
  await fallBackToShell()
  // The hooks still say what they said before the restart: the lead looks fine to them.
  expect(await lostLeads()).toBe(0)

  const tick = await w.tick()
  expect(tick.lost).toBe(0)
  const [running, ...rest] = lead()
  expect(rest).toHaveLength(0)
  expect(running).toMatchObject({ state: 'live' })
  const resume = running?.argv.indexOf('--resume') ?? -1
  expect(running?.argv[resume + 1]).toBe('s-1')
  expect(running?.argv.at(-1)).toContain('The host restarted')
  expect(running?.sent).toHaveLength(0)

  const [state] = await w.world.db.sql`SELECT state FROM factory.issues WHERE id = ${issue}`
  expect(state?.state).toBe('working')
  // Revived: nothing is named any more, and the lost lead is on the books once however often the pass runs.
  expect(await health()).not.toContain('lead-no-agent')
  await w.tick()
  expect(lead()).toHaveLength(1)
  expect(await lostLeads()).toBe(1)
})

test('a note meanwhile is not typed into the shell: the session starts again with it', async () => {
  // A grace the pass does not reach: the note meets the shell first.
  await start({ FACTORY_GRACE_MS: '3600000' })
  await fallBackToShell()
  await w.tick()
  expect(lead().flatMap((t) => t.sent)).toEqual([])

  await w.note(issue, 'use the staging database')
  await w.tick()
  const [running, ...rest] = lead()
  expect(rest).toHaveLength(0)
  expect(running?.argv).toContain('--resume')
  expect(running?.argv.at(-1)).toContain('The host restarted')
  expect(running?.argv.at(-1)).toContain('use the staging database')
  expect(running?.sent).toHaveLength(0)
  expect(await lostLeads()).toBe(1)
})

test('a start that dies: the health lines name the Issue until the lost path, and it is counted once', async () => {
  await start()
  await fallBackToShell()
  await withState(statePathOf(join(w.world.bin, 'calls.jsonl')), (state) => {
    state.runEnds = true
  })
  await w.tick()
  // The session did not come back: the Issue is named while it works with no agent.
  expect(await health()).toContain(`lead-no-agent:${issue}`)
  expect(await lostLeads()).toBe(1)

  await w.tick()
  const [gone] = await w.world.db
    .sql`SELECT count(*)::int AS n FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'lead_gone'`
  expect(gone?.n).toBe(1)
  expect(await health()).not.toContain('lead-no-agent')
  expect(await lostLeads()).toBe(1)
})
