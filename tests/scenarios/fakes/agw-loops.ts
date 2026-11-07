import { appendFileSync, readFileSync } from 'node:fs'
import { done } from './agw-envelope.ts'

interface Scripted {
  /** a phrase of the title or detail, case-insensitive */
  match: string
  answer: unknown
}

const scriptOf = (env: string): Scripted[] => {
  const path = process.env[env]
  return path ? (JSON.parse(readFileSync(path, 'utf8')) as Scripted[]) : []
}

/**
 * `agw factory-steward` and `agw factory-triage`, input on stdin. A scenario scripts them with JSON files
 * (`FACTORY_FAKE_STEWARD_SCRIPT`, `FACTORY_FAKE_TRIAGE_SCRIPT`): `[{ "match": "<phrase>", "answer": {…} }]`, the phrase read
 * from the Issue's title, the stall's detail or the signal's words. Nothing scripted answers "I cannot tell" (steward `none`,
 * triage the empty answer). Every call is logged with its stdin.
 */
export async function loopsFake(args: string[]): Promise<number> {
  const stdin = await Bun.stdin.text()
  const log = process.env.FACTORY_FAKE_LOG
  if (log) appendFileSync(log, `${JSON.stringify({ tool: 'agw', args, stdin })}\n`)
  const input = JSON.parse(stdin) as Record<string, unknown>
  const words = JSON.stringify(input).toLowerCase()

  if (args[0] === 'factory-steward') {
    const scripted = scriptOf('FACTORY_FAKE_STEWARD_SCRIPT').find((entry) => words.includes(entry.match.toLowerCase()))
    return done(
      'factory-steward',
      args,
      scripted?.answer ?? { action: 'none', note: '', reason: 'nothing scripted', decision: null },
    )
  }
  const scripted = scriptOf('FACTORY_FAKE_TRIAGE_SCRIPT').find((entry) => words.includes(entry.match.toLowerCase()))
  return done(
    'factory-triage',
    args,
    scripted?.answer ?? { amend: null, after: [], kind: null, size: null, reason: 'nothing scripted' },
  )
}
