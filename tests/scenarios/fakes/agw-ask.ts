import { appendFileSync, readFileSync } from 'node:fs'

/**
 * `agw factory-ask --format json --idempotency-key <key>`, input on stdin. A scenario scripts it with a JSON file
 * (`FACTORY_FAKE_ASK_SCRIPT`): `[{ "match": "<phrase of the question>", "verdict": { verdict, answer, reason, source } }]`.
 * A question nothing matches is passed to the owner. Every call is logged with its stdin, so a scenario can read what
 * the Judge was given (the precedents among it).
 */
export async function askFake(args: string[]): Promise<number> {
  const stdin = await Bun.stdin.text()
  const log = process.env.FACTORY_FAKE_LOG
  if (log) appendFileSync(log, `${JSON.stringify({ tool: 'agw', args, stdin })}\n`)

  const input = JSON.parse(stdin) as { question?: string }
  const question = (input.question ?? '').toLowerCase()
  const path = process.env.FACTORY_FAKE_ASK_SCRIPT
  const script = path
    ? (JSON.parse(readFileSync(path, 'utf8')) as { match: string; verdict: Record<string, string> }[])
    : []
  const scripted = script.find((entry) => question.includes(entry.match.toLowerCase()))
  const verdict = scripted?.verdict ?? {
    verdict: 'owner',
    answer: '',
    reason: 'nothing scripted: a taste question',
    source: '',
  }
  process.stdout.write(`${JSON.stringify(verdict)}\n`)
  return 0
}
