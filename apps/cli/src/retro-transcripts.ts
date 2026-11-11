import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The transcript pass of a weekly retro: a deterministic read (no model call) of Claude Code lead-session transcripts.
// Transcript text is untrusted data: it is parsed and counted, never evaluated.

export interface TranscriptSession {
  issue: string
  attempt: number
  model: string | null
  account: string | null
  transcriptPath: string
}
export interface CategorySeconds {
  seconds: number
  calls: number
}
export interface IdleKind {
  kind: string
  seconds: number
  count: number
  example: string
}
export interface ErrorClass {
  class: string
  count: number
  example: string
}
export interface SessionDigestStats {
  issue: string
  attempt: number
  wallSeconds: number
  toolSeconds: number
  thinkSeconds: number
  idleSeconds: number
  toolErrors: number
  makeCheckRuns: number
  userTurns: number
  requests: number
}
export interface TranscriptReport {
  sessions: number
  unreadable: number
  wallSeconds: number
  byCategory: Record<string, CategorySeconds>
  idle: IdleKind[]
  toolErrors: { total: number; perSession: number | null; classes: ErrorClass[] }
  makeCheckRuns: { total: number; perIssue: number | null }
  perSession: SessionDigestStats[]
}

const EXAMPLE_CHARS = 200
const THINK_CAP_SECONDS = 600

const MAKE_CHECK = /\bmake\s+(-C\s+\S+\s+)?check\b|agw check/

// First match wins; order matters.
const BASH_CATEGORIES: readonly (readonly [string, RegExp])[] = [
  ['make check', MAKE_CHECK],
  [
    'make test/bun test',
    /\bmake\s+(-C\s+\S+\s+)?(test|e2e)\b|\bbun\s+(run\s+)?test\b|pytest|vitest|playwright|xcodebuild|go test|cargo test/,
  ],
  ['make verify', /\bmake\s+(-C\s+\S+\s+)?verify\b/],
  ['make deploy', /\bmake\s+(-C\s+\S+\s+)?deploy\b|deploy-lock/],
  ['merge-guard', /merge-guard/],
  ['gh ci wait', /gh\s+(pr\s+checks|run\s+watch|run\s+view|run\s+list)/],
  ['gh pr', /\bgh\s+pr\b/],
  ['agw review', /agw\s+review/],
  ['agw other', /\bagw\b/],
  ['factory cli', /\bfactory\b|\brd\b/],
  ['sleep/wait', /^\s*sleep\b|;\s*sleep\b|until .*sleep|while .*sleep/],
  ['git', /\bgit\b/],
  ['install/build', /\bbun\s+(install|run build)|npm (ci|install)|make\s+build/],
]

