import { parseArgs } from 'node:util'
import { newToken, TokenExists, TokensError, tokensFileFrom } from '@software-factory/door/tokens'
import { EXIT, FactoryError, usage } from './exit.ts'
import type { Io } from './operation.ts'
import { type Format, render } from './output.ts'

const USAGE = 'usage: door token new <source> [--rotate] [--format json|plain]'

/**
 * `factory door token new <source> [--rotate]`: offline. Writes a fresh token for the source into the door's tokens file
 * (the one the door checks incoming alerts against, not `FACTORY_DOOR_TOKEN`) and prints it once. `argv` is what follows
 * `door token`.
 */
export function doorTokenVerb(argv: readonly string[], io: Io): number {
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(argv)
  } catch (error) {
    throw usage(`door token: ${error instanceof Error ? error.message : String(error)}`, USAGE)
  }
  const [verb, source, ...extra] = parsed.positionals
  if (verb !== 'new' || !source || extra.length) throw usage(USAGE)
  const format: Format | string = parsed.values.format ?? 'json'
  if (format !== 'json' && format !== 'plain') throw usage(`--format must be json or plain, got: ${format}`)
  try {
    const token = newToken(tokensFileFrom(io.env), source, { rotate: parsed.values.rotate === true })
    io.out(render(format, { source, token }, token))
    return EXIT.ok
  } catch (error) {
    if (error instanceof TokenExists) throw new FactoryError('conflict', error.message)
    if (error instanceof TokensError) throw new FactoryError('general', error.message)
    throw error
  }
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: { rotate: { type: 'boolean' }, format: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
}
