import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The mod imports gpui and herdr, so it cannot load here. Its pure helpers sit between `// <glance>` and `// </glance>`
// with no imports; this runs the block on its own.
const src = readFileSync(join(import.meta.dir, 'jk-glance/main.js'), 'utf8')
const block = /\/\/ <glance>[^\n]*\n([\s\S]*?)\/\/ <\/glance>/.exec(src)?.[1]
if (!block) throw new Error('jk-glance: no <glance> block')
const lib = new Function(
  `${block}; return { GLANCE_H, BAR_W, BAR_H, POPUP_W, MAX_ROWS, WORST_POPUP_H, popupHeight, barWidth, capRows, parseNeeds, parseOverview, parseFlow, parseMachine, parseStats, parseLeads, queueReasons, needsRows, projectRows, queueRows, productionRows, hostFigures, hostRows, healthRows, ageText, parseUptime, parsePoll, terminalsMap, needsTotal, needsCount, newestItem, needsLabel, consoleLink, issueLink, toneOf, deltaText, kpiCells, glanceModel }`,
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
  // no flow: figures from the overview, no change
  const noFlow = lib.kpiCells(o, null)
  expect(noFlow.map((c: any) => c.value)).toEqual([4, 5, 19, null])
  expect(noFlow.every((c: any) => c.delta === null)).toBe(true)
  // no overview: figures from the last sample
  const noOverview = lib.kpiCells(null, lib.parseFlow(JSON.stringify(trend)))
  expect(noOverview.map((c: any) => c.value)).toEqual([4, 5, 19, 687])
  expect(lib.kpiCells(null, null).map((c: any) => c.value)).toEqual([null, null, null, null])
})

test('parsePoll: parts parse on their own', () => {
  const issues = '{"issues":[{"id":362,"title":"T"},{"id":"x"}]}'
  const sessions = '{"sessions":[{"id":"lead-362-1","issue":362},{"id":5}]}'
  const machine = '{"load":3.5,"loadCeiling":36,"memory":{"swapUsedPct":2.6},"memoryCeilings":{"swapUsedPct":75}}'
  const out = `${needs({ decision: 1 })}\n@@\nbroken\n@@\n${issues}\n@@\n${sessions}\n@@\n${machine}\n@@\n23.4 39.2 64\n@@\nhttps://c.example.com/\n`
  const p = lib.parsePoll(out)
  expect(p.stats).toEqual({ cpu: 23.4, usedG: 39.2, totalG: 64, ramPct: (39.2 / 64) * 100 })
  expect(p.needs).not.toBeNull()
  expect(p.overview).toBeNull()
  expect(p.issues).toEqual([{ id: 362, title: 'T' }])
  expect(p.sessions).toEqual([{ id: 'lead-362-1', issue: 362 }])
  expect(p.machine).toEqual({ load: 3.5, loadCeiling: 36, swapPct: 2.6, swapCeiling: 75 })
  expect(p.base).toBe('https://c.example.com/')
  const bad = lib.parsePoll(`${needs({})}\n@@\n{}\n@@\nnope\n@@\n{}\n@@\nx\n@@\n\n@@\nhttps://c.example.com/\n`)
  expect(bad.issues).toBeNull()
  expect(bad.sessions).toBeNull()
  expect(bad.machine).toBeNull()
  expect(bad.stats).toBeNull()
  expect(bad.base).toBe('https://c.example.com/')
  expect(lib.parsePoll('').base).toBeNull()
  expect(lib.parsePoll(`${needs({})}\n@@\n{}\n@@\n`).base).toBeNull()
})