// Tool-error classes, first match wins; anything unmatched is 'other'.
const ERROR_CLASSES: readonly (readonly [string, RegExp])[] = [
  ['blocked sleep', /Blocked: sleep\b/],
  ['hook denied', /hook error|hook denied|denied by (a )?hook|permission (to use|denied)|doesn't want to proceed/i],
  ['file not read yet / not found', /File has not been read yet|No such file or directory|File does not exist|ENOENT/i],
  ['edit string not found', /String to replace not found|old_string|found \d+ matches/i],
  ['input validation', /InputValidationError|tool_use_error/],
  ['timeout', /timed out|timeout/i],
  ['command exit non-zero', /^Exit code \d+/],
]
const OTHER_ERROR = 'other'

const bashCategory = (command: string): string =>
  BASH_CATEGORIES.find(([, re]) => re.test(command))?.[0] ?? 'bash other'

const errorClassOf = (text: string): string => ERROR_CLASSES.find(([, re]) => re.test(text))?.[0] ?? OTHER_ERROR

const clip = (text: string, max = EXAMPLE_CHARS): string => text.slice(0, max).replaceAll('\n', ' ')

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const idleKind = (text: string): string => {
  const head = text.slice(0, 400)
  if (head.includes('<task-notification')) {
    return head.toLowerCase().includes('agent') ? 'notify:agent' : 'notify:background-bash/monitor'
  }
  if (/stop hook/i.test(head)) return 'stop send-back'
  if (head.startsWith('<system-reminder') || head.includes('<local-command')) return 'system'
  if (/^\[?(Note|note|The owner|Orchestrator|Owner)/.test(head)) return 'factory note'
  const prefix = head
    .slice(0, 40)
    .replace(/[0-9]+/g, 'N')
    .replaceAll('\n', ' ')
  return `other:${prefix}`
}

const resultText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((x) => (isObject(x) ? str(x.text) : '')).join(' ')
}

const stamp = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(5, 19)

interface Analysis {
  stats: SessionDigestStats
  lines: string[]
  header: string
  categories: Map<string, CategorySeconds>
  idleGaps: { kind: string; seconds: number; example: string }[]
  errors: { class: string; example: string }[]
}

interface PendingUse {
  start: number
  category: string
  short: string
}

const toolUse = (b: Json): { category: string; short: string } => {
  const input = isObject(b.input) ? b.input : {}
  const name = str(b.name)
  if (name === 'Bash') {
    const command = str(input.command)
    return { category: bashCategory(command), short: command.slice(0, 260).replaceAll('\n', ' ; ') }
  }
  if (name === 'Agent' || name === 'Task') {
    const short = `${str(input.description)} | ${str(input.prompt).slice(0, 200).replaceAll('\n', ' ')}`
    return { category: `subagent:${str(input.subagent_type) || '?'}`, short }
  }
  if (name === 'Skill') return { category: `skill:${str(input.skill)}`, short: str(input.args).slice(0, 100) }
  const short = str(input.file_path) || str(input.pattern) || str(input.query)
  return { category: name, short: short.slice(0, 120) }
}

function analyze(session: TranscriptSession): Analysis | null {
  let raw: string
  try {
    raw = readFileSync(session.transcriptPath, 'utf8')
  } catch {
    return null
  }
  const uses = new Map<string, PendingUse>()
  const categories = new Map<string, CategorySeconds>()
  const idleGaps: Analysis['idleGaps'] = []
  const errors: Analysis['errors'] = []
  const requests = new Set<string>()
  const lines: string[] = []
  let first: number | null = null
  let last = 0
  let prev: { kind: 'assistant' | 'user' | 'tool_result'; at: number } | null = null
  let think = 0
  let idle = 0
  let userTurns = 0
  let toolErrors = 0
  let makeCheckRuns = 0

  const prompt = (at: number, text: string): void => {
    userTurns++
    lines.push(`${stamp(at)} >>> PROMPT/NOTE: ${text.slice(0, 700)}`)
    if (prev?.kind !== 'assistant') return
    const seconds = (at - prev.at) / 1000
    idle += seconds
    idleGaps.push({ kind: idleKind(text), seconds, example: clip(text) })
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObject(record) || record.isSidechain) continue
    const type = record.type
    if (type !== 'user' && type !== 'assistant') continue
    const at = Date.parse(str(record.timestamp))
    if (Number.isNaN(at)) continue
    first ??= at
    last = at
    const message = isObject(record.message) ? record.message : {}
    const content = message.content

    if (type === 'assistant') {
      if (prev?.kind === 'tool_result') think += Math.min((at - prev.at) / 1000, THINK_CAP_SECONDS)
      const requestId = str(record.requestId)
      if (isObject(message.usage) && requestId) requests.add(requestId)
      for (const b of Array.isArray(content) ? content : []) {
        if (!isObject(b)) continue
        if (b.type === 'text' && str(b.text).trim()) {
          lines.push(`${stamp(at)} LEAD: ${str(b.text).trim().slice(0, 500)}`)
        }
        if (b.type === 'tool_use' && str(b.id)) {
          const { category, short } = toolUse(b)
          uses.set(str(b.id), { start: at, category, short })
          if (b.name === 'Bash' && MAKE_CHECK.test(str(isObject(b.input) ? b.input.command : ''))) makeCheckRuns++
        }
      }
      prev = { kind: 'assistant', at }
      continue
    }

    if (typeof content === 'string') {
      prompt(at, content)
      prev = { kind: 'user', at }
      continue
    }
    const blocks = (Array.isArray(content) ? content : []).filter(isObject)
    const isToolResult = blocks.some((b) => b.type === 'tool_result')
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const use = uses.get(str(b.tool_use_id))
        if (!use) continue
        uses.delete(str(b.tool_use_id))
        const seconds = (at - use.start) / 1000
        const entry = categories.get(use.category) ?? { seconds: 0, calls: 0 }
        entry.seconds += seconds
        entry.calls++
        categories.set(use.category, entry)
        const text = resultText(b.content)
        let tail = ''
        if (b.is_error) {
          toolErrors++
          errors.push({ class: errorClassOf(text), example: clip(text) })
          tail = ` ERR: ${text.slice(0, 300).replaceAll('\n', ' ')}`
        } else if (seconds > 60 || /^(make|factory|gh|merge|agw|subagent)/.test(use.category)) {
          tail = ` -> ${text.slice(-160).replaceAll('\n', ' ')}`
        }
        lines.push(`${stamp(use.start)} [${use.category} ${seconds.toFixed(0)}s] ${use.short}${tail}`)
      } else if (b.type === 'text' && !isToolResult) {
        prompt(at, str(b.text))
      }
    }
    prev = { kind: isToolResult ? 'tool_result' : 'user', at }
  }
  if (first === null) return null

  const wallSeconds = (last - first) / 1000
  const toolSeconds = [...categories.values()].reduce((sum, c) => sum + c.seconds, 0)
  const stats: SessionDigestStats = {
    issue: session.issue,
    attempt: session.attempt,
    wallSeconds,
    toolSeconds,
    thinkSeconds: think,
    idleSeconds: idle,
    toolErrors,
    makeCheckRuns,
    userTurns,
    requests: requests.size,
  }
  const top = [...categories.entries()]
    .sort((a, b) => b[1].seconds - a[1].seconds)
    .slice(0, 12)
    .map(([k, v]) => `${k}=${v.seconds.toFixed(0)}s/${v.calls}x`)
    .join(', ')
  const min = (s: number): string => (s / 60).toFixed(0)
  const header =
    `# ${session.issue} attempt ${session.attempt} model=${session.model} wall=${min(wallSeconds)}min ` +
    `tool=${min(toolSeconds)}min think=${min(think)}min idle=${min(idle)}min errors=${toolErrors} ` +
    `prompts=${userTurns} requests=${requests.size}\n# seconds by category: ${top}`
  return { stats, lines, header, categories, idleGaps, errors }
}

