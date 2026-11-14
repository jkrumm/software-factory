import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { tick } from '../flow.ts'
import { factory } from '../harness.ts'
import type { LeadsWorld } from '../leads/support.ts'
import {
  commit,
  gitIn,
  projectMake,
  scriptReview,
  ship,
  show,
  startQualityWorld,
  stateOf,
  until,
  workingIssue,
} from './support.ts'

// A lead starts through the leads' own tick (a worktree, a terminal) before each Issue ships: more than bun's 5 s default.
setDefaultTimeout(120_000)

const LONG = 60_000

/** One world for a describe: the leads' scenario world, the quality settings, and the describe's own watch window. */
function lab(windowMs: number, options: Parameters<typeof startQualityWorld>[1] = {}) {
  const it = { lw: undefined as unknown as LeadsWorld }
  beforeAll(async () => {
    it.lw = await startQualityWorld(
      { FACTORY_WATCH_WINDOW_MS: String(windowMs) },
      { project: projectMake(Math.floor(windowMs / 1000)), ...options },
    )
  })
  afterAll(async () => {
    await it.lw.stop()
  })
  return it
}

describe('ship: the gate', () => {
  const it = lab(60_000)

  test('a ship names its merged commits: they are evidence, with the review when agw has one', async () => {
    await scriptReview(it.lw.world, 'covered')
    const id = await workingIssue(it.lw, 'evidence')
    const sha = await commit(it.lw, 'src/a.ts', 'export const a = 1\n', 'feat: a')

    const shipped = await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })
    expect(shipped.code).toBe(0)
    expect(shipped.json).toMatchObject({ result: 'applied', issue: { id, state: 'watching' } })
    const [commits, review] = shipped.json.evidence
    expect(commits).toMatchObject({
      kind: 'commits',
      commits: [sha],
      landedAt: await gitIn(it.lw, 'rev-parse', 'origin/master'),
      deploys: true,
      paths: ['src/a.ts'],
    })
    expect(review).toMatchObject({ kind: 'review', status: 'covered', tier: 'standard', reason: null })
    expect(await stateOf(it.lw.world, id)).toBe('watching')

    // The outbox opens the watch on the next tick.
    await until('the watch to open', async () => (await show(it.lw.world, it.lw.server, id)).watches.length > 0)
    const view = await show(it.lw.world, it.lw.server, id)
    expect(view.ships).toMatchObject([{ result: 'accepted', commits: [sha], detail: null }])
    expect(view.watches).toMatchObject([{ watch: 1, answer: null, windowMs: 60_000, checks: [] }])
  })

  test('a ship states its acceptance lines: recorded as given, a malformed line is refused, none is an empty record', async () => {
    await scriptReview(it.lw.world, 'covered')
    const id = await workingIssue(it.lw, 'acceptance')
    const sha = await commit(it.lw, 'src/acc.ts', 'export const acc = 1\n', 'feat: acc')

    const malformed = await ship(it.lw.world, it.lw.server, id, {
      call: 'ship-1',
      commits: [sha],
      acceptance: ['done'],
    })
    expect(malformed.code).not.toBe(0)
    expect((await show(it.lw.world, it.lw.server, id)).ships).toEqual([])

    const stated = await ship(it.lw.world, it.lw.server, id, {
      call: 'ship-2',
      commits: [sha],
      acceptance: ['met: it shows', 'Not met: later'],
    })
    expect(stated.code).toBe(0)
    expect(stated.json.evidence[2]).toEqual({
      kind: 'acceptance',
      statements: [
        { status: 'met', text: 'it shows' },
        { status: 'not_met', text: 'later' },
      ],
    })
  })

  test('the same ship again is a replay: nothing is asked of git or agw, nothing doubles', async () => {
    await scriptReview(it.lw.world, 'covered')
    const id = await workingIssue(it.lw, 'replay')
    const sha = await commit(it.lw, 'src/b.ts', 'export const b = 1\n', 'feat: b')
    await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })
    const agwCalls = async () => (await it.lw.world.calls()).filter((call) => call.tool === 'agw').length
    const asked = await agwCalls()

    const again = await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })
    expect(again.code).toBe(0)
    expect(again.json.result).toBe('replayed')
    expect(again.json.evidence.map((e) => e.kind)).toEqual(['commits', 'review', 'acceptance'])
    expect(await agwCalls()).toBe(asked)
    expect((await show(it.lw.world, it.lw.server, id)).ships).toHaveLength(1)
  })

  test('a ship without merged commits is refused, naming the error; the call id is not spent', async () => {
    await scriptReview(it.lw.world, 'covered')
    const id = await workingIssue(it.lw, 'refused')

    const none = await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [] })
    expect(none.code).toBe(5)
    expect(none.refusal).toContain('ship refused: ship names no merged commit')

    await Bun.write(`${it.lw.repo}/local.ts`, 'l\n')
    await gitIn(it.lw, 'add', '-A')
    await gitIn(it.lw, 'commit', '-q', '-m', 'feat: local only')
    const local = await gitIn(it.lw, 'rev-parse', 'HEAD')
    const unmerged = await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [local] })
    expect(unmerged.code).toBe(5)
    expect(unmerged.refusal).toContain('is not on origin/master: merge it first')

    const unknown = await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: ['deadbeef'] })
    expect(unknown.code).toBe(5)
    expect(unknown.refusal).toContain('is not in')
    expect(await stateOf(it.lw.world, id)).toBe('working')

    await gitIn(it.lw, 'push', '-q', 'origin', 'master')
    const merged = await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [local] })
    expect(merged.code).toBe(0)
    expect(merged.json.result).toBe('applied')
    const view = await show(it.lw.world, it.lw.server, id)
    expect(view.ships.map((s) => s.result)).toEqual(['refused', 'refused', 'refused', 'accepted'])
    expect(view.ships[0]?.detail).toBe('ship refused: ship names no merged commit')
  })

  test('the lead’s cut is the attempt’s: a commit from before the lead started proves nothing', async () => {
    await scriptReview(it.lw.world, 'covered')
    const old = await commit(it.lw, 'src/old.ts', 'export const old = 1\n', 'feat: old')
    const id = await workingIssue(it.lw, 'older')
    const refused = await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [old] })
    expect(refused.code).toBe(5)
    expect(refused.refusal).toContain('is older than this attempt')
    expect(await stateOf(it.lw.world, id)).toBe('working')
  })

  test('a ship is accepted without a review, and the absence is recorded with its reason (NL23)', async () => {
    await scriptReview(it.lw.world, null)
    const id = await workingIssue(it.lw, 'unreviewed')
    const sha = await commit(it.lw, 'src/c.ts', 'export const c = 1\n', 'feat: c')

    const shipped = await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })
    expect(shipped.code).toBe(0)
    expect(shipped.json.issue.state).toBe('watching')
    expect(shipped.json.evidence[1]).toMatchObject({
      kind: 'review',
      status: 'unknown',
      tier: null,
      reason: expect.stringContaining('review could not be read'),
    })
    expect((await show(it.lw.world, it.lw.server, id)).ships[0]?.evidence[1]).toMatchObject({ status: 'unknown' })
  })

  test('a review that does not cover the range is recorded as such and still ships', async () => {
    await scriptReview(it.lw.world, 'uncovered')
    const id = await workingIssue(it.lw, 'uncovered')
    const sha = await commit(it.lw, 'src/d.ts', 'export const d = 1\n', 'feat: d')
    const shipped = await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })
    expect(shipped.code).toBe(0)
    expect(shipped.json.evidence[1]).toMatchObject({ status: 'uncovered', uncovered: [{ required: 'standard' }] })
  })

  test('a ship asks agw for the review reads only', async () => {
    const asked = (await it.lw.world.calls()).filter((call) => call.tool === 'agw')
    expect(new Set(asked.map((call) => `${call.args[0]} ${call.args[1]}`))).toEqual(
      new Set(['review route', 'review covered']),
    )
  })
})

