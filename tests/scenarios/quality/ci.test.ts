import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { LeadsWorld } from '../leads/support.ts'
import {
  commit,
  gitIn,
  type FakeCi,
  fakeCi,
  projectMake,
  projectPr,
  scriptReview,
  ship,
  show,
  startQualityWorld,
  stateOf,
  until,
  workingIssue,
} from './support.ts'

setDefaultTimeout(120_000)

const LONG = 60_000
const GREEN = [{ name: 'build', status: 'completed' as const, conclusion: 'success' as const }]
const RED = [{ name: 'build', status: 'completed' as const, conclusion: 'failure' as const }]
const RUNNING = [{ name: 'build', status: 'in_progress' as const, conclusion: null }]

/** A quality world whose origin is a github.com address served by a fake GitHub. */
function lab(project: string, windowMs: number) {
  const it = { lw: undefined as unknown as LeadsWorld, github: undefined as unknown as FakeCi }
  beforeAll(async () => {
    it.github = fakeCi()
    it.lw = await startQualityWorld(
      { FACTORY_WATCH_WINDOW_MS: String(windowMs), FACTORY_VERIFY_RECHECK_MS: '300' },
      { project, github: it.github },
    )
  })
  afterAll(async () => {
    await it.lw.stop()
    it.github.stop()
  })
  return it
}

/** A lead's commit on master, and the sha of the head of the pull request it landed through, if there is one. */
async function landed(it: { lw: LeadsWorld; github: FakeCi }, name: string, pull: number | null) {
  await scriptReview(it.lw.world, 'covered')
  const id = await workingIssue(it.lw, name)
  const sha = await commit(it.lw, `src/${name}.ts`, `export const ${name} = 1\n`, `feat: ${name}`)
  if (pull !== null) it.github.pull(sha, pull, `head-${name}`)
  return { id, sha, head: `head-${name}`, landedAt: await gitIn(it.lw, 'rev-parse', 'origin/master') }
}

describe('ship evidence: a project that ships by push', () => {
  const it = lab(projectMake(60), 60_000)

  test('records no CI at all and never asks GitHub', async () => {
    const { id, sha } = await landed(it, 'pushed', null)
    const shipped = await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })
    expect(shipped.json.result).toBe('applied')
    expect(shipped.json.evidence.map((e) => e.kind)).toEqual(['commits', 'review', 'acceptance'])
    expect(it.github.requests).toEqual([])
  })
})

describe('ship evidence: the CI of the pull request', () => {
  const it = lab(projectPr(60), 60_000)

  test('a green pull request is recorded with its number and head', async () => {
    const { id, sha, head } = await landed(it, 'green', 7)
    it.github.runs(head, GREEN)
    const shipped = await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })
    expect(shipped.code).toBe(0)
    expect(shipped.json.evidence[3]).toEqual({
      kind: 'ci',
      status: 'green',
      pr: 7,
      headSha: head,
      url: 'https://github.com/o/example/pull/7',
      reason: null,
    })
  })

  test('a red pull request is red, with the failing check; the ship is still accepted', async () => {
    const { id, sha, head } = await landed(it, 'red', 8)
    it.github.runs(head, RED)
    const shipped = await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })
    expect(shipped.json.result).toBe('applied')
    expect(shipped.json.evidence[3]).toMatchObject({
      kind: 'ci',
      status: 'red',
      pr: 8,
      reason: 'build failure',
      url: 'https://github.com/o/example/runs/build',
    })
  })

  test('a direct push has no pull request: missing', async () => {
    const { id, sha } = await landed(it, 'direct', null)
    const shipped = await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })
    expect(shipped.json.evidence[3]).toMatchObject({ kind: 'ci', status: 'missing', pr: null, headSha: null })
  })

  test('a GitHub that fails is unknown, with the reason, and never refuses the ship', async () => {
    const { id, sha } = await landed(it, 'down', 9)
    it.github.down(true)
    try {
      const shipped = await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })
      expect(shipped.code).toBe(0)
      expect(shipped.json.evidence[3]).toMatchObject({
        kind: 'ci',
        status: 'unknown',
        reason: 'CI could not be read: github 500',
      })
      expect(await stateOf(it.lw.world, id)).toBe('watching')
    } finally {
      it.github.down(false)
    }
    const view = await show(it.lw.world, it.lw.server, id)
    expect(view.ships[0]?.evidence[3]).toMatchObject({ kind: 'ci', status: 'unknown' })
  })
})

