import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type GitRepo, startGitRepo } from '@software-factory/tests/git-repo'
import { type ServerProcess, startServer, startWorld, type World } from '../harness.ts'
import { MAKEFILE, QUALITY_ENV, scriptReview, ship, show, stateOf, until, workingIssue } from './support.ts'

const LONG = 60_000

/** One world and one server for a describe; the watch window is the describe's own. */
function lab(windowMs: number) {
  const it = {
    world: undefined as unknown as World,
    server: undefined as unknown as ServerProcess,
    repo: undefined as unknown as GitRepo,
    repos: [] as GitRepo[],
  }
  beforeAll(async () => {
    it.world = await startWorld()
    it.server = await startServer(it.world, { env: { ...QUALITY_ENV, FACTORY_WATCH_WINDOW_MS: String(windowMs) } })
  })
  afterAll(async () => {
    await it.server.stop()
    for (const repo of it.repos) await repo.stop()
    await it.world.stop()
  })
  /** A repo of its own per scenario: `red` in one clone must not turn another Issue's verify red. */
  const repo = async () => {
    const created = await startGitRepo(MAKEFILE)
    it.repos.push(created)
    return created
  }
  return { it, repo }
}

describe('ship: the gate', () => {
  const { it, repo } = lab(60_000)

  test('a ship names its merged commits: they are evidence, with the review when agw has one', async () => {
    await scriptReview(it.world, 'covered')
    const clone = await repo()
    const sha = await clone.commit('src/a.ts', 'export const a = 1\n', 'feat: a')
    const id = await workingIssue(it.server, clone.path, 'evidence')

    const shipped = await ship(it.world, it.server, id, { call: 'ship-1', commits: [sha] })
    expect(shipped.code).toBe(0)
    expect(shipped.json).toMatchObject({ result: 'applied', issue: { id, state: 'watching' } })
    const [commits, review] = shipped.json.evidence
    expect(commits).toMatchObject({
      kind: 'commits',
      commits: [sha],
      landedAt: await clone.git('rev-parse', 'origin/master'),
      deploys: true,
      paths: ['src/a.ts'],
    })
    expect(review).toMatchObject({ kind: 'review', status: 'covered', tier: 'standard', reason: null })
    expect(await stateOf(it.server, id)).toBe('watching')

    // The outbox opens the watch on the next tick.
    await until('the watch to open', async () => (await show(it.world, it.server, id)).watches.length > 0)
    const view = await show(it.world, it.server, id)
    expect(view.ships).toMatchObject([{ result: 'accepted', commits: [sha], detail: null }])
    expect(view.watches).toMatchObject([{ watch: 1, answer: null, windowMs: 60_000, checks: [] }])
  })

  test('the same ship again is a replay: nothing is asked of git or agw, nothing doubles', async () => {
    await scriptReview(it.world, 'covered')
    const clone = await repo()
    const sha = await clone.commit('src/b.ts', 'export const b = 1\n', 'feat: b')
    const id = await workingIssue(it.server, clone.path, 'replay')
    await ship(it.world, it.server, id, { call: 'ship-1', commits: [sha] })
    const asked = (await it.world.calls()).length

    const again = await ship(it.world, it.server, id, { call: 'ship-1', commits: [sha] })
    expect(again.code).toBe(0)
    expect(again.json.result).toBe('replayed')
    expect(again.json.evidence.map((e) => e.kind)).toEqual(['commits', 'review'])
    expect((await it.world.calls()).length).toBe(asked)
    expect((await show(it.world, it.server, id)).ships).toHaveLength(1)
  })

  test('a ship without merged commits is refused, naming the error; the call id is not spent', async () => {
    await scriptReview(it.world, 'covered')
    const clone = await repo()
    const id = await workingIssue(it.server, clone.path, 'refused')

    const none = await ship(it.world, it.server, id, { call: 'ship-1', commits: [] })
    expect(none.code).toBe(5)
    expect(none.refusal).toContain('ship refused: ship names no merged commit')

    await Bun.write(`${clone.path}/local.ts`, 'l\n')
    await clone.git('add', '-A')
    await clone.git('commit', '-q', '-m', 'feat: local only')
    const local = await clone.git('rev-parse', 'HEAD')
    const unmerged = await ship(it.world, it.server, id, { call: 'ship-1', commits: [local] })
    expect(unmerged.code).toBe(5)
    expect(unmerged.refusal).toContain('is not on origin/master: merge it first')

    const unknown = await ship(it.world, it.server, id, { call: 'ship-1', commits: ['deadbeef'] })
    expect(unknown.code).toBe(5)
    expect(unknown.refusal).toContain('is not in')
    expect(await stateOf(it.server, id)).toBe('working')

    await clone.git('push', '-q', 'origin', 'master')
    const merged = await ship(it.world, it.server, id, { call: 'ship-1', commits: [local] })
    expect(merged.code).toBe(0)
    expect(merged.json.result).toBe('applied')
    const view = await show(it.world, it.server, id)
    expect(view.ships.map((s) => s.result)).toEqual(['refused', 'refused', 'refused', 'accepted'])
    expect(view.ships[0]?.detail).toBe('ship refused: ship names no merged commit')
  })

  test('a ship is accepted without a review, and the absence is recorded with its reason (NL23)', async () => {
    await scriptReview(it.world, null)
    const clone = await repo()
    const sha = await clone.commit('src/c.ts', 'export const c = 1\n', 'feat: c')
    const id = await workingIssue(it.server, clone.path, 'unreviewed')

    const shipped = await ship(it.world, it.server, id, { call: 'ship-1', commits: [sha] })
    expect(shipped.code).toBe(0)
    expect(shipped.json.issue.state).toBe('watching')
    expect(shipped.json.evidence[1]).toMatchObject({
      kind: 'review',
      status: 'unknown',
      tier: null,
      reason: expect.stringContaining('review could not be read'),
    })
    expect((await show(it.world, it.server, id)).ships[0]?.evidence[1]).toMatchObject({ status: 'unknown' })
  })

  test('a review that does not cover the range is recorded as such and still ships', async () => {
    await scriptReview(it.world, 'uncovered')
    const clone = await repo()
    const sha = await clone.commit('src/d.ts', 'export const d = 1\n', 'feat: d')
    const id = await workingIssue(it.server, clone.path, 'uncovered')
    const shipped = await ship(it.world, it.server, id, { call: 'ship-1', commits: [sha] })
    expect(shipped.code).toBe(0)
    expect(shipped.json.evidence[1]).toMatchObject({ status: 'uncovered', uncovered: [{ required: 'standard' }] })
  })

  test('a ship asks agw and git only, and never starts a terminal', async () => {
    const tools = new Set((await it.world.calls()).map((call) => `${call.tool} ${call.args[0] ?? ''}`))
    expect([...tools].sort()).toEqual(['agw review'])
  })
})