test('parseStats: cpu, used and total GiB; null when any is missing or the total is zero', () => {
  expect(lib.parseStats('12.5 8.0 16\n')).toEqual({ cpu: 12.5, usedG: 8, totalG: 16, ramPct: 50 })
  expect(lib.parseStats('')).toBeNull()
  expect(lib.parseStats('12 x 16')).toBeNull()
  expect(lib.parseStats('12 8 0')).toBeNull()
  expect(lib.parseStats('-1 8 16')).toBeNull()
  expect(lib.parseStats(null)).toBeNull()
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
      link: 'https://c.example.com/issues/362',
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
  expect(lib.issueLink('https://c.example.com/', 9, n)).toBe('https://c.example.com/issues/9')
  expect(lib.issueLink('https://c.example.com/', 7, null)).toBe('https://c.example.com/issues/7')
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
    '{"mini/t0z":{"title":"Loose","summary":"S","state":"idle","repo":"proj","link":null},"mini/t1":{"title":"Seven","summary":"Sum 7","state":"working","repo":"dotfiles","link":"https://c.example.com/needs-you?item=it1"},"mini/t2":{"title":"Eight","summary":null,"state":"queued","repo":"software-factory","link":"https://c.example.com/issues/8"}}',
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

test('parseOverview: the leads are the working Issues as their project only', () => {
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
  expect(o.leads).toEqual([{ repo: 'dotfiles' }, { repo: '?' }])
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

// -- the bar, its popovers and the sidebar line

const hostMachine = () =>
  lib.parseMachine('{"load":15,"loadCeiling":36,"memory":{"swapUsedPct":3},"memoryCeilings":{"swapUsedPct":75}}')
const hostStats = () => lib.parseStats('23.4 39.2 64')

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
  machine: hostMachine(),
  stats: hostStats(),
})

const itemOf = (m: any, key: string) => m.items.find((i: any) => i.key === key)
const rowsOf = (m: any, key: string) => m.details[key].rows

test('ageText: minutes, hours, days', () => {
  expect(lib.ageText(0)).toBe('1m')
  expect(lib.ageText(59 * 60000)).toBe('59m')
  expect(lib.ageText(3 * 3600000)).toBe('3h')
  expect(lib.ageText(47 * 3600000)).toBe('47h')
  expect(lib.ageText(72 * 3600000)).toBe('3d')
  expect(lib.ageText(Number.NaN)).toBe('')
  expect(lib.ageText(-5)).toBe('')
})

test('the bar: short items left to right, load in percent of its ceiling, no list of leads', () => {
  const m = lib.glanceModel(essentials())
  expect(m.items.map((i: any) => [i.key, i.label, i.value])).toEqual([
    ['needs', 'Needs you', '1'],
    ['working', 'Working', '2'],
    ['waiting', 'Waiting', '1'],
    ['queued', 'Queued', '7'],
    ['shipped', 'Shipped', '89'],
    ['production', 'Prod', '3'],
    ['cpu', 'CPU', '23%'],
    ['ram', 'RAM', '61%'],
    ['load', 'Load', '42%'],
    ['health', 'Health', '0'],
  ])
  expect(itemOf(m, 'needs').tone).toBe('bad')
  expect(itemOf(m, 'production')).toMatchObject({ dot: 'bad', tone: 'bad' })
  expect(itemOf(m, 'health')).toMatchObject({ dot: 'good' })
  // never a ratio like 15/36, never a lead of its own
  expect(m.items.every((i: any) => !i.value.includes('/'))).toBe(true)
  expect(m.items.some((i: any) => /lead|#\d/i.test(`${i.label} ${i.value}`))).toBe(false)
})

test('the bar: needs you is red above 0 only; production is green with no red project', () => {
  const none = lib.glanceModel({
    ...essentials(),
    needs: lib.parseNeeds(needs({})),
    overview: lib.parseOverview('{"counts":{}}'),
    flow: lib.parseFlow(JSON.stringify(trend)),
  })
  expect(itemOf(none, 'needs')).toMatchObject({ value: '0', tone: 'dim' })
  expect(itemOf(none, 'production')).toMatchObject({ value: '', dot: 'good', tone: 'dim' })
  expect(none.details.production.title).toBe('Production · green')
})

test('the bar: load is a percent of its ceiling, the plain figure without one, red at the ceiling or with swap at its own', () => {
  const load = (machine: unknown) => itemOf(lib.glanceModel({ ...essentials(), machine }), 'load')
  const m = (l: number, swap: number, ceiling: number | null = 36) =>
    lib.parseMachine(
      JSON.stringify({
        load: l,
        loadCeiling: ceiling,
        memory: { swapUsedPct: swap },
        memoryCeilings: { swapUsedPct: 75 },
      }),
    )
  expect(load(m(14.8, 2.6))).toMatchObject({ value: '41%', tone: 'neutral' })
  expect(load(m(27, 2))).toMatchObject({ value: '75%', tone: 'warn' })
  expect(load(m(36, 2))).toMatchObject({ value: '100%', tone: 'bad' })
  expect(load(m(10, 80))).toMatchObject({ value: '28%', tone: 'bad' }) // swap past its ceiling stops new leads too
  expect(load(m(10, 2, null))).toMatchObject({ value: '10', tone: 'neutral' })
  expect(load(null)).toMatchObject({ value: '–', tone: 'dim' })
  expect(lib.hostFigures(null, null)).toEqual({ cpu: null, ram: null, load: null })
  const hot = lib.hostFigures(m(1, 1), lib.parseStats('90 56 64'))
  expect(hot.cpu).toEqual({ value: '90%', tone: 'bad' })
  expect(hot.ram).toEqual({ value: '88%', tone: 'bad' })
})

test('the popovers: the detail the sidebar block showed, each row a link into the Console', () => {
  const m = lib.glanceModel(essentials())
  expect(m.details.needs).toMatchObject({ title: 'Needs you · 1', tone: 'bad', link: `${base}/needs-you?item=it1` })
  expect(rowsOf(m, 'needs')).toEqual([{ text: 'item', right: '1m', link: `${base}/needs-you?item=it1` }])
  // the leads by project, a count each, and the change against 7 days ago
  expect(m.details.working.title).toBe('Working · 2')
  expect(rowsOf(m, 'working')).toEqual([
    { text: 'dotfiles', right: '1', link: `${base}/flow?project=dotfiles` },
    { text: 'weatherorb', right: '1', link: `${base}/flow?project=weatherorb` },
    { text: 'Change in 7 days', right: '▲ +2', tone: 'good' },
  ])
  expect(m.details.waiting.link).toBe(`${base}/flow?state=waiting`)
  expect(rowsOf(m, 'waiting')).toEqual([{ text: 'Change in 7 days', right: '▲ +3', tone: 'bad' }])
  expect(rowsOf(m, 'queued').map((r: any) => [r.text, r.right])).toEqual([
    ['production red, only fixes run: weatherorb', '2'],
    ['waits for a free seat', '2'],
    ['waits for another Issue', '2'],
    ['the queue is draining', '1'],
    ['Change in 7 days', '▲ +9'],
  ])
  expect(rowsOf(m, 'queued')[2].link).toBe(`${base}/chain`)
  expect(m.details.shipped.title).toBe('Shipped today · 89')
  expect(rowsOf(m, 'shipped').map((r: any) => [r.text, r.right])).toEqual([
    ['This week', '687'],
    ['The week before', '71'],
    ['Change in 7 days', '▲ +616'],
  ])
  expect(m.details.production.title).toBe('Production · 3 red')
  expect(rowsOf(m, 'production')[0]).toEqual({
    text: 'weatherorb',
    right: '#30',
    tone: 'bad',
    link: `${base}/issues/30`,
  })
  // the three host items open one popover with every figure and what it is against
  expect(m.details.cpu).toBe(m.details.load)
  expect(m.details.ram).toBe(m.details.load)
  expect(m.details.load.link).toBe(`${base}/throughput`)
  expect(rowsOf(m, 'load').map((r: any) => [r.text, r.right ?? ''])).toEqual([
    ['CPU', '23%'],
    ['RAM', '61% · 39 of 64 G'],
    ['Load', '42% · 15 of 36'],
    ['Swap', '3% of 75%'],
    ['New leads stop at a ceiling', ''],
  ])
})

test('the popovers: health by kind, the uptime and what is down', () => {
  const m = lib.glanceModel(full())
  expect(m.details.health.title).toBe('Health · 2')
  expect(rowsOf(m, 'health')).toEqual([
    { text: 'door', right: '2', tone: 'warn' },
    { text: 'Uptime', right: '67 of 70 up', tone: 'bad' },
    { text: 'Monitor A', right: 'down', tone: 'bad' },
  ])
  expect(rowsOf(lib.glanceModel(essentials()), 'health')).toEqual([{ text: 'Nothing to report', tone: 'dim' }])
  expect(lib.healthRows(null)).toEqual([])
})

test('the sidebar block is one line: Needs you and the lead count', () => {
  expect(lib.glanceModel(essentials()).side).toMatchObject({
    text: 'Needs you · 1 · 2 leads',
    tone: 'bad',
    link: `${base}/needs-you?item=it1`,
  })
  const quiet = lib.glanceModel({ ...essentials(), overview: lib.parseOverview('{"counts":{"working":1}}') })
  expect(quiet.side).toMatchObject({ text: 'Nothing waits on you · 1 lead', tone: 'dim' })
  expect(lib.glanceModel({ ...essentials(), overview: null }).side.text).toBe('Needs you · 2')
  expect(lib.GLANCE_H).toBe(28) // the sidebar block's height in dotfiles' layout (config/herdr-app/layouts/jk.json)
})

test('no ticket title, summary, number or phase is drawn or in a tooltip', () => {
  for (const input of [
    full(),
    essentials(),
    { ...essentials(), now: NOW + 3 * 60000 },
    { ...essentials(), base: '' },
  ]) {
    const all = words(lib.glanceModel(input))
    expect(all).not.toContain('Secret')
    expect(all).not.toContain('issue_')
    expect(all).not.toContain('building')
    expect(all).not.toContain('review')
    expect(all).not.toMatch(/it1/)
  }
  // a lead is never listed: the parsed overview holds no number or phase of one
  expect(JSON.stringify(essentials().overview.leads)).toBe('[{"repo":"weatherorb"},{"repo":"dotfiles"}]')
})

test('the model degrades per part', () => {
  // no board read: production is unknown, not green, and shipped has no figure
  const noFlow = lib.glanceModel({ ...essentials(), flow: null })
  expect(itemOf(noFlow, 'production')).toMatchObject({ value: '', dot: 'dim' })
  expect(noFlow.details.production.title).toBe('Production · –')
  expect(itemOf(noFlow, 'shipped').value).toBe('–')
  expect(rowsOf(noFlow, 'queued')).toEqual([])
  // a trend older than 10 min is dropped with the board
  expect(itemOf(lib.glanceModel({ ...essentials(), flowAt: NOW - 11 * 60000 }), 'production').dot).toBe('dim')
  // no overview: the trend's last samples stand in, health is unknown
  const noOverview = lib.glanceModel({ ...essentials(), overview: null })
  expect(
    noOverview.items.filter((i: any) => ['working', 'waiting', 'queued'].includes(i.key)).map((i: any) => i.value),
  ).toEqual(['4', '5', '19'])
  expect(itemOf(noOverview, 'health')).toMatchObject({ value: '–', dot: 'dim' })
  // no host reads: dashes
  const noHost = lib.glanceModel({ ...essentials(), machine: null, stats: null })
  expect(['cpu', 'ram', 'load'].map((k) => itemOf(noHost, k).value)).toEqual(['–', '–', '–'])
  expect(rowsOf(noHost, 'cpu')).toEqual([{ text: 'Not known yet', tone: 'dim' }])
  // no good poll yet
  expect(lib.glanceModel({ ...essentials(), at: 0 })).toEqual({ empty: true, text: 'Factory: no data' })
})

test('2 min without a good poll dims; no Console URL is inert', () => {
  expect(lib.glanceModel({ ...essentials(), now: NOW + 120000 }).stale).toBe(false)
  const stale = lib.glanceModel({ ...essentials(), now: NOW + 120001 })
  expect(stale.stale).toBe(true)
  expect(stale.items.every((i: any) => i.tip === 'No fresh answer from the factory for 2 min')).toBe(true)
  const unset = lib.glanceModel({ ...essentials(), base: '' })
  const links = JSON.stringify(unset, (k, v) => (k === 'link' ? (v === null ? undefined : 'LINK') : v))
  expect(links).not.toContain('LINK')
  expect(unset.side.tip).toContain('FACTORY_CONSOLE_URL is not set')
})

test('needsRows: the newest first, kind and repo and age, each a link to its item', () => {
  const n = lib.parseNeeds(
    needs({ review: 4 }, [
      { id: 'old', kind: 'errand', repo: 'dotfiles', ageMs: 90 * 3600000 },
      { id: 'new', kind: 'review', repo: 'shutterflow', ageMs: 5 * 60000 },
      { id: 'mid', kind: 'held_signal', repo: null, ageMs: 2 * 3600000 },
      { id: 'noage', kind: 'decision', repo: 'iris' },
    ]),
  )
  expect(lib.needsRows(n, base)).toEqual([
    { text: 'review · shutterflow', right: '5m', link: `${base}/needs-you?item=new` },
    { text: 'signal', right: '2h', link: `${base}/needs-you?item=mid` },
    { text: 'errand · dotfiles', right: '3d', link: `${base}/needs-you?item=old` },
    { text: 'decision · iris', right: '', link: `${base}/needs-you?item=noage` },
  ])
  expect(lib.needsRows(null, base)).toEqual([])
  expect(lib.needsRows(n, '').every((x: any) => x.link === null)).toBe(true)
})

test('projectRows: by project, the busiest first, a count and nothing of a lead', () => {
  const leads = [...[1, 2, 3].map(() => ({ repo: 'software-factory' })), { repo: 'dotfiles' }, { repo: 'argo' }]
  expect(lib.projectRows(leads, base)).toEqual([
    { text: 'software-factory', right: '3', link: `${base}/flow?project=software-factory` },
    { text: 'argo', right: '1', link: `${base}/flow?project=argo` },
    { text: 'dotfiles', right: '1', link: `${base}/flow?project=dotfiles` },
  ])
  expect(lib.projectRows([], base)).toEqual([])
})

test('queueRows: groups by the binding reason, the largest first, the tail is one row', () => {
  const f = lib.parseFlow(JSON.stringify(flowBoard))
  const many = Array.from({ length: 9 }, (_, i) => ({
    kind: ['chain', 'drain', 'doctor', 'boot', 'load', 'memory', 'lane', 'window', 'cap'][i],
    project: 'p',
  }))
  const rows = lib.queueRows([...f.why, ...many], base)
  expect(rows).toHaveLength(lib.MAX_ROWS - 2)
  expect(rows.at(-1).text).toBe('6 other reasons')
  expect(rows[0]).toEqual({ text: 'waits for another Issue', right: '3', link: `${base}/chain` })
  expect(lib.queueRows(f.why, base)[0]).toEqual({
    text: 'production red, only fixes run: weatherorb',
    right: '2',
    link: `${base}/flow?state=queued`,
  })
  expect(lib.queueRows([{ kind: 'new_kind', project: null }], base)[0]).toMatchObject({ text: 'new_kind', right: '1' })
  expect(lib.queueRows([], base)).toEqual([])
})

test('productionRows: each red project links to its incident', () => {
  const p = lib.productionRows(
    [
      { project: 'weatherorb', n: 30 },
      { project: 'argo', n: null },
    ],
    base,
  )
  expect(p.red).toBe(2)
  expect(p.rows).toEqual([
    { text: 'weatherorb', right: '#30', tone: 'bad', link: `${base}/issues/30` },
    { text: 'argo', right: '', tone: 'bad', link: `${base}/flow` },
  ])
  expect(lib.productionRows([], base)).toEqual({ rows: [], red: 0 })
})

test('capRows: a longer list ends in one "+N more" row', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ text: `r${i}` }))
  const capped = lib.capRows(rows, 'L')
  expect(capped).toHaveLength(lib.MAX_ROWS)
  expect(capped.at(-1)).toEqual({ text: '+5 more', tone: 'dim', link: 'L' })
  expect(lib.capRows(rows.slice(0, 8), 'L')).toHaveLength(8)
})

