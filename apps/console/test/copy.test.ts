import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkCopy, findingsIn, openingTags, readings, structureFindings } from '../scripts/copy.ts'
import { needsGuide } from '../src/lib/guide.ts'
import { LANGUAGE } from '../src/lib/language.gen.ts'

const root = join(import.meta.dir, '..')
const rules = (source: string, file = 'src/x.tsx') => findingsIn(file, source).map((f) => f.rule)

test('the Console copy follows the rules', () => {
  expect(checkCopy(root, readFileSync(join(root, 'scripts/copy.allow'), 'utf8'))).toEqual([])
})

test('a card without a hint fails, a card with one passes', () => {
  const bare = `<StatCard icon={TimerIcon} title="Turns" subtitle="This attempt" value="27" />`
  const hinted = `<StatCard icon={TimerIcon} title="Turns" hint="turns" subtitle="This attempt" value="27" />`
  expect(rules(bare)).toEqual(['card:hint'])
  expect(rules(hinted)).toEqual([])
})

test('a card whose props hold braces and arrows is read to its closing bracket', () => {
  const source = `<StatCard title="A" delta={{ value: 1 }} as={(p) => <Link to="/flow" {...p} />} value={x > 1 ? 2 : 3} hint="load" />`
  expect(openingTags(source, 'StatCard')).toHaveLength(1)
  expect(structureFindings('src/x.tsx', source)).toEqual([])
})

test('an empty state needs a line that says why or an action that is the first step', () => {
  expect(rules(`<EmptyState title="Nothing here" />`)).toEqual(['empty:next'])
  expect(rules(`<EmptyState title="Nothing here">Choose a longer window.</EmptyState>`)).toEqual([])
  expect(rules(`<EmptyState title="Nothing here" action={<Button>Retry</Button>} />`)).toEqual([])
})

test('the voice guide bans fail, whole words only', () => {
  expect(rules(`<p>We leverage a robust, seamless flow.</p>`)).toEqual([
    'banned:leverage',
    'banned:robust',
    'banned:seamless',
  ])
  expect(rules(`<p>Oops, something went wrong.</p>`)).toEqual(['banned:oops', 'banned:something went wrong'])
  expect(rules(`<p>Reload the page. Click here to retry.</p>`)).toEqual(['banned:click here'])
  // a longer word is not the banned one
  expect(rules(`<p>The harnessed rows stay.</p>`)).toEqual([])
})

test('two words for one glossary term fail: the screen word is the glossary one', () => {
  expect(rules(`<p>Name the repository it belongs to.</p>`)).toEqual(['drift:repository'])
  expect(rules(`<p>This document has no headings.</p>`)).toEqual(['drift:document'])
  expect(rules(`<p>Loading the item</p>`)).toEqual(['drift:item'])
  expect(rules(`<p>Name the repo it belongs to.</p>`)).toEqual([])
})

test('a label is an action and an error says what to do', () => {
  expect(rules(`<Button>Submit</Button>`)).toEqual(['label:action'])
  expect(rules(`<Button>Send verdict</Button>`)).toEqual([])
  expect(rules(`const text = 'Error'`, 'src/lib/x.ts')).toEqual(['error:next'])
  expect(rules(`const text = 'The server answered 503. Reload the page.'`, 'src/lib/x.ts')).toEqual([])
})

test('class lists and code between tags are not copy', () => {
  const source = `<div className="flex min-w-0 gap-2 text-muted-foreground">{items.map((item) => (<b>x</b>))}</div>`
  expect(readings('src/x.tsx', source).map((r) => r.text)).toEqual([])
})

test('an exception needs a reason and a finding to cover', () => {
  const stale = checkCopy(root, 'src/components/kit/stat-card.tsx banned:robust  # nothing says it\n')
  expect(stale).toEqual([
    'copy.allow:1: src/components/kit/stat-card.tsx banned:robust matches nothing any more; delete it',
  ])
  expect(checkCopy(root, 'src/x.tsx banned:robust\n')[0]).toContain('needs "<path> <rule>  # <reason>"')
})

/** The words of a `## <title>` section's `Word | Means` tables of docs/language.md. */
function sectionWords(markdown: string, title: string): string[] {
  const body = markdown.split(/^## /m).find((part) => part.startsWith(`${title}\n`)) ?? ''
  return [...body.matchAll(/^\| \*\*(.+?)\*\* \|/gm)].map((m) => (m[1] ?? '').toLowerCase())
}

test('a figure on a card says what to do about it', () => {
  const markdown = readFileSync(join(root, '../../docs/language.md'), 'utf8')
  const figures = [...sectionWords(markdown, 'The host'), ...sectionWords(markdown, 'The figures on a card')]
  expect(figures.length).toBeGreaterThan(10)
  for (const word of figures) {
    expect(LANGUAGE[word as keyof typeof LANGUAGE]).toContain('What to do:')
  }
})

test('a definition of more than two sentences links to the guide', () => {
  expect(needsGuide('One. Two.')).toBe(false)
  expect(needsGuide('One. Two. Three')).toBe(false)
  expect(needsGuide('One. Two. Three.')).toBe(true)
  expect(needsGuide(LANGUAGE.attempt)).toBe(false)
  expect(needsGuide(LANGUAGE.load)).toBe(true)
})

test('a card hint that is undefined is no hint', () => {
  expect(rules(`<StatCard title="A" hint={stat.key === 'shipped' ? undefined : WORD[stat.key]} />`)).toEqual([
    'card:hint',
  ])
})

test('the cards of the host, an Issue, a project and Flow hint a word that says what to do', () => {
  const markdown = readFileSync(join(root, '../../docs/language.md'), 'utf8')
  const figures = new Set([...sectionWords(markdown, 'The host'), ...sectionWords(markdown, 'The figures on a card')])
  const files = [
    'src/routes/throughput.tsx',
    'src/components/issue/overview.tsx',
    'src/components/project/overview.tsx',
  ]
  const hints = files.flatMap((file) =>
    openingTags(readFileSync(join(root, file), 'utf8'), 'StatCard').map(({ tag }) => /\shint="([^"]+)"/.exec(tag)?.[1]),
  )
  expect(hints.length).toBeGreaterThan(10)
  for (const hint of hints) expect(figures.has(hint ?? '')).toBe(true)
  const flow = readFileSync(join(root, 'src/routes/flow.tsx'), 'utf8')
  expect(flow).toContain("shipped: 'shipped this week'")
  expect(figures.has('shipped this week')).toBe(true)
})