// Its own world: the Errand's screen is an agw call, which the gate's "review reads only" test counts.
describe('ship: after an Errand', () => {
  const it = lab(60_000)

  test('a ship the machine refused while an Errand was open is decided again under the same call id once the Errand is done (#1166)', async () => {
    await scriptReview(it.lw.world, 'covered')
    const id = await workingIssue(it.lw, 'errand then ship')
    const sha = await commit(it.lw, 'src/e.ts', 'export const e = 1\n', 'feat: e')
    const env = { FACTORY_URL: it.lw.server.url }

    const raised = await factory(
      it.lw.world,
      [
        'errand',
        'raise',
        id,
        '--attempt',
        '1',
        '--summary',
        'plug it in',
        '--detail',
        'the cable',
        '--tried',
        'a command',
        '--format',
        'json',
      ],
      env,
    )
    expect(raised.code).toBe(0)
    const errand = String((JSON.parse(raised.out) as { errand: { id: string } }).errand.id)

    const waiting = await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })
    expect(waiting.code).toBe(5)
    expect(waiting.refusal).toContain('it waits for an Errand')

    const done = await factory(it.lw.world, ['errand', 'done', errand, '--note', 'done', '--format', 'json'], env)
    expect(done.code).toBe(0)

    const shipped = await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })
    expect(shipped.code).toBe(0)
    expect(shipped.json.result).toBe('applied')
    expect(await stateOf(it.lw.world, id)).toBe('watching')

    // the call that was accepted is still one: the same call again replays it
    const again = await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })
    expect(again.json.result).toBe('replayed')
  })
})

