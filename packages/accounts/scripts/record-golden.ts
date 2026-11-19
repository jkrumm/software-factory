#!/usr/bin/env bun
// Records test/fixtures/parity-golden.json from the dotfiles CLI: what the package CLI must print for every verb and lane.
// Only for a deliberate change of the contract; needs the dotfiles checkout (or $CLAUDE_ACCOUNT_DOTFILES_CLI).
import { writeFileSync } from 'node:fs'
import {
  DOTFILES_CLI,
  GOLDEN,
  type Result,
  cases,
  haveDotfiles,
  pool,
  removeFixtures,
  run,
  setupFixtures,
} from '../test/parity-lib.ts'

if (!haveDotfiles) {
  console.error(`no dotfiles CLI at ${DOTFILES_CLI}`)
  process.exit(1)
}
setupFixtures()
try {
  const all = await pool(cases, (c) => run(DOTFILES_CLI, c))
  const golden: Record<string, Result> = {}
  cases.forEach((c, i) => {
    golden[c.name] = all[i]
  })
  writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 1)}\n`)
  console.log(`${cases.length} cases recorded in ${GOLDEN}`)
} finally {
  removeFixtures()
}
