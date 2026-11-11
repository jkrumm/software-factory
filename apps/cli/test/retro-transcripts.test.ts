import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { digestOf, transcriptPass, type TranscriptSession } from '../src/retro-transcripts.ts'

const at = (s: number): string => new Date(Date.UTC(2026, 10, 10, 10, 0, s)).toISOString()
const assistant = (s: number, content: unknown[], extra: object = {}): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at(s),
    requestId: `req${s}`,
    message: { content, usage: {} },
    ...extra,
  })
const user = (s: number, content: unknown, extra: object = {}): string =>
  JSON.stringify({ type: 'user', timestamp: at(s), message: { content }, ...extra })
const bash = (id: string, command: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command } })
const result = (id: string, content: string, isError = false) => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
  ...(isError ? { is_error: true } : {}),
})

let dir: string
let session: TranscriptSession
let missing: TranscriptSession

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'retro-transcripts-'))
  const path = join(dir, 'a.jsonl')
  writeFileSync(
    path,
    [
      user(0, 'start the work'),
      assistant(10, [{ type: 'text', text: 'running the check' }, bash('t1', 'make -C apps/x check')]),
      user(70, [result('t1', 'all green')]),
      assistant(75, [bash('t2', 'sleep 60; cat log')]),
      user(76, [result('t2', 'Blocked: sleep 60 followed by: cat log', true)]),
      assistant(80, [
        { type: 'tool_use', id: 't3', name: 'Agent', input: { subagent_type: 'Explore', description: 'look' } },
      ]),
      user(100, [result('t3', 'found it')]),
      assistant(110, [{ type: 'text', text: 'done for now' }]),
      '{ not json',
      assistant(115, [bash('s1', 'make check')], { isSidechain: true }),
      user(500, 'Note: the owner changed the plan'),
      assistant(510, [{ type: 'text', text: 'ok' }]),
    ].join('\n'),
  )
  session = { issue: '1', attempt: 1, model: 'm', account: null, transcriptPath: path }
  missing = { issue: '2', attempt: 1, model: null, account: null, transcriptPath: join(dir, 'nope.jsonl') }
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('transcriptPass', () => {
  test('counts categories, idle, errors and make check runs; skips sidechain and malformed lines', () => {
    const report = transcriptPass([session, session, missing])
    expect(report.sessions).toBe(1)
    expect(report.unreadable).toBe(1)
    expect(report.wallSeconds).toBe(510)
    expect(report.byCategory['make check']).toEqual({ seconds: 60, calls: 1 })
    expect(report.byCategory['sleep/wait']?.calls).toBe(1)
    expect(report.byCategory['subagent:Explore']).toEqual({ seconds: 20, calls: 1 })
    expect(report.byCategory['~idle before prompt']).toEqual({ seconds: 390, calls: 1 })
    expect(report.byCategory['~model thinking']?.seconds).toBe(19)
    expect(report.idle).toHaveLength(1)
    expect(report.idle[0]).toMatchObject({ kind: 'factory note', seconds: 390, count: 1 })
    expect(report.toolErrors.total).toBe(1)
    expect(report.toolErrors.perSession).toBe(1)
    expect(report.toolErrors.classes[0]).toMatchObject({ class: 'blocked sleep', count: 1 })
    expect(report.makeCheckRuns).toEqual({ total: 1, perIssue: 1 })
    expect(report.perSession[0]).toMatchObject({ userTurns: 2, requests: 5 })
  })

  test('an empty list yields null averages', () => {
    const report = transcriptPass([])
    expect(report.toolErrors.perSession).toBeNull()
    expect(report.makeCheckRuns.perIssue).toBeNull()
  })

  test('writes digests only for requested issues and appends across attempts', () => {
    const digestDir = join(dir, 'digest')
    const other = { ...session, issue: '9' }
    const again = { ...session, attempt: 2, transcriptPath: `${session.transcriptPath}.copy` }
    writeFileSync(again.transcriptPath, readFileSync(session.transcriptPath))
    transcriptPass([session, other, again], { digestDir, digestIssues: ['1'] })
    expect(existsSync(join(digestDir, '9.txt'))).toBe(false)
    const text = readFileSync(join(digestDir, '1.txt'), 'utf8')
    expect(text.match(/^# 1 attempt/gm)).toHaveLength(2)
    expect(text).toContain('LEAD: running the check')
    expect(text).toContain('>>> PROMPT/NOTE: Note: the owner changed the plan')
  })
})

describe('digestOf', () => {
  test('returns stats and a text with a header and tool lines', () => {
    const { stats, text } = digestOf(session)
    expect(stats.toolErrors).toBe(1)
    expect(text).toContain('[make check 60s] make -C apps/x check')
    expect(text).toContain('ERR: Blocked: sleep 60')
  })
  test('an unreadable path yields an empty digest', () => {
    expect(digestOf(missing).text).toBe('')
  })
})