describe('the watch', () => {
  const it = lab(3_000)

  test(
    'the window comes first, then verify; green closes the Issue done',
    async () => {
      await scriptReview(it.lw.world, 'covered')
      const id = await workingIssue(it.lw, 'green')
      const sha = await commit(it.lw, 'src/a.ts', 'export const a = 1\n', 'feat: a')
      const shipped = await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })
      expect(shipped.code).toBe(0)

      await Bun.sleep(1_000)
      expect(await stateOf(it.lw.world, id)).toBe('watching')
      expect((await show(it.lw.world, it.lw.server, id)).watches[0]).toMatchObject({ answer: null, checks: [] })

      expect(await until('the Issue to close', async () => (await stateOf(it.lw.world, id)) === 'closed:done')).toBe(
        true,
      )
      const watch = (await show(it.lw.world, it.lw.server, id)).watches[0]
      expect(watch).toMatchObject({ watch: 1, answer: 'passed', windowMs: 3_000 })
      expect(watch?.checks).toHaveLength(1)
      expect(watch?.checks[0]).toMatchObject({
        outcome: 'green',
        checks: [
          { name: 'deployed version', ok: true },
          { name: 'make verify', ok: true },
        ],
      })
      const evidence = (await show(it.lw.world, it.lw.server, id)).ships[0]?.evidence ?? []
      expect(evidence.map((e) => e.kind)).toEqual(['commits', 'review', 'acceptance'])
    },
    LONG,
  )

  test(
    'a change docs only is not held to the deployed version',
    async () => {
      await scriptReview(it.lw.world, 'none')
      const id = await workingIssue(it.lw, 'docs')
      const sha = await commit(it.lw, 'docs/notes.md', '# notes\n', 'docs: notes')
      const shipped = await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })
      expect(shipped.json.evidence[0]).toMatchObject({ deploys: false })
      expect(shipped.json.evidence[1]).toMatchObject({ status: 'not_required' })
      await until('the Issue to close', async () => (await stateOf(it.lw.world, id)) === 'closed:done')
      expect((await show(it.lw.world, it.lw.server, id)).watches[0]?.checks[0]?.checks.map((c) => c.name)).toEqual([
        'make verify',
      ])
    },
    LONG,
  )
})

