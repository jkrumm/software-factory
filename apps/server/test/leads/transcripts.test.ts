import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { fileTranscriptTails, fileTranscripts } from '../../src/adapters/leads/transcripts.ts'
import { issueId } from '../../src/kernel/ids.ts'
import { archivedTranscript, transcriptPathNow } from '../../src/kernel/transcript-archive.ts'

let base: string
let projects: string
let archive: string
const DAY = 86_400_000
const NOW = new Date('2026-11-21T12:00:00Z')

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'transcripts-'))
  projects = join(base, 'projects')
  archive = join(base, 'archive')
  mkdirSync(projects, { recursive: true })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const store = (retentionDays = 90) =>
  fileTranscripts({ archiveDir: archive, projectsDirs: async () => [projects], retentionDays, now: () => NOW })

const line = (text: string) =>
  `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`

/** A finished factory attempt's Claude project directory: one transcript and a subagent's. */
function project(issue: number, attempt: number, session = 's1', body = line('hello')) {
  const dir = join(projects, `-work-repo--claude-worktrees-factory-${issue}-${attempt}`)
  mkdirSync(join(dir, session, 'subagents'), { recursive: true })
  writeFileSync(join(dir, `${session}.jsonl`), body)
  writeFileSync(join(dir, session, 'subagents', 'agent-a.jsonl'), line('sub'))
  return { dir, transcript: join(dir, `${session}.jsonl`) }
}

/** The pre-compression archive: plain files. */
function plainArchive(issue: number, attempt: number, ageDays: number) {
  const dir = join(archive, String(issue), String(attempt))
  mkdirSync(join(dir, 's1', 'subagents'), { recursive: true })
  writeFileSync(join(dir, 's1.jsonl'), line('legacy'))
  writeFileSync(join(dir, 's1', 'subagents', 'agent-a.jsonl'), line('sub'))
  const at = new Date(NOW.getTime() - ageDays * DAY)
  utimesSync(dir, at, at)
  return dir
}

describe('archive', () => {
  test('stores the transcript compressed, then removes the Claude copy and the worktree project directory', async () => {
    const { dir, transcript } = project(7, 1)
    const done = await store().archive({
      issue: issueId(7),
      attempt: 1,
      account: null,
      sessions: [{ claudeSession: 's1', transcriptPath: transcript }],
    })
    expect(done).toEqual({ ok: true, value: { archived: 1 } })
    const archived = archivedTranscript(archive, { issue: 7, attempt: 1, claudeSession: 's1' })
    expect(zstdDecompressSync(readFileSync(archived)).toString('utf8')).toBe(line('hello'))
    const sub = join(archive, '7', '1', 's1', 'subagents', 'agent-a.jsonl.zst')
    expect(zstdDecompressSync(readFileSync(sub)).toString('utf8')).toBe(line('sub'))
    expect(existsSync(dir)).toBe(false)
  })

  test('a transcript outside the Claude projects directories is not touched', async () => {
    const outside = join(base, 'elsewhere.jsonl')
    writeFileSync(outside, line('mine'))
    const done = await store().archive({
      issue: issueId(7),
      attempt: 1,
      account: null,
      sessions: [{ claudeSession: 's1', transcriptPath: outside }],
    })
    expect(done).toEqual({ ok: true, value: { archived: 0 } })
    expect(existsSync(outside)).toBe(true)
  })

  test('the project directory of the attempt stays while a transcript in it was not archived', async () => {
    const { dir, transcript } = project(7, 1)
    writeFileSync(join(dir, 'other.jsonl'), line('not the lead'))
    await store().archive({
      issue: issueId(7),
      attempt: 1,
      account: null,
      sessions: [{ claudeSession: 's1', transcriptPath: transcript }],
    })
    expect(existsSync(join(dir, 'other.jsonl'))).toBe(true)
  })

  test('a project whose subagent transcripts are not archived yet (a crash mid-archive) is kept by tidy', async () => {
    const { dir } = project(9, 1)
    // the main transcript's copy is in place, the subagents' are not
    const attempt = join(archive, '9', '1')
    mkdirSync(attempt, { recursive: true })
    writeFileSync(join(attempt, 's1.jsonl.zst'), 'x')
    const done = await store().tidy()
    expect(done.ok && done.value?.projectsRemoved).toBe(0)
    expect(existsSync(join(dir, 's1', 'subagents', 'agent-a.jsonl'))).toBe(true)
  })

  test('a project holding subagent transcripts of a session whose own transcript is gone is kept until they are archived', async () => {
    const dir = join(projects, '-work-repo--claude-worktrees-factory-10-1')
    mkdirSync(join(dir, 's2', 'subagents'), { recursive: true })
    writeFileSync(join(dir, 's2', 'subagents', 'agent-b.jsonl'), line('sub'))
    mkdirSync(join(archive, '10', '1'), { recursive: true })
    const done = await store().tidy()
    expect(done.ok && done.value?.projectsRemoved).toBe(0)
    expect(existsSync(join(dir, 's2', 'subagents', 'agent-b.jsonl'))).toBe(true)
  })

  test('the path a reader gets is the archive copy once the Claude copy is gone', async () => {
    const { transcript } = project(7, 1)
    expect(transcriptPathNow(archive, { issue: 7, attempt: 1, path: transcript })).toBe(transcript)
    await store().archive({
      issue: issueId(7),
      attempt: 1,
      account: null,
      sessions: [{ claudeSession: 's1', transcriptPath: transcript }],
    })
    const now = await store().resolve({ issue: issueId(7), attempt: 1, path: transcript })
    expect(now).toBe(archivedTranscript(archive, { issue: 7, attempt: 1, claudeSession: 's1' }))
    expect(transcriptPathNow(archive, { issue: 7, attempt: 1, path: transcript })).toBe(now)
  })

  test('the last words of an archived transcript read through the compression', async () => {
    const { transcript } = project(7, 1, 's1', line('first') + line('the last word'))
    await store().archive({
      issue: issueId(7),
      attempt: 1,
      account: null,
      sessions: [{ claudeSession: 's1', transcriptPath: transcript }],
    })
    const tails = fileTranscriptTails({ projectsDirs: async () => [projects], archiveDir: archive })
    const path = await store().resolve({ issue: issueId(7), attempt: 1, path: transcript })
    const words = await tails.lastWords(path, 1000)
    expect(words).toEqual({ ok: true, value: 'first\n\nthe last word' })
  })
})