const digestText = (a: Analysis): string => `${a.header}\n${a.lines.join('\n')}\n`

const emptyStats = (s: TranscriptSession): SessionDigestStats => ({
  issue: s.issue,
  attempt: s.attempt,
  wallSeconds: 0,
  toolSeconds: 0,
  thinkSeconds: 0,
  idleSeconds: 0,
  toolErrors: 0,
  makeCheckRuns: 0,
  userTurns: 0,
  requests: 0,
})

/** The per-session text digest; an unreadable or empty transcript yields zero stats and an empty text. */
export function digestOf(session: TranscriptSession): { stats: SessionDigestStats; text: string } {
  const a = analyze(session)
  return a ? { stats: a.stats, text: digestText(a) } : { stats: emptyStats(session), text: '' }
}

const orNull = (total: number, per: number): number | null => (per === 0 ? null : total / per)

export function transcriptPass(
  sessions: readonly TranscriptSession[],
  options: { digestDir?: string; digestIssues?: readonly string[] } = {},
): TranscriptReport {
  const seen = new Set<string>()
  const byCategory = new Map<string, CategorySeconds>()
  const idle = new Map<string, IdleKind>()
  const classes = new Map<string, ErrorClass>()
  const perSession: SessionDigestStats[] = []
  const makeCheckIssues = new Set<string>()
  let read = 0
  let unreadable = 0
  let wallSeconds = 0
  let toolErrors = 0
  let makeCheckRuns = 0
  let thinkSeconds = 0
  let idleSeconds = 0
  let idleCount = 0
  let thinkCount = 0
  if (options.digestDir) mkdirSync(options.digestDir, { recursive: true })

  for (const session of sessions) {
    if (seen.has(session.transcriptPath)) continue
    seen.add(session.transcriptPath)
    const a = analyze(session)
    if (!a) {
      unreadable++
      continue
    }
    read++
    wallSeconds += a.stats.wallSeconds
    toolErrors += a.stats.toolErrors
    makeCheckRuns += a.stats.makeCheckRuns
    thinkSeconds += a.stats.thinkSeconds
    idleSeconds += a.stats.idleSeconds
    idleCount += a.idleGaps.length
    thinkCount++
    if (a.stats.makeCheckRuns > 0) makeCheckIssues.add(session.issue)
    perSession.push(a.stats)
    for (const [k, v] of a.categories) {
      const entry = byCategory.get(k) ?? { seconds: 0, calls: 0 }
      entry.seconds += v.seconds
      entry.calls += v.calls
      byCategory.set(k, entry)
    }
    for (const g of a.idleGaps) {
      const entry = idle.get(g.kind) ?? { kind: g.kind, seconds: 0, count: 0, example: g.example }
      entry.seconds += g.seconds
      entry.count++
      idle.set(g.kind, entry)
    }
    for (const e of a.errors) {
      const entry = classes.get(e.class) ?? { class: e.class, count: 0, example: e.example }
      entry.count++
      classes.set(e.class, entry)
    }
    if (options.digestDir && (!options.digestIssues || options.digestIssues.includes(session.issue))) {
      appendFileSync(join(options.digestDir, `${session.issue}.txt`), digestText(a))
    }
  }

  const categories = Object.fromEntries(byCategory)
  if (thinkSeconds > 0) categories['~model thinking'] = { seconds: thinkSeconds, calls: thinkCount }
  if (idleSeconds > 0) categories['~idle before prompt'] = { seconds: idleSeconds, calls: idleCount }
  return {
    sessions: read,
    unreadable,
    wallSeconds,
    byCategory: categories,
    idle: [...idle.values()].sort((a, b) => b.seconds - a.seconds),
    toolErrors: {
      total: toolErrors,
      perSession: orNull(toolErrors, read),
      classes: [...classes.values()].sort((a, b) => b.count - a.count),
    },
    makeCheckRuns: {
      total: makeCheckRuns,
      perIssue: orNull(makeCheckRuns, new Set(perSession.map((s) => s.issue)).size),
    },
    perSession,
  }
}