describe('the watch', () => {
  const { it, repo } = lab(2_500)

  test(
    'the window comes first, then verify; green closes the Issue done',
    async () => {
      await scriptReview(it.world, 'covered')
      const clone = await repo()
      const sha = await clone.commit('src/a.ts', 'export const a = 1\n', 'feat: a')
      const id = await workingIssue(it.server, clone.path, 'green')
      const shipped = await ship(it.world, it.server, id, { call: 'ship-1', commits: [sha] })
      expect(shipped.code).toBe(0)

      await Bun.sleep(1_000)
      expect(await stateOf(it.server, id)).toBe('watching')
      expect((await show(it.world, it.server, id)).watches[0]).toMatchObject({ answer: null, checks: [] })

      expect(await until('the Issue to close', async () => (await stateOf(it.server, id)) === 'closed:done')).toBe(true)
      const watch = (await show(it.world, it.server, id)).watches[0]
      expect(watch).toMatchObject({ watch: 1, answer: 'passed', windowMs: 2_500 })
      expect(watch?.checks).toHaveLength(1)
      expect(watch?.checks[0]).toMatchObject({
        outcome: 'green',
        checks: [
          { name: 'deployed version', ok: true },
          { name: 'make verify', ok: true },
        ],
      })
      const evidence = (await show(it.world, it.server, id)).ships[0]?.evidence ?? []
      expect(evidence.map((e) => e.kind)).toEqual(['commits', 'review'])
    },
    LONG,
  )

  test(
    'a change docs only is not held to the deployed version',
    async () => {
      await scriptReview(it.world, 'none')
      const clone = await repo()
      const sha = await clone.commit('docs/notes.md', '# notes\n', 'docs: notes')
      const id = await workingIssue(it.server, clone.path, 'docs')
      const shipped = await ship(it.world, it.server, id, { call: 'ship-1', commits: [sha] })
      expect(shipped.json.evidence[0]).toMatchObject({ deploys: false })
      expect(shipped.json.evidence[1]).toMatchObject({ status: 'not_required' })
      await until('the Issue to close', async () => (await stateOf(it.server, id)) === 'closed:done')
      expect((await show(it.world, it.server, id)).watches[0]?.checks[0]?.checks.map((c) => c.name)).toEqual([
        'make verify',
      ])
    },
    LONG,
  )
})

