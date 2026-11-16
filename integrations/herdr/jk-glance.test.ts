import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The mod imports gpui and herdr, so it cannot load here. Its pure helpers sit between `// <glance>` and `// </glance>`
// with no imports; this runs the block on its own.
const src = readFileSync(join(import.meta.dir, 'jk-glance/main.js'), 'utf8')
const block = /\/\/ <glance>[^\n]*\n([\s\S]*?)\/\/ <\/glance>/.exec(src)?.[1]
if (!block) throw new Error('jk-glance: no <glance> block')
const lib = new Function(
  `${block}; return { parseNeeds, parseOverview, parseFlow, parseMachine, parseLeads, queueReasons, needsRows, leadRows, queueRows, productionRows, hostLine, ageText, parseUptime, parsePoll, terminalsMap, needsTotal, needsCount, newestItem, needsLabel, consoleLink, issueLink, toneOf, deltaText, kpiCells, sparkPoints, pathPercent, barHeights, glanceModel }`,
)() as any

const needs = (counts: object, items: object[] = []) => JSON.stringify({ at: 1, items, counts })

test('parseNeeds: valid, invalid, empty', () => {
  const n = lib.parseNeeds(
    needs({ decision: 1, review: 2, errand: 0, held_signal: 0, long_wait: 0 }, [{ id: 'a', title: 'T', ageMs: 5 }]),
  )
  expect(n.counts).toEqual({ decision: 1, review: 2, errand: 0, held_signal: 0, long_wait: 0 })
  expect(lib.needsTotal(n)).toBe(3)
  expect(lib.parseNeeds('')).toBeNull()
  expect(lib.parseNeeds('not json')).toBeNull()
  expect(lib.parseNeeds('{}')).toBeNull()
  expect(lib.parseNeeds(null)).toBeNull()
  expect(lib.needsTotal(lib.parseNeeds(needs({})))).toBe(0)
})

test('parseOverview: counts, health kinds and uptime; nothing else', () => {
  const o = lib.parseOverview(
    JSON.stringify({
      counts: { working: 2, waiting: 1, queued: 3, asks: 2, humanQueue: 1, health: 2 },
      health: [
        { kind: 'door', short: 'Secret title', text: 'Secret text' },
        { kind: 'account', summary: 'Secret' },
        {},
      ],
      uptime: { up: 67, down: 3, total: 70, downNames: ['kuma/A', '', 5, 'B'] },
      issues: [{ id: 1, title: 'Secret' }],
    }),
  )
  expect(o).toEqual({
    working: 2,
    waiting: 1,
    queued: 3,
    asks: 2,
    humanQueue: 1,
    health: 2,
    healthKinds: ['door', 'account', 'other'],
    uptime: { up: 67, down: 3, total: 70, downNames: ['kuma/A', 'B'] },
    leads: [],
  })
  expect(JSON.stringify(o)).not.toContain('Secret')
  const bare = lib.parseOverview('{"counts":{}}')
  expect(bare).toEqual({
    working: 0,
    waiting: 0,
    queued: 0,
    asks: 0,
    humanQueue: 0,
    health: 0,
    healthKinds: [],
    uptime: null,
    leads: [],
  })
  expect(lib.parseOverview('')).toBeNull()
  expect(lib.parseOverview('nope')).toBeNull()
  expect(lib.parseOverview('{}')).toBeNull()
})

test('parseUptime: valid, partial, invalid, capped', () => {
  expect(lib.parseUptime({ up: 3, down: 0, total: 3, downNames: [] })).toEqual({
    up: 3,
    down: 0,
    total: 3,
    downNames: [],
  })
  expect(lib.parseUptime({ up: 3, down: 'x', total: 3 })).toBeNull()
  expect(lib.parseUptime(null)).toBeNull()
  expect(lib.parseUptime('x')).toBeNull()
  const many = lib.parseUptime({ up: 1, down: 20, total: 21, downNames: Array.from({ length: 20 }, (_, i) => `m${i}`) })
  expect(many.downNames).toHaveLength(10)
  expect(lib.parseUptime({ up: 1, down: 1, total: 2, downNames: ['x'.repeat(200)] }).downNames[0]).toHaveLength(80)
})

const trend = {
  trend: {
    at: [],
    states: {
      settling: [0, 0, 0, 0, 0, 0, 0, 0],
      queued: [10, 1, 0, 1, 51, 14, 2, 19],
      working: [2, 0, 0, 2, 9, 8, 8, 4],
      waiting: [2, 4, 2, 1, 2, 4, 3, 5],
      watching: [1, 0, 0, 2, 0, 0, 0, 1],
    },
    shipped: [108, 84, 119, 43, 127, 117, 89],
    shippedBefore: 71,
  },
  states: { working: { issues: [{ title: 'Secret title', id: 'issue_9' }] } },
  closedRecently: [{ title: 'Secret closed' }],
}