// -- the heights and the width

// The tallest a board can get: every list far past its cap, every figure at its widest.
const worstCase = () => {
  const kinds = ['chain', 'drain', 'doctor', 'boot', 'load', 'memory', 'lane', 'window', 'cap', 'claim', 'spec']
  const board = {
    trend: { states: {}, shipped: [999, 999, 999, 999, 999, 999, 999], shippedBefore: 1 },
    states: {
      working: {
        issues: Array.from({ length: 12 }, (_, i) => ({
          id: `issue_${100 + i}`,
          repo: `p${i}`,
          kind: 'incident',
          queue: null,
        })),
      },
      queued: {
        issues: kinds.map((kind, i) => ({
          id: `issue_${200 + i}`,
          repo: `q${i}`,
          kind: 'feature',
          queue: { kind, message: 'x' },
        })),
      },
    },
  }
  return {
    ...full(),
    needs: lib.parseNeeds(
      needs(
        { decision: 99 },
        Array.from({ length: 30 }, (_, i) => ({
          id: `n${i}`,
          kind: 'held_signal',
          repo: 'software-factory',
          ageMs: i * 60000,
        })),
      ),
    ),
    overview: lib.parseOverview(
      JSON.stringify({
        counts: { working: 99, waiting: 99, queued: 99, asks: 99, humanQueue: 99, health: 99 },
        health: Array.from({ length: 12 }, (_, i) => ({ kind: `kind${i}` })),
        uptime: { up: 1, down: 10, total: 11, downNames: Array.from({ length: 10 }, (_, i) => `monitor-${i}`) },
        issues: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, state: 'working', repoName: `project-${i}` })),
      }),
    ),
    flow: lib.parseFlow(JSON.stringify(board)),
    machine: lib.parseMachine(
      '{"load":360,"loadCeiling":36,"memory":{"swapUsedPct":99},"memoryCeilings":{"swapUsedPct":75}}',
    ),
    stats: lib.parseStats('100 64 64'),
  }
}

