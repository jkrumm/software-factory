import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { definitions, render } from '../scripts/language.ts'
import { LANGUAGE } from '../src/lib/language.gen.ts'

const root = join(import.meta.dir, '..')

test('the words an InfoHint carries are defined', () => {
  for (const word of ['errand', 'decision', 'judge', 'settling', 'watching'] as const) {
    expect(LANGUAGE[word].length).toBeGreaterThan(10)
  }
  expect(LANGUAGE.errand).toContain('owner')
  expect(LANGUAGE.settling).toBe('State: triage is not done')
})

test('definitions are plain text', () => {
  for (const means of Object.values(LANGUAGE)) expect(means).not.toMatch(/[`*]|\|/)
})

test('the committed file is what the generator writes from docs/language.md', () => {
  const next = render(definitions(readFileSync(join(root, '../../docs/language.md'), 'utf8')))
  expect(readFileSync(join(root, 'src/lib/language.gen.ts'), 'utf8')).toBe(next)
})

test('a row with several words, or a slash, keys each', () => {
  const found = definitions(
    '| Word | Means | Retires |\n|-|-|-|\n| **Alpha** / **Beta** | Both. | |\n| Gamma | Plain. | |\n',
  )
  expect([...found]).toEqual([
    ['alpha', 'Both.'],
    ['beta', 'Both.'],
    ['gamma', 'Plain.'],
  ])
})
