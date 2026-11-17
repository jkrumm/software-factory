import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ALLOW_FILE, checkVocabulary, findingsIn, parseExceptions, ROOT, STATE_WORDS, SURFACES } from '../vocabulary.ts'

let root: string | undefined

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function check(files: Record<string, string>, allow = '') {
  root = await mkdtemp('/tmp/factory-vocab-')
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), text)
  }
  return checkVocabulary(root, allow, ['src'])
}

describe('what counts as text a person reads', () => {
  test('a stored state as a lone lower-case value is data', () => {
    const source = `const s = 'queued'\nconst key = "working"\nroute({ state: 'waiting' })\nconst t = \`watching\``
    expect(findingsIn('a.ts', source)).toEqual([])
  })

  test('a sentence or a capitalised word with a state word in it is text', () => {
    const source = `const a = 'Queued'\nconst b = 'nothing is working now'\nconst c = \`\${n} waiting\`\nconst d = "Watching 3"`
    expect(findingsIn('a.ts', source).map((f) => [f.line, f.word])).toEqual([
      [1, 'queued'],
      [2, 'working'],
      [3, 'waiting'],
      [4, 'watching'],
    ])
  })

  test('JSX text is read, an attribute value and a comment are only read as a literal or not at all', () => {
    const source = `// a queued comment\nconst x = <p title="state=queued">Settling now</p>\n/* waiting */`
    expect(findingsIn('a.tsx', source).map((f) => [f.line, f.word])).toEqual([[2, 'settling']])
  })

  test('the five words of the language are not state words', () => {
    expect(findingsIn('a.tsx', `<p>Running, Paused, Ready, Held and Checking</p>`)).toEqual([])
    expect([...STATE_WORDS].sort()).toEqual(['queued', 'settling', 'waiting', 'watching', 'working'])
  })
})

describe('the allow file', () => {
  test('an exception names its reason and its word', () => {
    expect(parseExceptions('src/a.ts working  # a session state\n').exceptions).toHaveLength(1)
    expect(parseExceptions('src/a.ts working\n').problems).toHaveLength(1)
    expect(parseExceptions('src/a.ts running  # not a state word\n').problems).toHaveLength(1)
  })

  test('a finding is reported, an exception silences it, and an unused exception fails', async () => {
    const files = { 'src/a.ts': `export const s = 'Waiting for you'\n` }
    expect(await check(files)).toHaveLength(1)
    expect(await check(files, 'src/a.ts waiting  # a session word')).toEqual([])
    expect(await check({ 'src/a.ts': `export const s = 'Paused'\n` }, 'src/a.ts waiting  # stale')).toHaveLength(1)
  })

  test('a generated file and a test are not read', async () => {
    expect(
      await check({ 'src/language.gen.ts': `export const s = 'Waiting for you'\n`, 'src/a.test.ts': `'Queued here'` }),
    ).toEqual([])
  })
})

test('the surfaces of this repository name no stored state as a word', async () => {
  expect(await checkVocabulary(ROOT, await readFile(ALLOW_FILE, 'utf8'))).toEqual([])
  expect(SURFACES.length).toBeGreaterThan(0)
})
