// Parity with the dotfiles CLI (the live one): the same fixture registry, cache and clock go through both, every verb and
// every lane, and stdout and the exit code must be identical. Where the dotfiles checkout exists (the mini) the test runs
// both; everywhere (CI) the package is held to test/fixtures/parity-golden.json, what the dotfiles CLI printed. Registry v2's
// additive fields (usage --json rows, sample files) are stripped first (v1View): the v1 CLI never printed or wrote them.
// Record it again after a deliberate change of the contract: bun packages/accounts/scripts/record-golden.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import {
  DOTFILES_CLI,
  GOLDEN,
  PACKAGE_CLI,
  type Result,
  cases,
  v1View,
  haveDotfiles,
  pool,
  removeFixtures,
  run,
  setupFixtures,
} from './parity-lib.ts'

const golden: Record<string, Result> = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : {}

beforeAll(setupFixtures)
afterAll(removeFixtures)

const show = (r: unknown) => JSON.stringify(r).slice(0, 400)

describe('package CLI against the dotfiles CLI', () => {
  test.skipIf(!haveDotfiles)(
    'every verb and lane: identical stdout, exit code and cache state',
    async () => {
      const pairs = await pool(
        cases,
        async (c) => [c, v1View(c, await run(DOTFILES_CLI, c)), v1View(c, await run(PACKAGE_CLI, c))] as const,
      )
      const diffs = pairs
        .filter(([, want, got]) => JSON.stringify(want) !== JSON.stringify(got))
        .map(([c, want, got]) => `${c.name}\n  dotfiles: ${show(want)}\n  package:  ${show(got)}`)
      expect(diffs.join('\n')).toBe('')
      expect(cases.length).toBeGreaterThan(250)
    },
    300_000,
  )

  test('every verb and lane: the package prints what the dotfiles CLI printed (golden)', async () => {
    expect(Object.keys(golden).sort()).toEqual(cases.map((c) => c.name).sort())
    const gots = await pool(cases, async (c) => v1View(c, await run(PACKAGE_CLI, c)))
    const diffs = cases.flatMap((c, i) =>
      JSON.stringify(golden[c.name]) === JSON.stringify(gots[i])
        ? []
        : [`${c.name}\n  golden:  ${show(golden[c.name])}\n  package: ${show(gots[i])}`],
    )
    expect(diffs.join('\n')).toBe('')
  }, 300_000)
})
