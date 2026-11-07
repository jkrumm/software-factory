import { appendFileSync } from 'node:fs'

/**
 * What every fake does with a call nothing has scripted yet: records it in `FACTORY_FAKE_LOG` (one JSON line) and
 * fails out loud, so a package that starts calling the tool sees the fake it has to fill.
 */
export function unscripted(tool: string, args: string[]): number {
  const log = process.env.FACTORY_FAKE_LOG
  if (log) appendFileSync(log, `${JSON.stringify({ tool, args })}\n`)
  process.stderr.write(`fake ${tool}: nothing scripted for: ${args.join(' ')}\n`)
  return 1
}