describe('tidy', () => {
  test('attempts archived longer ago than the retention are deleted, younger ones kept, 0 keeps all', async () => {
    plainArchive(1, 1, 100)
    plainArchive(1, 2, 10)
    plainArchive(2, 1, 400)
    const kept = await store(0).tidy()
    expect(kept.ok && kept.value?.expired).toBe(0)
    expect(existsSync(join(archive, '2', '1'))).toBe(true)

    const done = await store(90).tidy()
    expect(done.ok && done.value?.expired).toBe(2)
    expect(existsSync(join(archive, '1', '1'))).toBe(false)
    expect(existsSync(join(archive, '2'))).toBe(false)
    expect(existsSync(join(archive, '1', '2'))).toBe(true)
  })

  test('plain files of an older archive are compressed, equal when read back, and keep the attempt its age', async () => {
    const dir = plainArchive(5, 1, 30)
    const done = await store().tidy()
    expect(done.ok && done.value?.converted.files).toBe(2)
    expect(existsSync(join(dir, 's1.jsonl'))).toBe(false)
    expect(zstdDecompressSync(readFileSync(join(dir, 's1.jsonl.zst'))).toString('utf8')).toBe(line('legacy'))
    expect(existsSync(join(dir, 's1', 'subagents', 'agent-a.jsonl.zst'))).toBe(true)
    // thirty days old before, thirty days old after: a retention of 20 days now removes it
    const later = await store(20).tidy()
    expect(later.ok && later.value?.expired).toBe(1)
  })

  test('the project directory of a finished worktree goes once its transcripts are archived; others stay', async () => {
    const archivedAttempt = project(5, 1)
    const unarchived = project(6, 1)
    const live = join(projects, '-work-repo')
    mkdirSync(live)
    plainArchive(5, 1, 1)
    const done = await store().tidy()
    expect(done.ok && done.value?.projectsRemoved).toBe(1)
    expect(existsSync(archivedAttempt.dir)).toBe(false)
    expect(existsSync(unarchived.dir)).toBe(true)
    expect(existsSync(live)).toBe(true)
  })
})
