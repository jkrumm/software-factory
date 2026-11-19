#!/usr/bin/env bun
// Measures the simulation's load model from this machine's records and writes src/load-model.json (docs/accounts.md
// §The policy lab): the sample log and the pick log under $CLAUDE_ACCOUNTS_HISTORY / $CLAUDE_ACCOUNTS_PICKS, and every
// session transcript under the accounts' projects directories (first write = birth time, last write = mtime).
//   bun packages/accounts/scripts/measure-load.ts [--from <iso>] [--to <iso>] [--out <file>]
// Default range: from the day every enabled account has sample lines to now.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readSampleLines } from '../src/history-store.ts'
import { measureLoad } from '../src/measure.ts'
import { historyDir, picksPath } from '../src/paths.ts'
import { accountDir, loadRegistry } from '../src/registry.ts'

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i < 0 ? null : (process.argv[i + 1] ?? null)
}
const reg = loadRegistry()
const lines = readSampleLines(historyDir())
const picks = existsSync(picksPath())
  ? readFileSync(picksPath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          const p = JSON.parse(l) as { ts?: unknown; lane?: unknown }
          return typeof p.ts === 'string' && typeof p.lane === 'string' ? [{ ts: p.ts, lane: p.lane }] : []
        } catch {
          return []
        }
      })
  : []

// every account's projects directory, once (they may be one directory behind symlinks)
const dirs = new Set<string>()
for (const a of Object.values(reg.accounts)) {
  const d = join(accountDir(a) ?? join(homedir(), '.claude'), 'projects')
  if (existsSync(d)) dirs.add(realpathSync(d))
}
const sessions: [number, number][] = []
for (const d of dirs)
  for (const project of readdirSync(d, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const f of readdirSync(join(d, project.name))) {
      if (!f.endsWith('.jsonl')) continue
      const s = statSync(join(d, project.name, f))
      if (s.size > 0) sessions.push([s.birthtimeMs, s.mtimeMs])
    }
  }

const enabled = Object.keys(reg.accounts).filter((id) => reg.accounts[id].enabled)
const firstOf = (id: string) => Math.min(...lines.filter((l) => l.id === id).map((l) => l.ts))
const nowMs = Date.now()
const fromMs = arg('--from') ? Date.parse(arg('--from')!) : Math.max(...enabled.map(firstOf))
const toMs = arg('--to') ? Date.parse(arg('--to')!) : nowMs
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) throw new Error('no usable range')

const model = measureLoad({
  reg,
  lines,
  picks,
  sessions,
  fromMs,
  toMs,
  nowMs,
  sources: {
    samples:
      "the sample log (samples-YYYY-MM.jsonl): weekly increments per account (a week's running maximum), 5 h and weekly increments inside one window",
    picks: 'picks.jsonl: the lane of every pick',
    sessions:
      'session transcripts (<account dir>/projects/*/*.jsonl): first to last write; units per session hour = the weekly units consumed / the session hours',
  },
})
const out = resolve(arg('--out') ?? join(import.meta.dir, '..', 'src', 'load-model.json'))
writeFileSync(out, `${JSON.stringify(model, null, 2)}\n`)
console.log(`${out}: ${model.range.from} .. ${model.range.to}, demand ${model.demand}, ${model.sources.counts}`)
