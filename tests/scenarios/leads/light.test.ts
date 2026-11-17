import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readState, statePathOf } from '../fakes/hc-state.ts'
import { admitted, block, must, runLoop, stateOf, tick } from '../flow.ts'
import { type Lab, startLab } from '../planning/lab.ts'
import { script } from '../loops/support.ts'

/**
 * The light seat end to end, against the real server, Postgres, checker and git: a hygiene sweep files a broken-links
 * finding, its Issue's lead starts on the role table's `light` row, and a second block moves it up, so the next lead
 * starts on the `lead` row with the move in its brief.
 */
let lab: Lab
let dir: string

const DOC = ['See [the missing page](missing.md).', ...Array.from({ length: 16 }, (_, i) => `Line ${i}.`)].join('\n')

beforeAll(async () => {
  dir = await mkdtemp('/tmp/factory-light-scenario-')
  const hygieneScript = join(dir, 'hygiene.json')
  await script(hygieneScript, [])
  lab = await startLab({
    leads: true,
    repos: { l1: { project: 'apiVersion: factory/v2\nname: l1\nleads: 2\n' } },
    env: {
      FACTORY_DATA_DIR: join(dir, 'data'),
      FACTORY_FAKE_HYGIENE_SCRIPT: hygieneScript,
      FACTORY_HYGIENE_EVERY_MS: String(7 * 24 * 3_600_000),
    },
  })
  await lab.commit('l1', { Makefile: 'check:\n\t@true\n', 'docs/guide.md': DOC })
  expect((await lab.cli(['project', 'sync'])).code).toBe(0)
})

afterAll(async () => {
  await lab.stop()
  await rm(dir, { recursive: true, force: true })
})

const flow = () => ({ world: lab.world, server: lab.server })
const terminals = () => Object.values(readState(statePathOf(join(lab.world.bin, 'calls.jsonl'))).terminals)
const modelOf = (argv: readonly string[]) => [argv[argv.indexOf('--model') + 1], argv[argv.indexOf('--effort') + 1]]

test('a links finding starts a light lead; its second stall requeues it, and the next lead starts on the lead row', async () => {
  await runLoop(flow(), 'hygiene')
  const [finding] = await lab.world.db.sql`
    SELECT issue_id, key FROM factory.loop_findings WHERE loop = 'hygiene' AND repo = 'l1' AND class = 'links'`
  expect(finding?.key).toBe('links:docs/guide.md')
  const issue = String(finding?.issue_id)

  await admitted(flow(), issue)
  await tick(flow())
  const [light] = terminals()
  expect(modelOf(light?.argv ?? [])).toEqual(['haiku', 'high'])
  expect(light?.argv.at(-1)).toContain('You run on the light seat (rule `hygiene:links`)')
  const shown = (await must(flow(), ['issue', 'show', issue])).json as { ranOn: unknown }
  expect(shown.ranOn).toEqual({ tier: 'haiku', effort: 'high', role: 'light' })

  // The first stall is the steward's to end, as any other; the owner's wake stands in for it here.
  await block(flow(), issue, 'the link target moved and I cannot find where')
  expect(await stateOf(lab.world, issue)).toMatchObject({ state: 'waiting', wait: 'blocked' })
  await must(flow(), ['issue', 'note', issue, 'look in docs/archive', '--wake'])
  expect((await stateOf(lab.world, issue)).state).toBe('working')

  // The second stall moves it up: the attempt ends and it queues again, counted once.
  await block(flow(), issue, 'still cannot find it')
  expect((await stateOf(lab.world, issue)).state).toBe('queued')
  const moved = await lab.world.db.sql`
    SELECT payload FROM factory.issue_events WHERE issue_id = ${issue} AND kind = 'moved_up' AND result = 'applied'`
  expect(moved.map((row: { payload: unknown }) => row.payload)).toEqual([
    { attempt: 1, why: 'the light lead stalled 2 times' },
  ])

  await tick(flow())
  await admitted(flow(), issue)
  await tick(flow())
  const second = terminals().find((terminal) => terminal.labels['factory.key']?.endsWith('-2'))
  expect(modelOf(second?.argv ?? [])).toEqual(['sonnet', 'high'])
  const brief = second?.argv.at(-1) ?? ''
  expect(brief).toContain('## Moved up from the light seat')
  expect(brief).toContain('the light lead stalled 2 times')
  expect(brief).not.toContain('## Your seat')
  const after = (await must(flow(), ['issue', 'show', issue])).json as {
    ranOn: unknown
    timeline: { kind: string; text: string }[]
  }
  expect(after.ranOn).toEqual({ tier: 'sonnet', effort: 'high', role: 'lead' })
  expect(after.timeline.find((line) => line.kind === 'moved_up')?.text).toBe(
    'Moved up from the light seat to the lead seat: the light lead stalled 2 times',
  )
  // a real sweep, two admissions and three ticks: past the 30 s default on a loaded runner
}, 180_000)