test('parseFlow: the trend as numbers, nothing else', () => {
  const f = lib.parseFlow(JSON.stringify(trend))
  expect(f).toEqual({
    working: [2, 0, 0, 2, 9, 8, 8, 4],
    waiting: [2, 4, 2, 1, 2, 4, 3, 5],
    queued: [10, 1, 0, 1, 51, 14, 2, 19],
    shipped: [108, 84, 119, 43, 127, 117, 89],
    shippedBefore: 71,
    why: [],
    red: [],
  })
  expect(JSON.stringify(f)).not.toContain('Secret')
  expect(lib.parseFlow('')).toBeNull()
  expect(lib.parseFlow('nope')).toBeNull()
  expect(lib.parseFlow('{}')).toBeNull()
  expect(lib.parseFlow('{"trend":{"states":{}}}')).toBeNull()
  // a part that does not parse is null, the others stay
  const partial = lib.parseFlow('{"trend":{"states":{"working":[1,2],"waiting":"x"},"shipped":[],"shippedBefore":"z"}}')
  expect(partial).toEqual({
    working: [1, 2],
    waiting: null,
    queued: null,
    shipped: null,
    shippedBefore: null,
    why: [],
    red: [],
  })
  // NaN and negatives are zero
  expect(lib.parseFlow('{"trend":{"states":{"working":[1,-3,null,4]}}}').working).toEqual([1, 0, 0, 4])
  expect(lib.parseFlow('{"trend":{"states":{"working":[7]}}}')).toBeNull()
})

test('toneOf and deltaText follow the Console: direction times higher-is-better', () => {
  expect(lib.toneOf(3, true)).toBe('good')
  expect(lib.toneOf(3, false)).toBe('bad')
  expect(lib.toneOf(-2, true)).toBe('bad')
  expect(lib.toneOf(-2, false)).toBe('good')
  expect(lib.toneOf(0, true)).toBe('neutral')
  expect(lib.toneOf(null, true)).toBe('neutral')
  expect(lib.toneOf(Number.NaN, false)).toBe('neutral')
  expect(lib.deltaText(3)).toBe('▲ +3')
  expect(lib.deltaText(-2)).toBe('▼ −2')
  expect(lib.deltaText(0)).toBe('– 0')
  expect(lib.deltaText(null)).toBe('')
})

test('kpiCells: the Flow page figures', () => {
  const o = lib.parseOverview('{"counts":{"working":4,"waiting":5,"queued":19}}')
  const cells = lib.kpiCells(o, lib.parseFlow(JSON.stringify(trend)))
  const by = Object.fromEntries(cells.map((c: any) => [c.key, c]))
  expect(cells.map((c: any) => c.label)).toEqual(['Working', 'Waiting', 'Queued', 'Shipped this week'])
  expect([by.working.value, by.working.delta, by.working.tone]).toEqual([4, 2, 'good'])
  expect([by.waiting.value, by.waiting.delta, by.waiting.tone]).toEqual([5, 3, 'bad'])
  expect([by.queued.value, by.queued.delta, by.queued.tone]).toEqual([19, 9, 'bad'])
  expect([by.shipped.value, by.shipped.delta, by.shipped.tone]).toEqual([687, 616, 'good'])
  expect(by.shipped.bars).toHaveLength(7)
  expect(by.working.line).toHaveLength(8)
  // no flow: figures from the overview, no change, no series
  const noFlow = lib.kpiCells(o, null)
  expect(noFlow.map((c: any) => c.value)).toEqual([4, 5, 19, null])
  expect(noFlow.every((c: any) => c.delta === null && !c.line && !c.bars)).toBe(true)
  // no overview: figures from the last sample
  const noOverview = lib.kpiCells(null, lib.parseFlow(JSON.stringify(trend)))
  expect(noOverview.map((c: any) => c.value)).toEqual([4, 5, 19, 687])
  expect(lib.kpiCells(null, null).map((c: any) => c.value)).toEqual([null, null, null, null])
})

const inBox = (pts: number[][], w = 48, h = 16) =>
  pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= w && y >= 0 && y <= h)

