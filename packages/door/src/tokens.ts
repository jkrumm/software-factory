import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DoorSource } from '@software-factory/contract'
import { z } from 'zod'

/** A tokens file the door refuses to start on, and the CLI refuses to write over. The message never holds a token. */
export class TokensError extends Error {}

/** The source has a token and was not asked to replace it. */
export class TokenExists extends TokensError {}

export const defaultTokensFile = (home: string): string => `${home}/.config/factory/door-tokens.json`

/** `FACTORY_DOOR_TOKENS_FILE`, else `~/.config/factory/door-tokens.json`. */
export function tokensFileFrom(env: Record<string, string | undefined>): string {
  if (env.FACTORY_DOOR_TOKENS_FILE) return env.FACTORY_DOOR_TOKENS_FILE
  if (!env.HOME) throw new TokensError('no tokens file: set FACTORY_DOOR_TOKENS_FILE or HOME')
  return defaultTokensFile(env.HOME)
}

const MIN_TOKEN_CHARS = 16

const Tokens = z.record(DoorSource, z.string().min(MIN_TOKEN_CHARS).regex(/^\S+$/, 'a token has no whitespace'))

/** One token per source, `{ "kuma": "...", "hyperdx": "..." }`. */
export type Tokens = Record<string, string>

/** Reads the file, or `undefined` when there is none. Looser than 0600 for group or others, or not parsing, is an error. */
function read(path: string): Tokens | undefined {
  if (!existsSync(path)) return undefined
  const stat = statSync(path)
  if (!stat.isFile()) throw new TokensError(`${path} is not a file`)
  if ((stat.mode & 0o177) !== 0) {
    const mode = (stat.mode & 0o777).toString(8).padStart(3, '0')
    throw new TokensError(`${path} has mode ${mode}; only its owner may read it (chmod 600)`)
  }
  let json: unknown
  try {
    json = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new TokensError(`${path} is not valid JSON`)
  }
  const parsed = Tokens.safeParse(json)
  if (!parsed.success) {
    throw new TokensError(`${path} does not parse: ${z.prettifyError(parsed.error).replace(/\s+/g, ' ')}`)
  }
  return parsed.data
}

/** The door's tokens at start. A missing file, a loose mode, a file that does not parse and one with no source all refuse. */
export function loadTokens(path: string): Tokens {
  const tokens = read(path)
  if (!tokens) throw new TokensError(`${path} does not exist; create a token with: factory door token new <source>`)
  if (Object.keys(tokens).length === 0)
    throw new TokensError(`${path} holds no token; create one with: factory door token new <source>`)
  return tokens
}

/**
 * Writes a fresh token (32 random bytes, base64url) for `source` and returns it: the caller prints it once. The file is made
 * 0600 in a 0700 directory, and replaced whole, so the door never reads half of it. A source that has a token keeps it unless
 * `rotate` says the old one is to go.
 */
export function newToken(path: string, source: string, options: { rotate?: boolean } = {}): string {
  const name = DoorSource.safeParse(source)
  if (!name.success) throw new TokensError(`${source} is not a source name (lowercase letters, digits and dashes)`)
  const tokens = read(path) ?? {}
  if (tokens[name.data] && !options.rotate) {
    throw new TokenExists(`${name.data} has a token already; --rotate replaces it (the door must be restarted)`)
  }
  const token = randomBytes(32).toString('base64url')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ ...tokens, [name.data]: token }, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
  return token
}