describe('regression', () => {
  const { it, repo } = lab(200)

  test(
    'a red verify is retried, then goes back to the lead; twice back, the third is a stall',
    async () => {
      await scriptReview(it.world, 'covered')
      const clone = await repo()
      const sha = await clone.commit('src/a.ts', 'export const a = 1\n', 'feat: a')
      await Bun.write(`${clone.path}/red`, '')
      const id = await workingIssue(it.server, clone.path, 'regress')

      const states: string[] = []
      for (const round of [1, 2, 3]) {
        const shipped = await ship(it.world, it.server, id, { call: `ship-${round}`, commits: [sha] })
        expect(shipped.code).toBe(0)
        states.push(
          await until(`regression ${round}`, async () => {
            const now = await stateOf(it.server, id)
            return now === 'watching' ? undefined : now
          }),
        )
      }
      expect(states).toEqual(['working', 'working', 'waiting:regressed'])

      const view = await show(it.world, it.server, id)
      expect(view.watches.map((w) => [w.watch, w.answer, w.checks.map((c) => c.outcome)])).toEqual([
        [1, 'regressed', ['red', 'red', 'red', 'red']],
        [2, 'regressed', ['red', 'red', 'red', 'red']],
        [3, 'regressed', ['red', 'red', 'red', 'red']],
      ])
      expect(view.watches[0]?.checks[0]?.checks).toMatchObject([
        { name: 'deployed version', ok: true },
        { name: 'make verify', ok: false, detail: expect.stringContaining('exit 2') },
      ])

      // The stalled Issue takes no lead verb: the steward ends the wait, never the lead.
      const refused = await ship(it.world, it.server, id, { call: 'ship-4', commits: [sha] })
      expect(refused.code).toBe(5)
      expect(refused.refusal).toContain('regressed')
    },
    LONG,
  )

  test(
    'a red that clears on a retry never reaches the lead',
    async () => {
      await scriptReview(it.world, 'covered')
      const clone = await repo()
      const sha = await clone.commit('src/a.ts', 'export const a = 1\n', 'feat: a')
      await Bun.write(`${clone.path}/red`, '')
      const id = await workingIssue(it.server, clone.path, 'flaky')
      await ship(it.world, it.server, id, { call: 'ship-1', commits: [sha] })

      await until('the first red check', async () => (await show(it.world, it.server, id)).watches[0]?.checks.length)
      await Bun.$`rm ${clone.path}/red`
      await until('the Issue to close', async () => (await stateOf(it.server, id)) === 'closed:done')
      const watch = (await show(it.world, it.server, id)).watches[0]
      expect(watch?.answer).toBe('passed')
      expect(watch?.checks.map((c) => c.outcome)[0]).toBe('red')
      expect(watch?.checks.at(-1)?.outcome).toBe('green')
    },
    LONG,
  )
})