test('sparkPoints: empty, one point, all zeros, NaN, 200 points', () => {
  expect(lib.sparkPoints([])).toEqual([])
  expect(lib.sparkPoints(null)).toEqual([])
  expect(lib.sparkPoints([5])).toEqual([[24, 8]])
  expect(lib.sparkPoints([0])).toEqual([[24, 14]])
  const zeros = lib.sparkPoints([0, 0, 0, 0])
  expect(zeros).toHaveLength(4)
  expect(new Set(zeros.map((p: number[]) => p[1]))).toEqual(new Set([14]))
  const flat = lib.sparkPoints([3, 3, 3])
  expect(new Set(flat.map((p: number[]) => p[1]))).toEqual(new Set([8]))
  const nan = lib.sparkPoints([1, Number.NaN, 3, Number.POSITIVE_INFINITY, 2])
  expect(nan).toHaveLength(5)
  expect(inBox(nan)).toBe(true)
  const big = lib.sparkPoints(Array.from({ length: 200 }, (_, i) => Math.sin(i) * 50 + i))
  expect(big.length).toBeLessThanOrEqual(48)
  expect(inBox(big)).toBe(true)
  // the range maps to the box: the lowest value at the foot, the highest at the top, x spans the padded width
  const ramp = lib.sparkPoints([0, 5, 10])
  expect(ramp).toEqual([
    [2, 14],
    [24, 8],
    [46, 2],
  ])
  expect(lib.sparkPoints([1, 2, 3, 4, 5, 6, 7, 8]).at(-1)[0]).toBe(46)
})

test('pathPercent: shares of the box', () => {
  expect(lib.pathPercent([[24, 8]])).toEqual([['50%', '50%']])
  expect(lib.pathPercent([[0, 16]])).toEqual([['0%', '100%']])
})

test('barHeights: empty, one, zeros, NaN, 200 values', () => {
  expect(lib.barHeights([])).toEqual([])
  expect(lib.barHeights(null)).toEqual([])
  expect(lib.barHeights([7])).toEqual([16])
  expect(lib.barHeights([0, 0, 0])).toEqual([1, 1, 1])
  expect(lib.barHeights([108, 84, 119, 43, 127, 117, 89])).toEqual([14, 11, 15, 5, 16, 15, 11])
  expect(lib.barHeights([Number.NaN, 4, -2])).toEqual([1, 16, 1])
  expect(lib.barHeights([100, 1])).toEqual([16, 2])
  const big = lib.barHeights(Array.from({ length: 200 }, (_, i) => i))
  expect(big).toHaveLength(14)
  expect(big.every((n: number) => n >= 1 && n <= 16)).toBe(true)
})

