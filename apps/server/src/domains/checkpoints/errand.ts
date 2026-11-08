import type { Id } from '../../kernel/ids.ts'
import { err, ok, type Result } from '../../kernel/result.ts'
import type { ErrandScreenAnswer } from '@software-factory/contract'
import { JUDGE_BACKOFF_MS, JUDGE_MAX_TRIES, type MissingFields } from './decision.ts'

export type ErrandId = Id<'errand'>

export interface ErrandInput {
  summary: string
  detail: string | null
}

export const MAX_SUMMARY = 200
export const MAX_DETAIL = 4000

/** Reads an Errand: one line for the owner, and the steps his hands must take. */
export function readErrand(raw: unknown): Result<ErrandInput, MissingFields> {
  const body = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const problems: string[] = []
  const summary = typeof body.summary === 'string' ? body.summary.trim() : ''
  if (summary === '') problems.push('summary')
  if (summary.length > MAX_SUMMARY) problems.push(`summary (longer than ${MAX_SUMMARY} characters)`)
  const detail = typeof body.detail === 'string' && body.detail.trim() !== '' ? body.detail.trim() : null
  if (detail !== null && detail.length > MAX_DETAIL) problems.push(`detail (longer than ${MAX_DETAIL} characters)`)
  if (problems.length > 0) {
    return err({ kind: 'missing_field', fields: problems, detail: `an Errand needs: ${problems.join(', ')}` })
  }
  return ok({ summary, detail })
}

/** Failed calls of the screen before the Errand reaches the owner unscreened; the wait between them. */
export const ERRAND_SCREEN_MAX_TRIES = JUDGE_MAX_TRIES
export const ERRAND_SCREEN_BACKOFF_MS = JUDGE_BACKOFF_MS

const REASON_MAX = 300

/** Commands a token can run: the first word of a code span, a fenced block line or a `$ ` line. */
const COMMAND_WORDS: readonly string[] = [
  'gh',
  'git',
  'curl',
  'wget',
  'op',
  'secrets-run',
  'factory',
  'agw',
  'rd',
  'make',
  'bun',
  'npm',
  'npx',
  'ssh',
  'scp',
  'rsync',
  'docker',
  'psql',
  'kubectl',
  'tailscale',
  'launchctl',
  'systemctl',
]

/** Words that name a person's hands: a device, a portal, a physical step, a biometric. Any one keeps the Errand. */
const HANDS_WORDS: readonly string[] = [
  'device',
  'phone',
  'iphone',
  'ipad',
  'watch',
  'macbook',
  'laptop',
  'tap',
  'click',
  'press',
  'button',
  'portal',
  'dashboard',
  'browser',
  'sign in',
  'log in',
  'login',
  'biometric',
  'touch id',
  'face id',
  '2fa',
  'otp',
  'captcha',
  'qr',
  'approve',
  'dialog',
  'plug',
  'cable',
  'hardware',
  'physical',
  'router',
  'keychain',
  'app store',
  'testflight',
  'sim',
  '1password',
  'permission prompt',
]

const TURN_AWAY_BY_RULE =
  "That is a command a token can run: run it yourself (secrets-run for credentials, gh for GitHub), and raise an Errand only for a person's hands."

const escaped = (word: string): string => word.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
const handsWord = new RegExp(`(?<![a-z0-9])(?:${HANDS_WORDS.map(escaped).join('|')})(?![a-z0-9])`)

/** The command lines of the text: inline-code spans, fenced-block lines and `$ ` lines, each trimmed. */
function commandLines(text: string): string[] {
  const lines: string[] = []
  for (const span of text.matchAll(/`([^`\n]+)`/g)) lines.push((span[1] ?? '').trim())
  let fenced = false
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('```')) {
      fenced = !fenced
      continue
    }
    const shell = /^\s*\$ (.+)$/.exec(line)
    if (shell) lines.push((shell[1] ?? '').trim())
    else if (fenced) lines.push(line.trim())
  }
  return lines
}

/**
 * The deterministic first look: an Errand that is only a command a token can run is turned away before any model is
 * asked. Conservative on purpose: any hands word keeps it, and a false positive only bounces a note to the lead.
 */
export function screenByRule(input: ErrandInput): { verdict: 'turn_away'; reason: string } | null {
  const text = `${input.summary}\n${input.detail ?? ''}`.toLowerCase()
  if (handsWord.test(text)) return null
  const named = commandLines(text).some((line) => {
    const first = line.split(/\s+/)[0] ?? ''
    return COMMAND_WORDS.includes(first)
  })
  return named ? { verdict: 'turn_away', reason: TURN_AWAY_BY_RULE } : null
}

export type ErrandScreenChecked =
  | { action: 'pass'; note: string }
  | { action: 'turn_away'; reason: string }
  /** an answer that cannot be acted on: counted as a failed call */
  | { action: 'refused'; why: string }

/** The answer is held to its shape before anything is done: a turn-away needs a reason the lead can act on. */
export function checkErrandScreen(answer: ErrandScreenAnswer): ErrandScreenChecked {
  const reason = answer.reason.trim().slice(0, REASON_MAX)
  if (answer.verdict === 'pass') return { action: 'pass', note: reason }
  if (answer.verdict === 'turn_away' && reason !== '') return { action: 'turn_away', reason }
  return { action: 'refused', why: 'a turn-away without a reason' }
}
