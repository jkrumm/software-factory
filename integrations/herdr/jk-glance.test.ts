import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The mod imports gpui and herdr, so it cannot load here. Its pure helpers sit between `// <glance>` and `// </glance>`
// with no imports; this runs the block on its own.
const src = readFileSync(join(import.meta.dir, 'jk-glance/main.js'), 'utf8')
const block = /\/\/ <glance>[^\n]*\n([\s\S]*?)\/\/ <\/glance>/.exec(src)?.[1]
if (!block) throw new Error('jk-glance: no <glance> block')
const lib = new Function(
  `${block}; return { parseNeeds, parseOverview, parsePoll, terminalsMap, needsTotal, newestItem, needsLabel, runningLabel, consoleLink, issueLink }`,
)() as any

const needs = (counts: object, items: object[] = []) => JSON.stringify({ at: 1, items, counts })

test('parseNeeds: valid, invalid, empty', () => {
  const n = lib.parseNeeds(
    needs({ decision: 1, review: 2, errand: 0, held_signal: 0 }, [{ id: 'a', title: 'T', ageMs: 5 }]),
  )
  expect(n.counts).toEqual({ decision: 1, review: 2, errand: 0, held_signal: 0 })
  expect(lib.needsTotal(n)).toBe(3)
  expect(lib.parseNeeds('')).toBeNull()
  expect(lib.parseNeeds('not json')).toBeNull()
  expect(lib.parseNeeds('{}')).toBeNull()
  expect(lib.parseNeeds(null)).toBeNull()
  expect(lib.needsTotal(lib.parseNeeds(needs({})))).toBe(0)
})

test('parseOverview: valid, invalid, empty', () => {
  expect(lib.parseOverview('{"counts":{"working":2,"waiting":1,"queued":3,"asks":9}}')).toEqual({
    working: 2,
    waiting: 1,
    queued: 3,
  })
  expect(lib.parseOverview('{"counts":{}}')).toEqual({ working: 0, waiting: 0, queued: 0 })
  expect(lib.parseOverview('')).toBeNull()
  expect(lib.parseOverview('nope')).toBeNull()
  expect(lib.parseOverview('{}')).toBeNull()
})

test('parsePoll: parts parse on their own', () => {
  const issues = '{"issues":[{"id":362,"title":"T"},{"id":"x"}]}'
  const sessions = '{"sessions":[{"id":"lead-362-1","issue":362},{"id":5}]}'
  const out = `${needs({ decision: 1 })}\n@@\nbroken\n@@\n${issues}\n@@\n${sessions}\n@@\nhttps://c.example.com/\n`
  const p = lib.parsePoll(out)
  expect(p.needs).not.toBeNull()
  expect(p.overview).toBeNull()
  expect(p.issues).toEqual([{ id: 362, title: 'T' }])
  expect(p.sessions).toEqual([{ id: 'lead-362-1', issue: 362 }])
  expect(p.base).toBe('https://c.example.com/')
  const bad = lib.parsePoll(`${needs({})}\n@@\n{}\n@@\nnope\n@@\n{}\n@@\nhttps://c.example.com/\n`)
  expect(bad.issues).toBeNull()
  expect(bad.sessions).toBeNull()
  expect(lib.parsePoll('').base).toBeNull()
  expect(lib.parsePoll(`${needs({})}\n@@\n{}\n@@\n`).base).toBeNull()
})

test('terminalsMap: session with terminal + Issue, no terminal, unparseable', () => {
  const issues = [
    { id: 362, filedTitle: 'Filed', title: 'Short', summary: 'Sum', state: 'working', repoName: 'dotfiles' },
  ]
  const sessions = [
    {
      id: 'lead-362-1',
      issue: 362,
      role: 'lead',
      state: 'idle',
      repo: '/x/dotfiles/.claude/worktrees/f',
      terminal: { id: 't1hd' },
    },
    { id: 'no-term', issue: 362, role: 'worker' },
    { id: 'bad-addr', issue: 362, terminal: { id: 'T 1;' } },
  ]
  const base = 'https://c.example.com'
  expect(lib.terminalsMap(issues, sessions, null, base)).toEqual({
    'mini/t1hd': {
      title: 'Short',
      summary: 'Sum',
      state: 'working',
      repo: 'dotfiles',
      link: 'https://c.example.com/flow',
    },
  })
  const bare = lib.terminalsMap(
    [],
    [{ id: 's', title: 'S', state: 'idle', repo: '/x/proj/.claude/worktrees/w', terminal: { id: 't2' } }],
    null,
    base,
  )
  expect(bare['mini/t2']).toEqual({ title: 'S', summary: null, state: 'idle', repo: 'proj', link: null })
  expect(lib.terminalsMap(null, null, null, null)).toEqual({})
  // no id, role or phase reaches the screen
  const keys = Object.keys(lib.terminalsMap(issues, sessions, null, base)['mini/t1hd'])
  expect(keys).not.toContain('issue')
  expect(keys).not.toContain('role')
  expect(keys).not.toContain('phase')
})