test('the sidebar block is one line: at most 28 px high', () => {
  expect(lib.GLANCE_H).toBeLessThanOrEqual(28)
  expect(lib.BAR_H).toBe(28)
})

test('every popover fits its card: at most MAX_ROWS rows, the height is what the rows need', () => {
  const m = lib.glanceModel(worstCase())
  for (const [key, d] of Object.entries<any>(m.details)) {
    expect(d.rows.length, key).toBeLessThanOrEqual(lib.MAX_ROWS)
    expect(d.height, key).toBe(lib.popupHeight(d.rows.length))
    expect(d.height, key).toBeLessThanOrEqual(lib.WORST_POPUP_H)
  }
  expect(m.details.needs.rows.at(-1).text).toMatch(/^\+\d+ more$/)
  expect(m.details.health.rows.at(-1).text).toMatch(/^\+\d+ more$/)
  expect(m.details.working.rows.at(-1).text).toMatch(/^\+\d+ more$/)
  // with a trend, its row keeps its place after the capped projects
  const withTrend = lib.glanceModel({ ...worstCase(), flow: lib.parseFlow(JSON.stringify(trend)) })
  expect(withTrend.details.working.rows).toHaveLength(lib.MAX_ROWS)
  expect(withTrend.details.working.rows.at(-2).text).toMatch(/^\+\d+ more$/)
  expect(withTrend.details.working.rows.at(-1).text).toBe('Change in 7 days')
})

test('the bar fits its block at its widest', () => {
  const m = lib.glanceModel(worstCase())
  expect(m.items).toHaveLength(10)
  expect(lib.barWidth(m.items)).toBeLessThanOrEqual(lib.BAR_W)
  // the usual bar is narrower than the worst one
  expect(lib.barWidth(lib.glanceModel(essentials()).items)).toBeLessThan(lib.barWidth(m.items))
})