describe('the watch holds on the default branch CI', () => {
  const it = lab(projectPr(0), 200)

  test(
    'CI still running neither passes nor counts as red; green then passes',
    async () => {
      const { id, sha, landedAt } = await landed(it, 'running', 3)
      it.github.runs(`head-running`, GREEN)
      it.github.runs(landedAt, RUNNING)
      expect((await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })).code).toBe(0)

      await until('a check that waits for CI', async () => {
        const checks = (await show(it.lw.world, it.lw.server, id)).watches[0]?.checks ?? []
        return checks.length >= 2
      })
      const waiting = (await show(it.lw.world, it.lw.server, id)).watches[0]
      expect(await stateOf(it.lw.world, id)).toBe('watching')
      expect(waiting?.answer).toBeNull()
      expect(waiting?.checks.map((c) => c.outcome)).not.toContain('red')
      expect(waiting?.checks[0]?.outcome).toBe('blocked')
      expect(waiting?.checks[0]?.checks.find((c) => c.name === 'ci')).toMatchObject({
        ok: false,
        detail: expect.stringContaining('CI is still running'),
      })

      it.github.runs(landedAt, GREEN)
      await until('the Issue to close', async () => (await stateOf(it.lw.world, id)) === 'closed:done')
      const watch = (await show(it.lw.world, it.lw.server, id)).watches[0]
      expect(watch?.answer).toBe('passed')
      expect(watch?.checks.at(-1)).toMatchObject({
        outcome: 'green',
        checks: expect.arrayContaining([{ name: 'ci', ok: true, detail: expect.stringContaining('CI green') }]),
      })
    },
    LONG,
  )

  test(
    'red CI is retried, then regresses with the failing check in the detail',
    async () => {
      const { id, sha, landedAt } = await landed(it, 'broken', 4)
      it.github.runs(landedAt, RED)
      expect((await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })).code).toBe(0)

      await until('the regression', async () => (await stateOf(it.lw.world, id)) === 'working')
      const watch = (await show(it.lw.world, it.lw.server, id)).watches[0]
      expect(watch).toMatchObject({ answer: 'regressed' })
      expect(watch?.checks.map((c) => c.outcome)).toEqual(['red', 'red', 'red', 'red'])
      expect(watch?.checks[0]?.checks.find((c) => c.name === 'ci')).toMatchObject({
        ok: false,
        detail: expect.stringContaining('build failure'),
      })
    },
    LONG,
  )

  test(
    'no CI run yet for a commit that just merged is waited for, not passed',
    async () => {
      // A merge that just happened has had no time for CI to show: the check waits rather than passing.
      const { id, sha } = await landed(it, 'quiet', null)
      expect((await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })).code).toBe(0)
      await until('a check that waits for CI', async () => {
        const checks = (await show(it.lw.world, it.lw.server, id)).watches[0]?.checks ?? []
        return checks.length >= 1
      })
      const watch = (await show(it.lw.world, it.lw.server, id)).watches[0]
      expect(watch?.checks[0]?.outcome).toBe('blocked')
      expect(watch?.answer).toBeNull()
    },
    LONG,
  )
})

describe('a project without CI is unchanged', () => {
  const it = lab(projectMake(0), 200)

  test(
    'the Watch asks GitHub for nothing and passes on make verify alone',
    async () => {
      const { id, sha } = await landed(it, 'plain', 5)
      it.github.runs('head-plain', GREEN)
      expect((await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })).code).toBe(0)
      const asked = it.github.requests.length
      await until('the Issue to close', async () => (await stateOf(it.lw.world, id)) === 'closed:done')
      const watch = (await show(it.lw.world, it.lw.server, id)).watches[0]
      expect(watch?.checks[0]?.checks.map((c) => c.name)).toEqual(['deployed version', 'make verify'])
      expect(it.github.requests.length).toBe(asked)
    },
    LONG,
  )
})
