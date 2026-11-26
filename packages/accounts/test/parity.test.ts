// The golden of the dotfiles CLI's contract (test/fixtures/parity-golden.json): see parity-lib.ts. The package must still print it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { GOLDEN, type Result, cases, pool, removeFixtures, run, setupFixtures, v1View } from './parity-lib.ts'

const golden: Record<string, Result> = JSON.parse(readFileSync(GOLDEN, 'utf8'))

beforeAll(setupFixtures)
afterAll(removeFixtures)

const show = (r: unknown) => JSON.stringify(r).slice(0, 400)

describe('package CLI against the dotfiles golden', () => {
  test('every verb and lane: the package prints what the dotfiles CLI printed (golden)', async () => {
    expect(Object.keys(golden).sort()).toEqual(cases.map((c) => c.name).sort())
    const gots = await pool(cases, async (c) => v1View(c, await run(c)))
    const diffs = cases.flatMap((c, i) =>
      JSON.stringify(golden[c.name]) === JSON.stringify(gots[i])
        ? []
        : [`${c.name}\n  golden:  ${show(golden[c.name])}\n  package: ${show(gots[i])}`],
    )
    expect(diffs.join('\n')).toBe('')
  }, 300_000)
})
