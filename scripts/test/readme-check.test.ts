import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkReadme, countOf, type Facts, readFacts, ROOT } from '../readme-check.ts'

const README = readFileSync(join(ROOT, 'README.md'), 'utf8')
const facts = readFacts(ROOT)
const exists = (path: string) => existsSync(join(ROOT, path))

const withFacts = (change: Partial<Facts>): Facts => ({ ...facts, ...change })

describe('the README of this checkout', () => {
  test('agrees with the code', () => {
    expect(checkReadme(README, facts, exists)).toEqual([])
  })

  test('the facts are read from the code, not empty', () => {
    expect(facts.eventKinds.length).toBeGreaterThan(20)
    expect(facts.callers).toContain('signal')
    expect(facts.tokens).toContain('FACTORY_SIGNAL_TOKEN')
    expect(facts.screens).toContain('Needs you')
    expect(facts.domains.length).toBe(8)
    expect(facts.consolePort).toBe(7795)
    expect(facts.consoleWrites).toBe(13)
  })
})

describe('drift the check catches', () => {
  test('an event kind added without the README changing', () => {
    const problems = checkReadme(README, withFacts({ eventKinds: [...facts.eventKinds, 'a_new_kind'] }), exists)
    expect(problems.join('\n')).toContain(
      `the event kinds says ${facts.eventKinds.length}, the code has ${facts.eventKinds.length + 1}`,
    )
  })

  test('a caller, a token, a screen or a state the README does not name', () => {
    expect(checkReadme(README, withFacts({ callers: [...facts.callers, 'newcomer'] }), exists).join('\n')).toContain(
      'missing newcomer',
    )
    expect(
      checkReadme(README, withFacts({ tokens: [...facts.tokens, 'FACTORY_NEW_TOKEN'] }), exists).join('\n'),
    ).toContain('missing FACTORY_NEW_TOKEN')
    expect(checkReadme(README, withFacts({ screens: [...facts.screens, 'Cockpit'] }), exists).join('\n')).toContain(
      'omits the screen Cockpit',
    )
    expect(checkReadme(README, withFacts({ states: [...facts.states, 'sleeping'] }), exists).join('\n')).toContain(
      'missing sleeping',
    )
  })

  test('a domain, the port and the writes', () => {
    expect(checkReadme(README, withFacts({ domains: [...facts.domains, 'billing'] }), exists).join('\n')).toContain(
      'the domains says 8, the code has 9',
    )
    expect(checkReadme(README, withFacts({ consolePort: 7801 }), exists).join('\n')).toContain('the code has 7801')
    expect(checkReadme(README, withFacts({ consoleWrites: 14 }), exists).join('\n')).toContain(
      'the Console writes says 13, the code has 14',
    )
  })

  test('an event the README names that no longer exists, and a missing image', () => {
    expect(
      checkReadme(README, withFacts({ eventKinds: facts.eventKinds.filter((k) => k !== 'filed') }), exists).join('\n'),
    ).toContain('`filed`')
    expect(checkReadme(README, facts, () => false).join('\n')).toContain('does not exist')
  })

  test('a statement deleted from the README fails, so the check cannot go quiet', () => {
    expect(checkReadme(README.replace(/\*\*\d+ kinds\*\*/, 'many kinds'), facts, exists).join('\n')).toContain(
      'no statement of event kinds',
    )
    expect(
      checkReadme(README.replace(/forwards\s+thirteen\s+write\s+verbs/, 'forwards writes'), facts, exists).join('\n'),
    ).toContain('no statement of the Console writes')
  })
})

test('counts are read as digits or number words', () => {
  expect(countOf('23')).toBe(23)
  expect(countOf('Eight')).toBe(8)
  expect(countOf('many')).toBeUndefined()
})