describe('regression', () => {
  const it = lab(200)

  // Before the stall test: after it the repo's last verify run is red, and the same red is no longer the next Issue's.
  test(
    'a red that clears on a retry never reaches the lead',
    async () => {
      await scriptReview(it.lw.world, 'covered')
      const id = await workingIssue(it.lw, 'flaky')
      await Bun.write(`${it.lw.repo}/red`, '')
      const sha = await commit(it.lw, 'src/flaky.ts', 'export const flaky = 1\n', 'feat: flaky')
      await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })

      await until(
        'the first red check',
        async () => (await show(it.lw.world, it.lw.server, id)).watches[0]?.checks.length,
      )
      await Bun.$`rm ${it.lw.repo}/red`
      await until('the Issue to close', async () => (await stateOf(it.lw.world, id)) === 'closed:done')
      const watch = (await show(it.lw.world, it.lw.server, id)).watches[0]
      expect(watch?.answer).toBe('passed')
      expect(watch?.checks.map((c) => c.outcome)[0]).toBe('red')
      expect(watch?.checks.at(-1)?.outcome).toBe('green')
    },
    LONG,
  )

  test(
    'a red verify is retried, then goes back to the lead; twice back, the third is a stall',
    async () => {
      await scriptReview(it.lw.world, 'covered')
      const id = await workingIssue(it.lw, 'regress')
      await Bun.write(`${it.lw.repo}/red`, '')
      const sha = await commit(it.lw, 'src/regress.ts', 'export const regress = 1\n', 'feat: regress')

      const states: string[] = []
      for (const round of [1, 2, 3]) {
        const shipped = await ship(it.lw.world, it.lw.server, id, { call: `ship-${round}`, commits: [sha] })
        expect(shipped.code).toBe(0)
        states.push(
          await until(`regression ${round}`, async () => {
            const now = await stateOf(it.lw.world, id)
            return now === 'watching' ? undefined : now
          }),
        )
      }
      expect(states).toEqual(['working', 'working', 'waiting:regressed'])

      const view = await show(it.lw.world, it.lw.server, id)
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
      const refused = await ship(it.lw.world, it.lw.server, id, { call: 'ship-4', commits: [sha] })
      expect(refused.code).toBe(5)
      expect(refused.refusal).toContain('regressed')
    },
    LONG,
  )
})

/** A Makefile like a CI-deployed repo's: `make verify`, a no-op `deploy`, and no `version`. */
const MAKEFILE_NO_VERSION = 'verify:\n\t@test ! -e red\ndeploy:\n\t@true\n'

