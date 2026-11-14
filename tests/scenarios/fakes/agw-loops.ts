import { appendFileSync, readFileSync } from 'node:fs'
import { done } from './agw-envelope.ts'

interface Scripted {
  /** a phrase of the title or detail, case-insensitive */
  match: string
  answer: unknown
  /** the workflow fails (exit 1) instead of answering */
  fail?: boolean
}

const scriptOf = (env: string): Scripted[] => {
  const path = process.env[env]
  return path ? (JSON.parse(readFileSync(path, 'utf8')) as Scripted[]) : []
}

/**
 * `agw factory-steward`, `agw factory-triage`, `agw factory-queue`, `agw factory-hygiene`, `agw factory-fix-classes` (nothing scripted: every commit is `other`), `agw factory-screen`, `agw factory-errand` (passes unless `FACTORY_FAKE_ERRAND_SCRIPT` says otherwise) and `agw factory-spec-screen` (passes unless `FACTORY_FAKE_SPEC_SCREEN_SCRIPT` says otherwise), input on stdin. A scenario scripts them with JSON files
 * (`FACTORY_FAKE_STEWARD_SCRIPT`, `FACTORY_FAKE_TRIAGE_SCRIPT`, `FACTORY_FAKE_QUEUE_SCRIPT`, `FACTORY_FAKE_HYGIENE_SCRIPT`, `FACTORY_FAKE_FIX_CLASSES_SCRIPT`, `FACTORY_FAKE_SCREEN_SCRIPT`): `[{ "match": "<phrase>", "answer": {…} }]`, the phrase read
 * from the Issue's title, the stall's detail or the signal's words. Nothing scripted answers "I cannot tell" (steward `none`,
 * triage the empty answer). Every call is logged with its stdin.
 */
export async function loopsFake(args: string[]): Promise<number> {
  const stdin = await Bun.stdin.text()
  const log = process.env.FACTORY_FAKE_LOG
  if (log) appendFileSync(log, `${JSON.stringify({ tool: 'agw', args, stdin })}\n`)
  const input = JSON.parse(stdin) as Record<string, unknown>
  const words = JSON.stringify(input).toLowerCase()

  if (args[0] === 'factory' && args[1] === 'digest') {
    // the digest names its project in the request: a script entry matches on it (`"project":"app"`); nothing scripted answers a
    // digest that cites the first Issue the request names
    const scripted = scriptOf('FACTORY_FAKE_DIGEST_SCRIPT').find((entry) => words.includes(entry.match.toLowerCase()))
    if (scripted?.fail) {
      process.stderr.write('fake agw: factory digest scripted to fail\n')
      return 1
    }
    const listed = (name: string): { id: string }[] =>
      Array.isArray(input[name]) ? (input[name] as { id: string }[]) : []
    const first = [...listed('done'), ...listed('working'), ...listed('queued'), ...listed('waiting')]
    return done(
      'factory.digest',
      args,
      scripted?.answer ?? {
        headline: `${String(input.project)}: nothing scripted`,
        shipped: [],
        next: first[0] ? [{ text: 'the first Issue goes on', ids: [first[0].id] }] : [],
        risks: [],
        themes: [],
      },
    )
  }
  if (args[0] === 'factory-steward') {
    const scripted = scriptOf('FACTORY_FAKE_STEWARD_SCRIPT').find((entry) => words.includes(entry.match.toLowerCase()))
    return done(
      'factory-steward',
      args,
      scripted?.answer ?? { action: 'none', note: '', reason: 'nothing scripted', decision: null },
    )
  }
  if (args[0] === 'factory-queue') {
    const scripted = scriptOf('FACTORY_FAKE_QUEUE_SCRIPT').find((entry) => words.includes(entry.match.toLowerCase()))
    return done('factory-queue', args, scripted?.answer ?? { edges: [], order: [], reason: 'nothing scripted' })
  }
  if (args[0] === 'factory-screen') {
    const scripted = scriptOf('FACTORY_FAKE_SCREEN_SCRIPT').find((entry) => words.includes(entry.match.toLowerCase()))
    if (scripted?.fail) {
      process.stderr.write('fake agw: unknown command factory-screen\n')
      return 1
    }
    return done(
      'factory-screen',
      args,
      scripted?.answer ?? {
        verdict: 'leave',
        reason: 'nothing scripted',
        repo: null,
        duplicateOf: null,
        recommendation: null,
      },
    )
  }
  if (args[0] === 'factory-errand') {
    const scripted = scriptOf('FACTORY_FAKE_ERRAND_SCRIPT').find((entry) => words.includes(entry.match.toLowerCase()))
    if (scripted?.fail) {
      process.stderr.write('fake agw: factory-errand scripted to fail\n')
      return 1
    }
    return done(
      'factory-errand',
      args,
      scripted?.answer ?? { verdict: 'pass', reason: 'nothing scripted: it needs a person' },
    )
  }
  if (args[0] === 'factory-spec-screen') {
    const scripted = scriptOf('FACTORY_FAKE_SPEC_SCREEN_SCRIPT').find((entry) =>
      words.includes(entry.match.toLowerCase()),
    )
    if (scripted?.fail) {
      process.stderr.write('fake agw: factory-spec-screen scripted to fail\n')
      return 1
    }
    return done(
      'factory-spec-screen',
      args,
      scripted?.answer ?? { verdict: 'pass', reason: "nothing scripted: it is the owner's to read" },
    )
  }
  if (args[0] === 'factory-fix-classes') {
    const scripted = scriptOf('FACTORY_FAKE_FIX_CLASSES_SCRIPT').find((entry) =>
      words.includes(entry.match.toLowerCase()),
    )
    if (scripted?.fail) {
      process.stderr.write('fake agw: factory-fix-classes scripted to fail\n')
      return 1
    }
    const commits = (input.commits ?? []) as { sha: string }[]
    return done(
      'factory-fix-classes',
      args,
      scripted?.answer ?? {
        answers: commits.map((c) => ({ sha: c.sha, class: 'other', reason: 'nothing scripted' })),
      },
    )
  }
  if (args[0] === 'factory-hygiene') {
    const scripted = scriptOf('FACTORY_FAKE_HYGIENE_SCRIPT').find((entry) => words.includes(entry.match.toLowerCase()))
    if (scripted?.fail) {
      process.stderr.write('fake agw: factory-hygiene scripted to fail\n')
      return 1
    }
    return done('factory-hygiene', args, scripted?.answer ?? { findings: [], read: 0, reason: 'nothing scripted' })
  }
  const scripted = scriptOf('FACTORY_FAKE_TRIAGE_SCRIPT').find((entry) => words.includes(entry.match.toLowerCase()))
  return done(
    'factory-triage',
    args,
    scripted?.answer ?? { amend: null, after: [], kind: null, size: null, reason: 'nothing scripted' },
  )
}
