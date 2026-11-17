import { describe, expect, test } from 'bun:test'
import { checkPage, type Git, parsePermalink, REPO_URL } from '../guide-links.ts'

const SHA = 'a36e5f0105b71add9c685cb4838b0baa7e46e1a8'
const OTHER = '5722d2a94329631f30fd75a63dd0250d2feae7b1'
const FILE = 'docs/guide/issues.md'

/** master holds SHA with a 40-line table.ts and an apps/ directory; OTHER is a branch commit that never landed. */
const git: Git = {
  onMaster: (sha) => sha === SHA,
  lines: (sha, path) => {
    if (sha !== SHA) return null
    if (path === 'apps/server/src/domains/work/table.ts') return 40
    if (path === 'apps') return 0
    return null
  },
}
const exists = (path: string) => ['docs/guide/leads.md', 'docs/guide/diagrams/loop.svg'].includes(path)
const check = (body: string) => checkPage(FILE, `# Issues\n\n${body}\n`, git, exists).map((f) => f.message)

describe('parsePermalink', () => {
  test('a pinned blob with a line range', () => {
    expect(parsePermalink(`${REPO_URL}/blob/${SHA}/scripts/x.ts#L3-L9`)).toEqual({
      sha: SHA,
      path: 'scripts/x.ts',
      from: 3,
      to: 9,
    })
  })
  test('one line, and a tree', () => {
    expect(parsePermalink(`${REPO_URL}/blob/${SHA}/a.ts#L7`)).toEqual({ sha: SHA, path: 'a.ts', from: 7, to: 7 })
    expect(parsePermalink(`${REPO_URL}/tree/${SHA}/apps`)).toEqual({ sha: SHA, path: 'apps' })
  })
  test('a branch is unpinned, another URL is not a permalink', () => {
    expect(parsePermalink(`${REPO_URL}/blob/master/a.ts`)).toBe('unpinned')
    expect(parsePermalink(`${REPO_URL}/issues`)).toBeNull()
    expect(parsePermalink('https://github.com/sairyss/domain-driven-hexagon')).toBeNull()
  })
})

describe('checkPage', () => {
  test('a clean page has no finding', () => {
    const body = [
      'See [Leads](./leads.md#the-brief) and ![the loop](./diagrams/loop.svg).',
      `The [table](${REPO_URL}/blob/${SHA}/apps/server/src/domains/work/table.ts#L10-L40), the [apps](${REPO_URL}/tree/${SHA}/apps).`,
      '> [!NOTE]',
      '> A GitHub alert.',
      '[a section](#issues), [elsewhere](https://example.com/x)',
    ].join('\n')
    expect(check(body)).toEqual([])
  })

  test('frontmatter, a missing H1, a container and a component are refused', () => {
    const findings = checkPage(FILE, '---\ntitle: X\n---\n\n::: tip\nx\n:::\n\n<Badge text="x" />\n', git, exists)
    const messages = findings.map((f) => f.message).join('\n')
    expect(messages).toContain('frontmatter')
    expect(messages).toContain('# H1')
    expect(messages).toContain('`:::` container')
    expect(messages).toContain('component tag')
  })

  test('a root-absolute link, a missing file and a path out of the guide are refused', () => {
    expect(check('[a](/issues)')[0]).toContain('root-absolute')
    expect(check('[a](./capacity.md)')[0]).toContain('no such file')
    expect(check('[a](../../apps/server/src/main.ts)')[0]).toContain('permalink')
  })

  test('a permalink must be pinned, on master, hold the path and the lines', () => {
    expect(check(`[a](${REPO_URL}/blob/master/README.md)`)[0]).toContain('pin it')
    expect(check(`[a](${REPO_URL}/blob/${OTHER}/README.md)`)[0]).toContain('not on master')
    expect(check(`[a](${REPO_URL}/blob/${SHA}/gone.ts)`)[0]).toContain('does not exist')
    expect(check(`[a](${REPO_URL}/blob/${SHA}/apps/server/src/domains/work/table.ts#L30-L41)`)[0]).toContain(
      'outside',
    )
  })

  test('links inside fenced and inline code are not links', () => {
    expect(check('```md\n[a](/root)\n::: tip\n```\n`[b](/root)`')).toEqual([])
  })
})