describe('the watch reads the project file', () => {
  const auto = lab(60_000, {
    makefile: MAKEFILE_NO_VERSION,
    project: 'apiVersion: factory/v2\nname: example\nleads: 8\ndeploy:\n  mode: auto\n  hold: 2s\n',
  })

  test(
    'deploy mode auto: the file’s hold, make verify, and no make version although a deploy target exists',
    async () => {
      await scriptReview(auto.lw.world, 'covered')
      const id = await workingIssue(auto.lw, 'auto')
      const sha = await commit(auto.lw, 'src/a.ts', 'export const a = 1\n', 'feat: a')
      expect((await ship(auto.lw.world, auto.lw.server, id, { call: 'ship-1', commits: [sha] })).code).toBe(0)

      await until('the Issue to close', async () => (await stateOf(auto.lw.world, id)) === 'closed:done')
      const watch = (await show(auto.lw.world, auto.lw.server, id)).watches[0]
      expect(watch).toMatchObject({ answer: 'passed', windowMs: 2_000 })
      expect(watch?.checks[0]).toMatchObject({ outcome: 'green', checks: [{ name: 'make verify', ok: true }] })
    },
    LONG,
  )

  const missing = lab(200, {
    makefile: MAKEFILE_NO_VERSION,
    project: projectMake(),
  })

  test(
    'deploy mode make without a version target stays red, and the lead is told why',
    async () => {
      await scriptReview(missing.lw.world, 'covered')
      const id = await workingIssue(missing.lw, 'no version')
      const sha = await commit(missing.lw, 'src/a.ts', 'export const a = 1\n', 'feat: a')
      expect((await ship(missing.lw.world, missing.lw.server, id, { call: 'ship-1', commits: [sha] })).code).toBe(0)

      await until('the regression', async () => (await stateOf(missing.lw.world, id)) === 'working')
      const watch = (await show(missing.lw.world, missing.lw.server, id)).watches[0]
      expect(watch?.answer).toBe('regressed')
      expect(watch?.checks[0]?.checks).toMatchObject([
        { name: 'deployed version', ok: false, detail: expect.stringContaining('no `make version` target') },
        { name: 'make verify', ok: true },
      ])
    },
    LONG,
  )

  const bare = lab(1_500, { project: null })

  test(
    'a repo without a project.yaml is read from its Makefile, as before',
    async () => {
      await scriptReview(bare.lw.world, 'covered')
      const id = await workingIssue(bare.lw, 'bare')
      const sha = await commit(bare.lw, 'src/a.ts', 'export const a = 1\n', 'feat: a')
      expect((await ship(bare.lw.world, bare.lw.server, id, { call: 'ship-1', commits: [sha] })).code).toBe(0)

      await until('the Issue to close', async () => (await stateOf(bare.lw.world, id)) === 'closed:done')
      const watch = (await show(bare.lw.world, bare.lw.server, id)).watches[0]
      expect(watch).toMatchObject({ answer: 'passed', windowMs: 1_500 })
      expect(watch?.checks[0]?.checks.map((c) => c.name)).toEqual(['deployed version', 'make verify'])
    },
    LONG,
  )
})

/** What a watchdog prints: many passing checks, the first one long, and one red among them. */
const WATCHDOG = JSON.stringify(
  [
    { name: 'otel_export_down:worker-ingest', ok: true, detail: `fingerprint ${'ab12'.repeat(120)}` },
    ...Array.from({ length: 12 }, (_, n) => ({
      name: `probe_${n}`,
      ok: true,
      detail: `p50 ${n} ms, nothing to report`,
    })),
    { name: 'round_integrity:blend', ok: false, detail: 'round 41 has no blend row' },
  ],
  null,
  2,
)

describe('a regression names the failing check', () => {
  const it = lab(200, { makefile: 'verify:\n\t@cat checks.json; exit 1\nversion:\n\t@git rev-parse HEAD\n' })

  test(
    'a watchdog’s JSON list reaches the lead as the failing check’s name and detail, not as a cut tail',
    async () => {
      await scriptReview(it.lw.world, 'covered')
      const id = await workingIssue(it.lw, 'watchdog')
      await commit(it.lw, 'checks.json', `${WATCHDOG}\n`, 'chore: watchdog output')
      const sha = await commit(it.lw, 'src/w.ts', 'export const w = 1\n', 'feat: w')
      const lead = () =>
        it.lw.terminals().find((t) => t.labels['factory.key'] === `lead-${id.slice('issue_'.length)}-1`)
      const before = lead()?.sent.length ?? 0
      expect((await ship(it.lw.world, it.lw.server, id, { call: 'ship-1', commits: [sha] })).code).toBe(0)

      await until('the regression', async () => (await stateOf(it.lw.world, id)) === 'working')
      await tick(it.lw)
      const heard = await until('the note', async () => {
        const text = (lead()?.sent ?? []).slice(before).join('\n')
        return text.includes('regressed') ? text : undefined
      })
      expect(heard).toContain('round_integrity:blend: round 41 has no blend row')
      expect(heard).not.toContain('otel_export_down')
    },
    LONG,
  )
})
