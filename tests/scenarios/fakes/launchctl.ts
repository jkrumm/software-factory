#!/usr/bin/env bun
// The fake `launchctl` the intake scenarios put on PATH. `launchctl print gui/<uid>/<label>` prints what the scenario
// wrote to `FACTORY_FAKE_LAUNCHCTL` (a JSON object of label to {state, runs, exit}); an unknown label is not loaded (113).
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const log = process.env.FACTORY_FAKE_LOG
if (log) appendFileSync(log, `${JSON.stringify({ tool: 'launchctl', args })}\n`)

const label = (args[1] ?? '').split('/').at(-1) ?? ''
const file = process.env.FACTORY_FAKE_LAUNCHCTL
const jobs: Record<string, { state: string; runs: number; exit?: number }> =
  file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
const job = jobs[label]
if (args[0] !== 'print' || !job) {
  process.stderr.write(`Could not find service "${label}" in domain for user gui\n`)
  process.exit(113)
}
const lines = [`gui/501/${label} = {`, `\tactive count = ${job.state === 'running' ? 1 : 0}`, `\tstate = ${job.state}`]
lines.push(`\truns = ${job.runs}`)
if (job.exit !== undefined) lines.push(`\tlast exit code = ${job.exit}`)
lines.push('}')
process.stdout.write(`${lines.join('\n')}\n`)