test('parsePoll: parts parse on their own', () => {
  const issues = '{"issues":[{"id":362,"title":"T"},{"id":"x"}]}'
  const sessions = '{"sessions":[{"id":"lead-362-1","issue":362},{"id":5}]}'
  const machine = '{"load":3.5,"loadCeiling":36,"memory":{"swapUsedPct":2.6},"memoryCeilings":{"swapUsedPct":75}}'
  const out = `${needs({ decision: 1 })}\n@@\nbroken\n@@\n${issues}\n@@\n${sessions}\n@@\n${machine}\n@@\nhttps://c.example.com/\n`
  const p = lib.parsePoll(out)
  expect(p.needs).not.toBeNull()
  expect(p.overview).toBeNull()
  expect(p.issues).toEqual([{ id: 362, title: 'T' }])
  expect(p.sessions).toEqual([{ id: 'lead-362-1', issue: 362 }])
  expect(p.machine).toEqual({ load: 3.5, loadCeiling: 36, swapPct: 2.6, swapCeiling: 75 })
  expect(p.base).toBe('https://c.example.com/')
  const bad = lib.parsePoll(`${needs({})}\n@@\n{}\n@@\nnope\n@@\n{}\n@@\nx\n@@\nhttps://c.example.com/\n`)
  expect(bad.issues).toBeNull()
  expect(bad.sessions).toBeNull()
  expect(bad.machine).toBeNull()
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

test('needsLabel and needsCount: the overview first, the needs read as the fallback', () => {
  expect(lib.needsLabel(0)).toBe('Nothing waits on you')
  expect(lib.needsLabel(1)).toBe('Needs you · 1')
  expect(lib.needsLabel(9)).toBe('Needs you · 9')
  const o = lib.parseOverview('{"counts":{"asks":3,"humanQueue":2}}')
  const n = lib.parseNeeds(needs({ decision: 1, review: 1 }))
  expect(lib.needsCount(o, n)).toBe(5)
  expect(lib.needsCount(null, n)).toBe(2)
  expect(lib.needsCount(o, null)).toBe(5)
  expect(lib.needsCount(null, null)).toBe(0)
})

test('consoleLink', () => {
  expect(lib.consoleLink('https://c.example.com///', 'needs', null)).toBe('https://c.example.com/needs-you')
  expect(lib.consoleLink('http://c.example.com', 'needs', { id: 'a b/c?d' })).toBe(
    'http://c.example.com/needs-you?item=a%20b%2Fc%3Fd',
  )
  expect(lib.consoleLink('https://c.example.com/', 'flow', { id: 'x' })).toBe('https://c.example.com/flow')
  expect(lib.consoleLink('https://c.example.com', 'health', null)).toBeNull() // the Console has no health page yet
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

test('terminalsMap: the shared feed is byte-identical for a fixture', () => {
  const n = lib.parseNeeds(needs({ decision: 1 }, [{ id: 'it1', issue: 'issue_7', ageMs: 5 }]))
  const issues = [
    { id: 7, title: 'Seven', summary: 'Sum 7', state: 'working', repoName: 'dotfiles' },
    { id: 8, title: 'Eight', state: 'queued' },
    { id: 9, title: 'Closed', state: 'closed' },
  ]
  const sessions = [
    { id: 'a', issue: 7, terminal: { id: 't1' }, repo: '/x/dotfiles/.claude/worktrees/w' },
    { id: 'b', issue: 8, terminal: { id: 't2' }, repo: '/x/software-factory' },
    { id: 'c', issue: 9, terminal: { id: 't3' } },
    { id: 'd', title: 'Loose', summary: 'S', state: 'idle', terminal: { id: 't0z' }, repo: '/x/proj/' },
    { id: 'e', issue: 7, terminal: { id: 'bad addr' } },
  ]
  expect(JSON.stringify(lib.terminalsMap(issues, sessions, n, 'https://c.example.com'))).toBe(
    '{"mini/t0z":{"title":"Loose","summary":"S","state":"idle","repo":"proj","link":null},"mini/t1":{"title":"Seven","summary":"Sum 7","state":"working","repo":"dotfiles","link":"https://c.example.com/needs-you?item=it1"},"mini/t2":{"title":"Eight","summary":null,"state":"queued","repo":"software-factory","link":"https://c.example.com/flow"}}',
  )
})

// -- the view model

const NOW = 1_000_000_000
const base = 'https://c.example.com'
const secretIssues = {
  items: [{ id: 'it1', issue: 'issue_7', title: 'Secret ticket title', summary: 'Secret summary', ageMs: 5 }],
  counts: { decision: 2 },
}
const fullOverview = () =>
  lib.parseOverview(
    JSON.stringify({
      counts: { working: 4, waiting: 5, queued: 19, asks: 2, humanQueue: 1, health: 2 },
      health: [
        { kind: 'door', short: 'Secret health title', text: 'Secret health text' },
        { kind: 'door', summary: 'Secret' },
      ],
      uptime: { up: 67, down: 3, total: 70, downNames: ['Monitor A'] },
      issues: [{ id: 7, title: 'Secret ticket title', summary: 'Secret summary' }],
    }),
  )
const full = () => ({
  needs: lib.parseNeeds(JSON.stringify(secretIssues)),
  overview: fullOverview(),
  flow: lib.parseFlow(JSON.stringify(trend)),
  base,
  at: NOW,
  flowAt: NOW,
  now: NOW + 1000,
})
// Every string the block draws or puts in a tooltip, links left out (a link is never drawn).
const words = (m: any) => JSON.stringify(m, (k, v) => (k === 'link' ? undefined : v))

test('glanceModel: the full block', () => {
  const m = lib.glanceModel(full())
  expect(m.stale).toBe(false)
  expect(m.needs).toMatchObject({ text: 'Needs you · 3', tone: 'bad', link: `${base}/needs-you?item=it1` })
  expect(m.cells.map((c: any) => [c.key, c.value, c.delta, c.tone])).toEqual([
    ['working', '4', '▲ +2', 'good'],
    ['waiting', '5', '▲ +3', 'bad'],
    ['queued', '19', '▲ +9', 'bad'],
    ['shipped', '687', '▲ +616', 'good'],
  ])
  expect(m.cells.every((c: any) => c.link === `${base}/flow`)).toBe(true)
  expect(m.health).toMatchObject({ text: 'Health · 2', tone: 'warn', link: null })
  expect(m.health.uptime).toEqual({ text: 'Uptime · 67/70 up', tone: 'bad', tip: 'Down: Monitor A' })
})

test('glanceModel: no ticket title, summary or id is drawn or in a tooltip', () => {
  const all = words(lib.glanceModel(full()))
  expect(all).not.toContain('Secret')
  expect(all).not.toContain('issue_7')
  expect(all).not.toMatch(/it1/)
  // the same with a stale poll and without a Console URL
  expect(words(lib.glanceModel({ ...full(), now: NOW + 3 * 60000 }))).not.toContain('Secret')
  expect(words(lib.glanceModel({ ...full(), base: '' }))).not.toContain('Secret')
})

test('glanceModel: health tone and uptime', () => {
  const tone = (health: number, kinds: string[], uptime: unknown = null) =>
    lib.glanceModel({
      ...full(),
      overview: lib.parseOverview(
        JSON.stringify({ counts: { health }, health: kinds.map((kind) => ({ kind })), uptime }),
      ),
    }).health
  expect(tone(0, []).tone).toBe('good')
  expect(tone(2, ['door', 'door']).tone).toBe('warn')
  expect(tone(2, ['door', 'account']).tone).toBe('bad')
  expect(tone(1, []).tone).toBe('bad') // a count with no kinds is unknown: red
  expect(tone(0, []).uptime).toBeNull()
  expect(tone(0, [], { up: 70, down: 0, total: 70, downNames: [] }).uptime).toEqual({
    text: 'Uptime · 70/70 up',
    tone: 'dim',
    tip: 'All up',
  })
  expect(tone(0, [], { up: 0, down: 0, total: 0, downNames: [] }).uptime).toBeNull()
})

test('glanceModel: degrades per part', () => {
  // overview only: counts and health, no needs items to select, no trend
  const o = lib.glanceModel({ ...full(), needs: null, flow: null })
  expect(o.needs).toMatchObject({ text: 'Needs you · 3', link: `${base}/needs-you` })
  expect(o.cells.map((c: any) => [c.value, c.delta])).toEqual([
    ['4', ''],
    ['5', ''],
    ['19', ''],
    ['–', ''],
  ])
  expect(o.health.text).toBe('Health · 2')
  // needs only: the count from the needs read, no figures, no health
  const n = lib.glanceModel({ ...full(), overview: null, flow: null })
  expect(n.needs.text).toBe('Needs you · 2')
  expect(n.cells.map((c: any) => c.value)).toEqual(['–', '–', '–', '–'])
  expect(n.health).toMatchObject({ text: 'Health · –', tone: 'dim', uptime: null })
  // the trend alone fills the cells too
  const t = lib.glanceModel({ ...full(), overview: null })
  expect(t.cells.map((c: any) => c.value)).toEqual(['4', '5', '19', '687'])
  // a trend older than 10 min is dropped, the counts stay
  const old = lib.glanceModel({ ...full(), flowAt: NOW - 11 * 60000, now: NOW + 1000 })
  expect(old.cells.map((c: any) => [c.value, c.delta])).toEqual([
    ['4', ''],
    ['5', ''],
    ['19', ''],
    ['–', ''],
  ])
  // no good poll yet
  expect(lib.glanceModel({ ...full(), at: 0 })).toEqual({ empty: true, text: 'Factory: no data' })
})

test('glanceModel: 2 min without a good poll dims; no Console URL is inert', () => {
  expect(lib.glanceModel({ ...full(), now: NOW + 120000 }).stale).toBe(false)
  const stale = lib.glanceModel({ ...full(), now: NOW + 120001 })
  expect(stale.stale).toBe(true)
  expect(stale.needs.tip).toBe('No fresh answer from the factory for 2 min')
  expect(stale.cells[0].tip).toBe('No fresh answer from the factory for 2 min')
  expect(stale.health.tip).toBe('No fresh answer from the factory for 2 min')
  const unset = lib.glanceModel({ ...full(), base: '' })
  expect(unset.needs.link).toBeNull()
  expect(unset.cells.every((c: any) => c.link === null)).toBe(true)
  expect(unset.needs.tip).toContain('FACTORY_CONSOLE_URL is not set')
})

// -- the sections of the essentials: needs items, leads, queue reasons, production, host

const flowBoard = {
  trend: trend.trend,
  states: {
    working: {
      issues: [
        { id: 'issue_30', repo: 'weatherorb', title: 'Secret fix', kind: 'incident', queue: null },
        { id: 'issue_31', repo: 'dotfiles', title: 'Secret', kind: 'feature', queue: null },
      ],
    },
    queued: {
      issues: [
        { id: 'issue_40', repo: 'weatherorb', title: 'Secret', kind: 'feature', queue: lineQueue(30, 'weatherorb') },
        { id: 'issue_41', repo: 'weatherorb', title: 'Secret', kind: 'feature', queue: lineQueue(30, 'weatherorb') },
        { id: 'issue_42', repo: 'dotfiles', title: 'Secret', kind: 'feature', queue: null },
        {
          id: 'issue_43',
          repo: 'basalt-ui',
          title: 'Secret',
          kind: 'feature',
          queue: { kind: 'chain', message: 'Secret' },
        },
        {
          id: 'issue_44',
          repo: 'iris',
          title: 'Secret',
          kind: 'incident',
          queue: { kind: 'chain', message: 'Secret' },
        },
        {
          id: 'issue_45',
          repo: 'argo',
          title: 'Secret',
          kind: 'incident',
          queue: { kind: 'drain', message: 'Secret' },
        },
        { id: 'issue_46', repo: 'home', title: 'Secret', kind: 'incident', queue: null },
      ],
    },
  },
}
function lineQueue(issue: number, project: string) {
  return { kind: 'line', message: `production of ${project} is red (Issue ${issue}): only fixes run` }
}

test('parseNeeds keeps kind, repo, age and the item id; no words of an item', () => {
  const n = lib.parseNeeds(
    needs({ review: 1 }, [
      { id: 'a', kind: 'review', repo: 'shutterflow', issue: 'issue_5', ageMs: 5, title: 'Secret', summary: 'Secret' },
    ]),
  )
  expect(n.items).toEqual([{ id: 'a', kind: 'review', repo: 'shutterflow', issue: 'issue_5', ageMs: 5 }])
  expect(JSON.stringify(n)).not.toContain('Secret')
})

test('parseOverview: the leads are the working Issues as number, project and phase', () => {
  const o = lib.parseOverview(
    JSON.stringify({
      counts: { working: 2 },
      issues: [
        { id: 7, state: 'working', repoName: 'dotfiles', phase: 'building', title: 'Secret' },
        { id: 8, state: 'queued', repoName: 'dotfiles', phase: 'queued' },
        { id: 'x', state: 'working' },
        { id: 9, state: 'working' },
      ],
    }),
  )
  expect(o.leads).toEqual([
    { n: 7, repo: 'dotfiles', phase: 'building' },
    { n: 9, repo: '?', phase: 'working' },
  ])
  expect(JSON.stringify(o)).not.toContain('Secret')
})

test('parseMachine: load, swap and their ceilings; null when a figure is missing', () => {
  const body = { load: 14.8, loadCeiling: 36, memory: { swapUsedPct: 2.6 }, memoryCeilings: { swapUsedPct: 75 } }
  expect(lib.parseMachine(JSON.stringify(body))).toEqual({ load: 14.8, loadCeiling: 36, swapPct: 2.6, swapCeiling: 75 })
  expect(lib.parseMachine(JSON.stringify({ ...body, loadCeiling: 0, memoryCeilings: {} }))).toEqual({
    load: 14.8,
    loadCeiling: null,
    swapPct: 2.6,
    swapCeiling: null,
  })
  expect(lib.parseMachine(JSON.stringify({ load: null, memory: {} }))).toBeNull()
  expect(lib.parseMachine('')).toBeNull()
})

test('parseFlow: why each Issue is queued and which projects are red', () => {
  const f = lib.parseFlow(JSON.stringify(flowBoard))
  expect(f.why).toEqual([
    { kind: 'line', project: 'weatherorb' },
    { kind: 'line', project: 'weatherorb' },
    { kind: 'seat', project: 'dotfiles' },
    { kind: 'chain', project: 'basalt-ui' },
    { kind: 'chain', project: 'iris' },
    { kind: 'drain', project: 'argo' },
    { kind: 'seat', project: 'home' },
  ])
  // The server's rule (stoppedProjects): an incident that is queued or working and that nothing blocks stops its line.
  // weatherorb works one, argo and home queue one (a drain only holds the start); iris's incident waits for another
  // Issue (a chain), so it stops nothing.
  expect(f.red).toEqual([
    { project: 'weatherorb', n: 30 },
    { project: 'argo', n: 45 },
    { project: 'home', n: 46 },
  ])
  expect(JSON.stringify(f)).not.toContain('Secret')
  // a board with no columns and no trend is nothing; columns alone are enough
  expect(lib.parseFlow('{"states":{}}')).toMatchObject({ why: [], red: [], working: null })
  expect(lib.parseFlow('{"states":{"queued":{"issues":[null,5,{"queue":{"kind":7}}]}}}').why).toEqual([
    { kind: 'seat', project: null },
  ])
})

test('parseFlow: a red line is read from a queued Issue even when the incident is not on the board', () => {
  const f = lib.parseFlow(
    JSON.stringify({
      states: { queued: { issues: [{ id: 'issue_1', repo: 'iris', queue: lineQueue(99, 'weatherorb') }] } },
    }),
  )
  expect(f.red).toEqual([{ project: 'weatherorb', n: 99 }])
})

test('ageText: minutes, hours, days', () => {
  expect(lib.ageText(0)).toBe('1m')
  expect(lib.ageText(59 * 60000)).toBe('59m')
  expect(lib.ageText(3 * 3600000)).toBe('3h')
  expect(lib.ageText(47 * 3600000)).toBe('47h')
  expect(lib.ageText(72 * 3600000)).toBe('3d')
  expect(lib.ageText(Number.NaN)).toBe('')
  expect(lib.ageText(-5)).toBe('')
})

test('needsRows: the three newest, kind and repo and age, each a link to its item', () => {
  const n = lib.parseNeeds(
    needs({ review: 4 }, [
      { id: 'old', kind: 'errand', repo: 'dotfiles', ageMs: 90 * 3600000 },
      { id: 'new', kind: 'review', repo: 'shutterflow', ageMs: 5 * 60000 },
      { id: 'mid', kind: 'held_signal', repo: null, ageMs: 2 * 3600000 },
      { id: 'noage', kind: 'decision', repo: 'iris' },
    ]),
  )
  const r = lib.needsRows(n, base)
  expect(r.rows).toEqual([
    { text: 'review · shutterflow', age: '5m', link: `${base}/needs-you?item=new` },
    { text: 'signal', age: '2h', link: `${base}/needs-you?item=mid` },
    { text: 'errand · dotfiles', age: '3d', link: `${base}/needs-you?item=old` },
  ])
  expect(r.more).toBe(1)
  expect(lib.needsRows(null, base)).toEqual({ rows: [], more: 0 })
  expect(lib.needsRows(n, '').rows.every((x: any) => x.link === null)).toBe(true)
})

test('leadRows: by project, the busiest first, one Issue chip with its phase and the rest as +N', () => {
  const leads = [
    ...[3, 1, 2].map((n) => ({ n, repo: 'software-factory', phase: 'building' })),
    { n: 9, repo: 'dotfiles', phase: 'review' },
    { n: 10, repo: 'argo', phase: 'building' },
    { n: 11, repo: 'basalt-ui', phase: 'building' },
    { n: 12, repo: 'iris', phase: 'building' },
    { n: 13, repo: 'home', phase: 'building' },
  ]
  const r = lib.leadRows(leads, base)
  expect(r.total).toBe(8)
  expect(r.rows).toHaveLength(4)
  expect(r.more).toBe(2)
  expect(r.rows[0]).toEqual({
    project: 'software-factory',
    count: 3,
    chips: [{ text: '#1 building', link: `${base}/issues/1` }],
    more: 2,
    moreTip: '#2 building, #3 building',
    link: `${base}/flow?project=software-factory`,
  })
  expect(r.rows.map((x: any) => x.project)).toEqual(['software-factory', 'argo', 'basalt-ui', 'dotfiles'])
  expect(lib.leadRows([], base)).toEqual({ rows: [], more: 0, total: 0 })
})

test('queueRows: groups by the binding reason, the largest first, the tail is one row', () => {
  const f = lib.parseFlow(JSON.stringify(flowBoard))
  const rows = lib.queueRows(f.why, base)
  expect(rows.map((r: any) => r.text)).toEqual([
    '2 · production red, only fixes run: weatherorb',
    '2 · waits for a free seat',
    '3 · 2 other reasons',
  ])
  expect(rows[0].link).toBe(`${base}/flow?state=queued`)
  // three groups fit without a tail
  expect(
    lib
      .queueRows(
        f.why.filter((w: any) => w.kind !== 'drain'),
        base,
      )
      .map((r: any) => r.text),
  ).toEqual([
    '2 · production red, only fixes run: weatherorb',
    '2 · waits for a free seat',
    '2 · waits for another Issue',
  ])
  expect(lib.queueRows([{ kind: 'new_kind', project: null }], base)[0].text).toBe('1 · new_kind')
  expect(lib.queueRows([], base)).toEqual([])
})

test('productionRows: each red project links to its incident', () => {
  const p = lib.productionRows(
    [
      { project: 'weatherorb', n: 30 },
      { project: 'argo', n: null },
      { project: 'home', n: 46 },
    ],
    base,
  )
  expect(p.red).toBe(3)
  expect(p.more).toBe(1)
  expect(p.rows).toEqual([
    { text: 'weatherorb · #30', link: `${base}/issues/30` },
    { text: 'argo', link: `${base}/flow` },
  ])
  expect(lib.productionRows([], base)).toEqual({ rows: [], more: 0, red: 0 })
})

test('hostLine: load and swap against the ceilings that stop new leads', () => {
  const m = (load: number, swapPct: number) => ({ load, loadCeiling: 36, swapPct, swapCeiling: 75 })
  expect(lib.hostLine(m(14.8, 2.6))).toMatchObject({ text: 'Load 15/36 · Swap 3%', tone: 'dim' })
  expect(lib.hostLine(m(27, 2)).tone).toBe('warn')
  expect(lib.hostLine(m(10, 60)).tone).toBe('warn')
  expect(lib.hostLine(m(36, 2)).tone).toBe('bad')
  expect(lib.hostLine(m(10, 80)).tone).toBe('bad')
  expect(lib.hostLine({ load: 5, loadCeiling: null, swapPct: 1, swapCeiling: null })).toMatchObject({
    text: 'Load 5 · Swap 1%',
    tone: 'dim',
  })
  expect(lib.hostLine(null)).toBeNull()
})

const essentials = () => ({
  ...full(),
  overview: lib.parseOverview(
    JSON.stringify({
      counts: { working: 2, waiting: 1, queued: 7, asks: 1, humanQueue: 0, health: 0 },
      health: [],
      issues: [
        { id: 30, state: 'working', repoName: 'weatherorb', phase: 'building', title: 'Secret' },
        { id: 31, state: 'working', repoName: 'dotfiles', phase: 'waiting for your review', summary: 'Secret' },
      ],
    }),
  ),
  flow: lib.parseFlow(JSON.stringify(flowBoard)),
  machine: lib.parseMachine(
    '{"load":15,"loadCeiling":36,"memory":{"swapUsedPct":3},"memoryCeilings":{"swapUsedPct":75}}',
  ),
})

test('glanceModel: the essentials', () => {
  const m = lib.glanceModel(essentials())
  expect(m.needs.rows).toEqual([{ text: 'item', age: '1m', link: `${base}/needs-you?item=it1` }])
  expect(m.leads).toMatchObject({ text: 'Leads · 2', link: `${base}/flow?state=working` })
  expect(m.leads.rows.map((r: any) => [r.project, r.chips[0].text])).toEqual([
    ['dotfiles', '#31 waiting for your review'],
    ['weatherorb', '#30 building'],
  ])
  expect(m.queue.text).toBe('Queued · 7')
  expect(m.queue.rows[0].text).toBe('2 · production red, only fixes run: weatherorb')
  expect(m.production.red).toBe(3)
  expect(m.shippedToday.text).toBe('Shipped today · 89')
  expect(m.host).toMatchObject({ text: 'Load 15/36 · Swap 3%', tone: 'dim', link: `${base}/throughput` })
  expect(words(m)).not.toContain('Secret')
})

test('glanceModel: the essentials degrade per part', () => {
  const noFlow = lib.glanceModel({ ...essentials(), flow: null })
  expect(noFlow.production).toBeNull() // unknown is not green
  expect(noFlow.queue.rows).toEqual([])
  expect(noFlow.shippedToday.text).toBe('Shipped today · –')
  const noOverview = lib.glanceModel({ ...essentials(), overview: null })
  expect(noOverview.leads).toMatchObject({ text: 'Leads · –', rows: [], total: 0 })
  expect(noOverview.queue.text).toBe('Queued · –')
  expect(lib.glanceModel({ ...essentials(), machine: null }).host).toBeNull()
  // a trend older than 10 min takes the board's read with it
  expect(lib.glanceModel({ ...essentials(), flowAt: NOW - 11 * 60000 }).production).toBeNull()
  // stale: the host tip says so; no Console URL: nothing links
  expect(lib.glanceModel({ ...essentials(), now: NOW + 3 * 60000 }).host.tip).toBe(
    'No fresh answer from the factory for 2 min',
  )
  const unset = lib.glanceModel({ ...essentials(), base: '' })
  const links = JSON.stringify(unset, (k, v) => (k === 'link' ? (v === null ? undefined : 'LINK') : v))
  expect(links).not.toContain('LINK')
})