test("issueLink: the Issue's newest Needs you item, else the flow, else nothing", () => {
  const n = lib.parseNeeds(
    needs({ decision: 2 }, [
      { id: 'old', issue: 'issue_7', ageMs: 90 },
      { id: 'new', issue: 'issue_7', ageMs: 10 },
      { id: 'other', issue: 'issue_8', ageMs: 1 },
    ]),
  )
  expect(lib.issueLink('https://c.example.com/', 7, n)).toBe('https://c.example.com/needs-you?item=new')
  expect(lib.issueLink('https://c.example.com/', 9, n)).toBe('https://c.example.com/flow')
  expect(lib.issueLink('https://c.example.com/', 7, null)).toBe('https://c.example.com/flow')
  expect(lib.issueLink('', 7, n)).toBeNull()
})

test('newestItem picks the smallest ageMs', () => {
  const n = lib.parseNeeds(
    needs({ decision: 2 }, [
      { id: 'old', ageMs: 90 },
      { id: 'new', ageMs: 10 },
    ]),
  )
  expect(lib.newestItem(n).id).toBe('new')
  expect(lib.newestItem(lib.parseNeeds(needs({})))).toBeNull()
})

test('labels for 0, 1 and many needs; running', () => {
  expect(lib.needsLabel(lib.parseNeeds(needs({})))).toBe('Nothing waits on you')
  expect(lib.needsLabel(null)).toBe('Nothing waits on you')
  expect(lib.needsLabel(lib.parseNeeds(needs({ decision: 1 })))).toBe('Needs you · 1')
  expect(lib.needsLabel(lib.parseNeeds(needs({ decision: 2, review: 3, errand: 1, held_signal: 1 })))).toBe(
    'Needs you · 7',
  )
  expect(lib.runningLabel({ working: 2, waiting: 0, queued: 4 })).toBe('Running · 2 working · 4 queued')
  expect(lib.runningLabel({ working: 1, waiting: 3, queued: 0 })).toBe('Running · 1 working · 0 queued · 3 waiting')
  expect(lib.runningLabel(null)).toBe('Running · 0 working · 0 queued')
})

test('consoleLink', () => {
  expect(lib.consoleLink('https://c.example.com///', 'needs', null)).toBe('https://c.example.com/needs-you')
  expect(lib.consoleLink('http://c.example.com', 'needs', { id: 'a b/c?d' })).toBe(
    'http://c.example.com/needs-you?item=a%20b%2Fc%3Fd',
  )
  expect(lib.consoleLink('https://c.example.com/', 'flow', { id: 'x' })).toBe('https://c.example.com/flow')
  expect(lib.consoleLink('', 'needs', null)).toBeNull()
  expect(lib.consoleLink(null, 'flow', null)).toBeNull()
  expect(lib.consoleLink('javascript:alert(1)', 'needs', null)).toBeNull()
  expect(lib.consoleLink('file:///etc/passwd', 'flow', null)).toBeNull()
  expect(lib.consoleLink('ftp://c.example.com', 'needs', null)).toBeNull()
})

test('terminalsMap: a closed Issue has no entry', () => {
  const out = lib.terminalsMap(
    [{ id: 416, title: 'T', state: 'closed' }],
    [{ id: 'lead-416-1', issue: 416, state: 'idle', terminal: { id: 't1k0' } }],
    null,
    'https://c.example.com',
  )
  expect(out).toEqual({})
})
