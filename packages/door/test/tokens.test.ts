import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadTokens, newToken, TokenExists, TokensError, tokensFileFrom } from '../src/tokens.ts'

const dir = mkdtempSync('/tmp/factory-door-tokens-')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let n = 0
const file = (content: string, mode = 0o600): string => {
  const path = join(dir, `tokens-${n++}.json`)
  writeFileSync(path, content)
  chmodSync(path, mode)
  return path
}
const TOKEN = 'a'.repeat(43)

describe('loadTokens', () => {
  test('reads one token per source', () => {
    expect(loadTokens(file(JSON.stringify({ kuma: TOKEN, hyperdx: TOKEN })))).toEqual({ kuma: TOKEN, hyperdx: TOKEN })
  })

  test('a file that others or the group can read is refused, and the message names no token', () => {
    for (const mode of [0o644, 0o640, 0o604, 0o666]) {
      const path = file(JSON.stringify({ kuma: TOKEN }), mode)
      const error = (() => {
        try {
          loadTokens(path)
        } catch (e) {
          return e as Error
        }
      })()
      expect(error).toBeInstanceOf(TokensError)
      expect(error?.message).toContain('chmod 600')
      expect(error?.message).not.toContain(TOKEN)
    }
  })

  test('mode 0400 is stricter than asked and passes', () => {
    expect(loadTokens(file(JSON.stringify({ kuma: TOKEN }), 0o400))).toEqual({ kuma: TOKEN })
  })

  test('a file that does not parse is refused', () => {
    expect(() => loadTokens(file('{ nope'))).toThrow('not valid JSON')
    expect(() => loadTokens(file('[]'))).toThrow('does not parse')
    expect(() => loadTokens(file(JSON.stringify({ kuma: 7 })))).toThrow('does not parse')
    expect(() => loadTokens(file(JSON.stringify({ kuma: 'short' })))).toThrow('does not parse')
    expect(() => loadTokens(file(JSON.stringify({ 'Not A Source': TOKEN })))).toThrow('does not parse')
  })

  test('a missing file and an empty one are refused with what to do', () => {
    expect(() => loadTokens(join(dir, 'missing.json'))).toThrow('factory door token new')
    expect(() => loadTokens(file('{}'))).toThrow('holds no token')
  })
})

describe('newToken', () => {
  test('creates the file 0600 in its own directory, with 32 random bytes as base64url', () => {
    const path = join(dir, 'fresh', 'door-tokens.json')
    const token = newToken(path, 'kuma')
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'fresh')).mode & 0o777).toBe(0o700)
    expect(loadTokens(path)).toEqual({ kuma: token })
  })

  test('adds a source beside the others; a second token is another one', () => {
    const path = file(JSON.stringify({ kuma: TOKEN }))
    const hyperdx = newToken(path, 'hyperdx')
    expect(loadTokens(path)).toEqual({ kuma: TOKEN, hyperdx })
    expect(newToken(file('{}'), 'hyperdx')).not.toBe(hyperdx)
  })

  test('a source that has a token keeps it unless --rotate says so', () => {
    const path = file(JSON.stringify({ kuma: TOKEN }))
    expect(() => newToken(path, 'kuma')).toThrow(TokenExists)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ kuma: TOKEN })
    const rotated = newToken(path, 'kuma', { rotate: true })
    expect(rotated).not.toBe(TOKEN)
    expect(loadTokens(path)).toEqual({ kuma: rotated })
  })

  test('writes nothing over a file with loose mode, or a name that is no source', () => {
    const loose = file(JSON.stringify({ kuma: TOKEN }), 0o644)
    expect(() => newToken(loose, 'hyperdx')).toThrow(TokensError)
    expect(() => newToken(file('{}'), '../etc')).toThrow('not a source name')
  })
})

describe('tokensFileFrom', () => {
  test('the variable, else the owner config directory', () => {
    expect(tokensFileFrom({ FACTORY_DOOR_TOKENS_FILE: '/x/t.json', HOME: '/h' })).toBe('/x/t.json')
    expect(tokensFileFrom({ HOME: '/h' })).toBe('/h/.config/factory/door-tokens.json')
    expect(() => tokensFileFrom({})).toThrow(TokensError)
  })
})
