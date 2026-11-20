import { describe, expect, test } from 'bun:test'
import { checkPage, checkSnippet, parsePermalink, REPO_URL, type Tree } from '../guide-links.ts'

const FILE = 'docs/guide/issues.md'

const SOURCE = [
  '/** The refusals, in the order they are looked at. */',
  'export const REFUSALS = [',
  "  'drain',",
  "  'cap',",
  '] as const',
  '',
  'export function check(input: { held: boolean }): string | null {',
  '  if (input.held) {',
  "    return 'held'",
  '  }',
  '  // a long stretch of rules',
  '  const a = 1',
  '  const b = 2',
  "  return 'free'",
  '}',
  '',
  'export function other(): number {',
  '  return 1',
  '}',
  '',
].join('\n')

/** The tree holds a 40-line table.ts, a source with two symbols and an apps/ directory. */
const tree: Tree = {
  lines: (path) => {
    if (path === 'apps/server/src/domains/work/table.ts') return 40
    if (path === 'apps') return 0
    if (path === 'src/rules.ts') return SOURCE.split('\n').length - 1
    return null
  },
  text: (path) => (path === 'src/rules.ts' ? SOURCE : null),
}
const exists = (path: string) => ['docs/guide/leads.md', 'docs/guide/diagrams/loop.svg'].includes(path)
const check = (body: string) => checkPage(FILE, `# Issues\n\n${body}\n`, tree, exists).map((f) => f.message)
const snippet = (symbol: string, code: string) => `<!-- snippet: src/rules.ts ${symbol} -->\n\`\`\`ts\n${code}\n\`\`\``

describe('parsePermalink', () => {
  test('a master blob with a line range', () => {
    expect(parsePermalink(`${REPO_URL}/blob/master/scripts/x.ts#L3-L9`)).toEqual({
      path: 'scripts/x.ts',
      from: 3,
      to: 9,
    })
  })
  test('one line, and a tree', () => {
    expect(parsePermalink(`${REPO_URL}/blob/master/a.ts#L7`)).toEqual({ path: 'a.ts', from: 7, to: 7 })
    expect(parsePermalink(`${REPO_URL}/tree/master/apps`)).toEqual({ path: 'apps' })
  })
  test('a commit is unpinned from master, another URL is not a permalink', () => {
    expect(parsePermalink(`${REPO_URL}/blob/a36e5f0105b71add9c685cb4838b0baa7e46e1a8/a.ts`)).toBe('unpinned')
    expect(parsePermalink(`${REPO_URL}/issues`)).toBeNull()
    expect(parsePermalink('https://github.com/sairyss/domain-driven-hexagon')).toBeNull()
  })
})

describe('checkPage', () => {
  test('a clean page has no finding', () => {
    const body = [
      'See [Leads](./leads.md#the-brief) and ![the loop](./diagrams/loop.svg).',
      `The [table](${REPO_URL}/blob/master/apps/server/src/domains/work/table.ts#L10-L40), the [apps](${REPO_URL}/tree/master/apps).`,
      '> [!NOTE]',
      '> A GitHub alert.',
      '[a section](#issues), [elsewhere](https://example.com/x)',
    ].join('\n')
    expect(check(body)).toEqual([])
  })

  test('frontmatter, a missing H1, a container and a component are refused', () => {
    const findings = checkPage(FILE, '---\ntitle: X\n---\n\n::: tip\nx\n:::\n\n<Badge text="x" />\n', tree, exists)
    const messages = findings.map((f) => f.message).join('\n')
    expect(messages).toContain('frontmatter')
    expect(messages).toContain('# H1')
    expect(messages).toContain('`:::` container')
    expect(messages).toContain('component tag')
  })

  test('a root-absolute link, a missing file and a path out of the guide are refused', () => {
    expect(check('[a](/issues)')[0]).toContain('root-absolute')
    expect(check('[a](./capacity.md)')[0]).toContain('no such file')
    expect(check('[a](../../apps/server/src/main.ts)')[0]).toContain('link into master')
  })

  test('a link into the repo points at master, holds the path and the lines', () => {
    expect(check(`[a](${REPO_URL}/blob/a36e5f0105b71add9c685cb4838b0baa7e46e1a8/README.md)`)[0]).toContain(
      'link master',
    )
    expect(check(`[a](${REPO_URL}/blob/master/gone.ts)`)[0]).toContain('does not exist')
    expect(check(`[a](${REPO_URL}/blob/master/apps/server/src/domains/work/table.ts#L30-L41)`)[0]).toContain('outside')
  })

  test('links inside fenced and inline code are not links', () => {
    expect(check('```md\n[a](/root)\n::: tip\n```\n`[b](/root)`')).toEqual([])
  })

  test('a ts block needs its snippet line, other languages do not', () => {
    expect(check('```ts\nconst a = 1\n```')[0]).toContain('<!-- snippet:')
    expect(check('```json\n{ "a": 1 }\n```')).toEqual([])
  })

  test('a snippet equal to the code passes, an edited one names the line that differs', () => {
    expect(check(snippet('REFUSALS', "export const REFUSALS = [\n  'drain',\n  'cap',\n] as const"))).toEqual([])
    const edited = check(snippet('REFUSALS', "export const REFUSALS = [\n  'drain',\n  'disk',\n  'cap',\n] as const"))
    expect(edited[0]).toContain("line 3 of the block, `'disk',`, is `'cap',`")
  })
})

describe('checkSnippet', () => {
  const run = (symbol: string, code: string) => checkSnippet(tree, 'src/rules.ts', symbol, code.split('\n'))

  test('indentation is a nesting, not a difference', () => {
    expect(run('check', "    return 'held'")).toBeNull()
    expect(run('check', "if (input.held) {\n  return 'held'\n}")).toBeNull()
  })

  test('a comment above a symbol belongs to it', () => {
    expect(run('REFUSALS', '/** The refusals, in the order they are looked at. */')).toBeNull()
  })

  test('a line `// …` stands for code left out, in order', () => {
    expect(
      run('check', "export function check(input: { held: boolean }): string | null {\n// …\n  return 'free'"),
    ).toBeNull()
    expect(
      run('check', "  return 'free'\n// …\nexport function check(input: { held: boolean }): string | null {"),
    ).toContain('is not there')
  })

  test('the code must lie inside the symbol, the symbol and the file must exist', () => {
    expect(run('other', "  return 'free'")).toContain('is not there')
    expect(run('missing', 'x')).toContain('does not appear')
    expect(checkSnippet(tree, 'gone.ts', 'x', ['x'])).toContain('is not a file')
  })
})
