#!/usr/bin/env bun
/**
 * Replays recorded Errands through the rules that decide an Errand before it reaches the owner
 * (`apps/server/src/domains/checkpoints/triage.ts`): which would still reach him and why, which a rule refuses, which a fixed
 * MacBook verb runs. Usage: `factory errand list --limit 200 --format json | bun scripts/errand-replay.ts [--rows]`
 * (or a file path instead of stdin). Exits 1 when a recorded secret or hands Errand would run. The Errand text is the owner's:
 * the output goes to the terminal, never to a tracked file.
 */
import { readFileSync } from 'node:fs'
import {
  replayErrands,
  type ReplayRow,
  summarize,
  wronglyRun,
} from '../apps/server/src/domains/checkpoints/triage-replay.ts'

const args = process.argv.slice(2)
const rowsToo = args.includes('--rows')
const path = args.find((arg) => !arg.startsWith('--'))

const raw = readFileSync(path ?? 0, 'utf8')
const parsed = JSON.parse(raw) as { errands?: ReplayRow[] } | ReplayRow[]
const list = Array.isArray(parsed) ? parsed : (parsed.errands ?? [])

const replayed = replayErrands(list)
const summary = summarize(replayed)
const bad = wronglyRun(replayed)

const share = (n: number): string => (summary.total === 0 ? '0%' : `${Math.round((n / summary.total) * 100)}%`)
const lines = [
  `errands replayed: ${summary.total}`,
  `  still reach the owner: ${summary.reach} (${share(summary.reach)})`,
  ...Object.entries(summary.reachByNeed).map(([need, n]) => `    ${need}: ${n}`),
  `  refused by a rule: ${summary.refused} (${share(summary.refused)})`,
  ...Object.entries(summary.refusedByRule).map(([rule, n]) => `    ${rule}: ${n}`),
  `  run through a MacBook verb: ${summary.run} (${share(summary.run)})`,
  ...Object.entries(summary.runByVerb).map(([verb, n]) => `    ${verb}: ${n}`),
  `  secret or hands Errands that would run: ${bad.length}`,
]
console.log(lines.join('\n'))

if (rowsToo) {
  for (const { row, outcome } of replayed) {
    const what =
      outcome.kind === 'reach'
        ? `reach  ${outcome.why}`
        : outcome.kind === 'refused'
          ? `refuse ${outcome.rule}`
          : `run    ${outcome.verb}`
    console.log(`${row.id}\t${row.need ?? '-'}\t${what}\t${row.summary.replace(/\s+/g, ' ').slice(0, 80)}`)
  }
}
for (const { row } of bad) console.error(`WRONG: ${row.id} needs ${row.need} and would run`)
process.exit(bad.length > 0 ? 1 : 0)
