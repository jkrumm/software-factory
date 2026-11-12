import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RetroModel } from '@software-factory/contract'
import { bundleOf, sampledIssues } from '../src/retro.ts'
import { run } from '../src/run.ts'

let dir: string
let model: RetroModel

const line = (type: 'user' | 'assistant', s: number, content: unknown) =>
  JSON.stringify({
    type,
    timestamp: new Date(Date.UTC(2026, 10, 10, 10, 0, s)).toISOString(),
    requestId: `r${s}`,
    message: { content },
  })

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'retro-cli-'))
  const path = join(dir, 'issue_7.jsonl')
  writeFileSync(
    path,
    [
      line('user', 0, 'brief'),
      line('assistant', 5, [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'make check' } }]),
      line('user', 65, [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]),
    ].join('\n'),
  )
  const empty = { regressed: [], stalled: [], slowest: [], refused: [], dropped: [] }
  model = {
    at: '2026-11-10T12:00:00.000Z',
    days: 7,
    window: { from: '2026-11-03T12:00:00.000Z', to: '2026-11-10T12:00:00.000Z' },
    kpis: { at: '', days: 7, window: { from: '', to: '' }, windows: [], kpis: [] },
    friction: { at: '', days: 7, window: { from: '', to: '' }, since: null, issues: 0, closed: 0, counts: [] },
    sessions: [
      { issue: 'issue_7', attempt: 1, model: null, account: null, transcriptPath: path },
      { issue: 'issue_8', attempt: 1, model: null, account: null, transcriptPath: null },
    ],
    samples: {
      ...empty,
      regressed: [{ issue: 'issue_7', why: 'x', ms: null }],
      dropped: [{ issue: 'issue_7', why: 'y', ms: null }],
    },
    ledger: [],
    capacity: null,
    build: { repos: [], unreadable: [], figures: [] },
  }
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('the bundle adds the transcript pass to the database half, counts a session with no transcript, and writes a digest per sampled Issue', () => {
  expect(sampledIssues(model.samples)).toEqual(['issue_7'])
  const digests = join(dir, 'digests')
  const once = bundleOf(model, { transcripts: true, digestDir: digests })
  expect(once.transcripts).toMatchObject({ read: true, sessions: 1, unreadable: 0, withoutTranscript: 1 })
  expect(once.transcripts?.makeCheckRuns).toEqual({ total: 1, perIssue: 1 })
  expect(once.transcripts?.digests).toEqual([{ issue: 'issue_7', file: join(digests, 'issue_7.txt') }])
  const first = readFileSync(join(digests, 'issue_7.txt'), 'utf8')
  // a second run into the same directory replaces the digest, it does not double it
  bundleOf(model, { transcripts: true, digestDir: digests })
  expect(readFileSync(join(digests, 'issue_7.txt'), 'utf8')).toBe(first)
  expect(bundleOf(model, { transcripts: false }).transcripts).toBeNull()
})

test('retro is a verb of its own: help names it, a bad --days is a usage error before any call', async () => {
  const out: string[] = []
  const err: string[] = []
  const io = {
    env: {},
    out: (t: string) => void out.push(t),
    err: (t: string) => void err.push(t),
    stdin: async () => '',
    readFile: async () => '',
  }
  expect(await run(['retro', '--help'], io)).toBe(0)
  expect(out.join('')).toContain('retro [--days <n>]')
  expect(await run(['retro', '--days', '0'], io)).not.toBe(0)
  expect(err.join('')).toContain('--days must be a whole number from 1 to 90')
})
