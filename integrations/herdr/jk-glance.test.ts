import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The mod imports gpui and herdr, so it cannot load here. Its pure helpers sit between `// <glance>` and `// </glance>`
// with no imports; this runs the block on its own.
const src = readFileSync(join(import.meta.dir, 'jk-glance/main.js'), 'utf8')
const block = /\/\/ <glance>[^\n]*\n([\s\S]*?)\/\/ <\/glance>/.exec(src)?.[1]
if (!block) throw new Error('jk-glance: no <glance> block')
const lib = new Function(
  `${block}; return { GLANCE_H, BAR_W, BAR_H, POPUP_W, POPUP_GAP, EDGE, MAX_ROWS, SHIPPED_ROWS, WORST_POPUP_H, popupHeight, chartHeight, placePopup, popupSpec, barWidth, capRows, parseNeeds, parseOverview, parseFlow, parseMachine, parseProjects, shippedProjectsOf, queueReasons, parseWork, workFromColumns, splitRows, needsRows, projectRows, productionRows, hostOf, healthRows, ageText, parsePoll, terminalsMap, needsTotal, needsCount, newestItem, needsLabel, consoleLink, issueLink, toneOf, deltaText, kpiCells, glanceModel }`,
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

// The server's `counts.work`: five words and the splits of three, the same shape in the overview and the flow.
const workBody = (over: object = {}) => ({
  running: 2,
  paused: 1,
  ready: 3,
  held: 2,
  checking: 1,
  split: {
    paused: { you: 1, timer: 0, issue: 0, stalled: 0 },
    ready: { seat: 1, host: 2, repo: 0, account: 0 },
    held: { issue: 1, line: 0, drain: 0, spec: 0, settling: 1 },
  },
  ...over,
})
const zeroWork = {
  running: 0,
  paused: 0,
  ready: 0,
  held: 0,
  checking: 0,
  split: {
    paused: { you: 0, timer: 0, issue: 0, stalled: 0 },
    ready: { seat: 0, host: 0, repo: 0, account: 0 },
    held: { issue: 0, line: 0, drain: 0, spec: 0, settling: 0 },
  },
}
const noProjects = { running: [], paused: [], ready: [], held: [], checking: [] }

test('parseOverview: counts, health kinds and the projects by word; nothing else', () => {
  const o = lib.parseOverview(
    JSON.stringify({
      counts: { work: workBody(), asks: 2, humanQueue: 1, health: 2 },
      health: [
        { kind: 'door', short: 'Secret title', text: 'Secret text' },
        { kind: 'account', summary: 'Secret' },
        {},
      ],
      uptime: { up: 67, down: 3, total: 70, downNames: ['kuma/A'] },
      issues: [{ id: 1, title: 'Secret' }],
    }),
  )
  expect(o).toEqual({
    work: workBody(),
    asks: 2,
    humanQueue: 1,
    health: 2,
    healthKinds: ['door', 'account', 'other'],
    projects: noProjects,
  })
  // the monitors roll-up is Uptime Kuma's chip in jk-status: the bar keeps nothing of it
  expect(JSON.stringify(o)).not.toMatch(/uptime|kuma/i)
  expect(JSON.stringify(o)).not.toContain('Secret')
  const bare = lib.parseOverview('{"counts":{}}')
  expect(bare).toEqual({
    work: zeroWork,
    asks: 0,
    humanQueue: 0,
    health: 0,
    healthKinds: [],
    projects: noProjects,
  })
  expect(lib.parseOverview('')).toBeNull()
  expect(lib.parseOverview('nope')).toBeNull()
  expect(lib.parseOverview('{}')).toBeNull()
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
    shippedHourly: Array.from({ length: 168 }, (_, i) => i % 7),
    shippedDaily30: Array.from({ length: 30 }, (_, i) => i),
  },
  states: { working: { issues: [{ title: 'Secret title', id: 'issue_9' }] } },
  closedRecently: [{ title: 'Secret closed' }],
}

test('parseFlow: the trend as numbers, nothing else', () => {
  const f = lib.parseFlow(JSON.stringify(trend))
  expect(f).toEqual({
    running: [2, 0, 0, 2, 9, 8, 8, 4],
    paused: [2, 4, 2, 1, 2, 4, 3, 5],
    notStarted: [10, 1, 0, 1, 51, 14, 2, 19],
    checking: [1, 0, 0, 2, 0, 0, 0, 1],
    shipped: [108, 84, 119, 43, 127, 117, 89],
    shippedBefore: 71,
    shippedHourly: trend.trend.shippedHourly,
    shippedDaily30: trend.trend.shippedDaily30,
    work: { ...zeroWork, running: 1 }, // no `work` in the read: counted from the one Issue of its working column
    shippedProjects: [],
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
    running: [1, 2],
    paused: null,
    notStarted: null,
    checking: null,
    shipped: null,
    shippedBefore: null,
    shippedHourly: null,
    shippedDaily30: null,
    work: null,
    shippedProjects: [],
    red: [],
  })
  // NaN and negatives are zero
  expect(lib.parseFlow('{"trend":{"states":{"working":[1,-3,null,4]}}}').running).toEqual([1, 0, 0, 4])
  // Not started is the stored queued and settling samples added
  expect(lib.parseFlow('{"trend":{"states":{"queued":[1,2],"settling":[3,4]}}}').notStarted).toEqual([4, 6])
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

test('kpiCells: the Console strip words and figures', () => {
  const o = lib.parseOverview(
    JSON.stringify({ counts: { work: workBody({ running: 4, paused: 5, ready: 19, held: 0 }) } }),
  )
  const cells = lib.kpiCells(o, lib.parseFlow(JSON.stringify(trend)))
  const by = Object.fromEntries(cells.map((c: any) => [c.key, c]))
  expect(cells.map((c: any) => c.label)).toEqual([
    'Running',
    'Paused',
    'Ready',
    'Held',
    'Checking',
    'Shipped this week',
  ])
  expect([by.running.value, by.running.delta, by.running.tone]).toEqual([4, 2, 'good'])
  expect([by.paused.value, by.paused.delta, by.paused.tone]).toEqual([5, 3, 'bad'])
  // Ready and Held read the one Not started series
  expect([by.ready.value, by.ready.delta, by.ready.tone]).toEqual([19, 9, 'bad'])
  expect([by.held.value, by.held.delta]).toEqual([0, 9])
  expect([by.checking.value, by.checking.delta, by.checking.tone]).toEqual([1, 0, 'neutral'])
  expect([by.shipped.value, by.shipped.delta, by.shipped.tone]).toEqual([687, 616, 'good'])
  // no flow: figures from the overview, no change
  const noFlow = lib.kpiCells(o, null)
  expect(noFlow.map((c: any) => c.value)).toEqual([4, 5, 19, 0, 1, null])
  expect(noFlow.every((c: any) => c.delta === null)).toBe(true)
  // no overview: the flow's own work counts (here counted from its columns)
  const noOverview = lib.kpiCells(null, lib.parseFlow(JSON.stringify(trend)))
  expect(noOverview.map((c: any) => c.value)).toEqual([1, 0, 0, 0, 0, 687])
  // a word with its own trend line reads it when no count is there
  const lineOnly = lib.kpiCells(null, lib.parseFlow('{"trend":{"states":{"working":[1,4],"queued":[1,2]}}}'))
  expect(lineOnly.map((c: any) => c.value)).toEqual([4, null, null, null, null, null])
  expect(lib.kpiCells(null, null).map((c: any) => c.value)).toEqual([null, null, null, null, null, null])
})

test('one set of figures: the overview and the flow count the same Issues to the same words', () => {
  const board = {
    states: {
      settling: { issues: [{ id: 'issue_1' }] },
      queued: {
        issues: [
          { id: 'issue_2', queue: null },
          { id: 'issue_3', queue: { kind: 'load' } },
          { id: 'issue_4', queue: { kind: 'window' } },
          { id: 'issue_5', queue: { kind: 'chain' } },
          { id: 'issue_6', queue: { kind: 'unknown_project' } },
          { id: 'issue_7', queue: { kind: 'brand_new' } },
        ],
      },
      working: { issues: [{ id: 'issue_8' }, { id: 'issue_9' }] },
      waiting: {
        issues: [
          { id: 'issue_10', waitReason: 'decision' },
          { id: 'issue_11', waitReason: 'timer' },
          { id: 'issue_12', waitReason: 'external' },
          { id: 'issue_13', waitReason: 'wall' },
        ],
      },
      watching: { issues: [{ id: 'issue_14' }] },
    },
  }
  const counted = lib.workFromColumns(board.states)
  expect(counted).toEqual({
    running: 2,
    paused: 4,
    ready: 4,
    held: 3,
    checking: 1,
    split: {
      paused: { you: 1, timer: 1, issue: 1, stalled: 1 },
      ready: { seat: 2, host: 1, repo: 0, account: 1 },
      held: { issue: 1, line: 0, drain: 0, spec: 0, settling: 2 },
    },
  })
  // a server that sends `work` is believed over the columns; both parts hold the same figures for the same fixture
  const overview = lib.parseOverview(JSON.stringify({ counts: { work: counted } }))
  const flow = lib.parseFlow(JSON.stringify({ ...board, work: counted }))
  expect(flow.work).toEqual(overview.work)
  const a = lib.glanceModel({ ...full(), overview, flow: null })
  const b = lib.glanceModel({ ...full(), overview: null, flow })
  const figures = (m: any) => m.items.slice(1, 6).map((i: any) => [i.label, i.value])
  expect(figures(a)).toEqual([
    ['Running', '2'],
    ['Paused', '4'],
    ['Ready', '4'],
    ['Held', '3'],
    ['Checking', '1'],
  ])
  expect(figures(b)).toEqual(figures(a))
})

test('parsePoll: parts parse on their own', () => {
  const issues = '{"issues":[{"id":362,"title":"T"},{"id":"x"}]}'
  const sessions = '{"sessions":[{"id":"lead-362-1","issue":362},{"id":5}]}'
  const machine = '{"load":3.5,"loadCeiling":36,"memory":{"swapUsedPct":2.6},"memoryCeilings":{"swapUsedPct":75}}'
  const out = `${needs({ decision: 1 })}\n@@\nbroken\n@@\n${issues}\n@@\n${sessions}\n@@\n${machine}\n@@\nhttps://c.example.com/\n`
  const p = lib.parsePoll(out)
  expect(p).not.toHaveProperty('stats') // the host's CPU and RAM are the mini's chip in jk-status
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
  expect(bad.base).toBe('https://c.example.com/')
  expect(lib.parsePoll('').base).toBeNull()
  expect(lib.parsePoll(`${needs({})}\n@@\n{}\n@@\n`).base).toBeNull()
  expect(lib.parsePoll(`${needs({})}\n@@\n{}\n@@\n{}\n@@\n{}\n@@\n{}\n`).base).toBeNull()
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
      counts: {
        work: workBody({ running: 4, paused: 5, ready: 19, held: 0, checking: 0 }),
        asks: 2,
        humanQueue: 1,
        health: 2,
      },
      health: [
        { kind: 'door', short: 'Secret health title', text: 'Secret health text' },
        { kind: 'door', summary: 'Secret' },
      ],
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

// What the board lists as closed in the last day (the cancelled one is no ship)
const AT = '2026-01-01T12:00:00.000Z'
const ago = (min: number) => new Date(Date.parse(AT) - min * 60000).toISOString()
const flowBoard = {
  at: AT,
  closedRecently: [
    { id: 'issue_1', repo: 'dotfiles', title: 'Secret', outcome: 'done', closedAt: ago(30) },
    { id: 'issue_2', repo: 'weatherorb', title: 'Secret', outcome: 'done', closedAt: ago(59) },
    { id: 'issue_3', repo: 'dotfiles', title: 'Secret', outcome: 'healed', closedAt: ago(90) },
    { id: 'issue_4', repo: 'argo', title: 'Secret', outcome: 'cancelled', closedAt: ago(120) },
    { id: 'issue_5', repo: 'basalt-ui', title: 'Secret', outcome: 'done', closedAt: ago(330) },
  ],
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

test("parseOverview: the projects of the open Issues by word (the card's own, else its stored state), as names only", () => {
  const o = lib.parseOverview(
    JSON.stringify({
      counts: { work: workBody({ running: 2 }) },
      issues: [
        { id: 7, state: 'working', repoName: 'dotfiles', phase: 'building', title: 'Secret' },
        { id: 8, state: 'queued', repoName: 'dotfiles', phase: 'queued', work: { word: 'ready', split: 'seat' } },
        { id: 12, state: 'queued', repoName: 'iris', work: { word: 'held', split: 'issue' } },
        { id: 10, state: 'waiting', repoName: 'iris', summary: 'Secret', work: { word: 'paused', split: 'you' } },
        { id: 11, state: 'watching', repoName: 'argo' },
        { id: 13, state: 'queued', repoName: 'home' }, // a queued card without its word is in no list
        { id: 'x', state: 'working' },
        { id: 9, state: 'working' },
      ],
    }),
  )
  expect(o.projects).toEqual({
    running: ['dotfiles', '?'],
    paused: ['iris'],
    ready: ['dotfiles'],
    held: ['iris'],
    checking: ['argo'],
  })
  expect(JSON.stringify(o)).not.toContain('Secret')
  expect(lib.parseProjects(null)).toEqual(noProjects)
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

test('parseFlow: the work counts of the columns and which projects are red', () => {
  const f = lib.parseFlow(JSON.stringify(flowBoard))
  // two working; of seven queued, a chain, a line and a drain are Held and no kind at all is Ready (a free seat)
  expect(f.work).toEqual({
    ...zeroWork,
    running: 2,
    ready: 2,
    held: 5,
    split: {
      ...zeroWork.split,
      ready: { seat: 2, host: 0, repo: 0, account: 0 },
      held: { issue: 2, line: 2, drain: 1, spec: 0, settling: 0 },
    },
  })
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
  expect(lib.parseFlow('{"states":{}}')).toMatchObject({ red: [], running: null, work: zeroWork })
  expect(lib.parseFlow('{"states":{"queued":{"issues":[null,5,{"queue":{"kind":7}}]}}}').work.split.ready).toEqual({
    seat: 1,
    host: 0,
    repo: 0,
    account: 0,
  })
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

const essentials = () => ({
  ...full(),
  overview: lib.parseOverview(
    JSON.stringify({
      counts: {
        work: workBody({
          running: 2,
          paused: 1,
          ready: 2,
          held: 5,
          checking: 1,
          split: {
            paused: { you: 1, timer: 0, issue: 0, stalled: 0 },
            ready: { seat: 2, host: 0, repo: 0, account: 0 },
            held: { issue: 2, line: 2, drain: 1, spec: 0, settling: 0 },
          },
        }),
        asks: 1,
        humanQueue: 0,
        health: 0,
      },
      health: [],
      issues: [
        { id: 30, state: 'working', repoName: 'weatherorb', phase: 'building', title: 'Secret' },
        { id: 31, state: 'working', repoName: 'dotfiles', phase: 'waiting for your review', summary: 'Secret' },
        { id: 32, state: 'waiting', repoName: 'iris', work: { word: 'paused', split: 'you' } },
        { id: 50, state: 'watching', repoName: 'argo', work: { word: 'checking', split: null } },
        ...[
          ['weatherorb', 'held', 'line'],
          ['weatherorb', 'held', 'line'],
          ['dotfiles', 'ready', 'seat'],
          ['basalt-ui', 'held', 'issue'],
          ['iris', 'held', 'issue'],
          ['argo', 'held', 'drain'],
          ['home', 'ready', 'seat'],
        ].map(([repoName, word, split], i) => ({ id: 40 + i, state: 'queued', repoName, work: { word, split } })),
      ],
    }),
  ),
  flow: lib.parseFlow(JSON.stringify(flowBoard)),
  machine: hostMachine(),
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

test('the bar: short items left to right, no host and no uptime, no list of leads', () => {
  const m = lib.glanceModel(essentials())
  expect(m.items.map((i: any) => [i.key, i.label, i.value])).toEqual([
    ['needs', 'Needs you', '1'],
    ['running', 'Running', '2'],
    ['paused', 'Paused', '1'],
    ['ready', 'Ready', '2'],
    ['held', 'Held', '5'],
    ['checking', 'Checking', '1'],
    ['shipped', 'Ship', '89'],
    ['production', 'Prod', '3'],
  ])
  // the Console strip's order, Checking last of them and quiet
  expect(itemOf(m, 'checking').tone).toBe('dim')
  expect(itemOf(m, 'needs').tone).toBe('bad')
  expect(itemOf(m, 'production')).toMatchObject({ dot: 'bad', tone: 'bad' })
  // the host is the mini's chip in jk-status: the bar has no CPU, RAM or Load item, and no popover for them
  expect(m.items.some((i: any) => ['cpu', 'ram', 'load'].includes(i.key))).toBe(false)
  expect(Object.keys(m.details).sort()).toEqual([
    'checking',
    'health',
    'held',
    'needs',
    'paused',
    'production',
    'ready',
    'running',
    'shipped',
  ])
  // never a ratio like 15/36, never a lead of its own
  expect(m.items.every((i: any) => !i.value.includes('/'))).toBe(true)
  expect(m.items.some((i: any) => /lead|#\d/i.test(`${i.label} ${i.value}`))).toBe(false)
})

test('the bar: an item at 0 is dimmed; Health is on the bar only above 0', () => {
  const quiet = lib.glanceModel({
    ...essentials(),
    needs: lib.parseNeeds(needs({})),
    overview: lib.parseOverview(JSON.stringify({ counts: { work: { running: 3 } } })),
  })
  expect(quiet.items.filter((i: any) => i.dim).map((i: any) => i.key)).toEqual([
    'needs',
    'paused',
    'ready',
    'held',
    'checking',
  ])
  expect(quiet.items.some((i: any) => i.key === 'health')).toBe(false) // 0 lines: no item
  expect(lib.glanceModel({ ...essentials(), overview: null }).items.some((i: any) => i.key === 'health')).toBe(false)
  const lines = lib.glanceModel(full())
  expect(itemOf(lines, 'health')).toMatchObject({ label: 'Health', value: '2', tone: 'warn', dot: 'warn', dim: false })
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

test('the host for the mini: load as a percent of its ceiling, the tone of the worse of load and swap', () => {
  const host = (machine: unknown) => lib.glanceModel({ ...essentials(), machine }).host
  const m = (l: number, swap: number, ceiling: number | null = 36) =>
    lib.parseMachine(
      JSON.stringify({
        load: l,
        loadCeiling: ceiling,
        memory: { swapUsedPct: swap },
        memoryCeilings: { swapUsedPct: 75 },
      }),
    )
  expect(host(m(14.8, 2.6))).toMatchObject({ load: 14.8, loadCeiling: 36, loadPct: 41, tone: 'neutral' })
  expect(host(m(27, 2))).toMatchObject({ loadPct: 75, tone: 'warn' })
  expect(host(m(36, 2))).toMatchObject({ loadPct: 100, tone: 'bad' })
  expect(host(m(10, 80))).toMatchObject({ loadPct: 28, tone: 'bad' }) // swap past its ceiling stops new leads too
  expect(host(m(10, 2, null))).toMatchObject({ load: 10, loadCeiling: null, loadPct: null, tone: 'neutral' })
  expect(host(null)).toBeNull()
  expect(lib.hostOf(null)).toBeNull()
  // it is in the shared state the bar publishes: jk-status reads it from there
  expect(JSON.stringify(lib.glanceModel(essentials()).host)).toBe(
    '{"load":15,"loadCeiling":36,"loadPct":42,"swapPct":3,"swapCeiling":75,"tone":"neutral"}',
  )
})

test('the popovers: a row per project with its count, each a link to the Console page of that project', () => {
  const m = lib.glanceModel(essentials())
  expect(m.details.needs).toMatchObject({ title: 'Needs you · 1', tone: 'bad', link: `${base}/needs-you?item=it1` })
  expect(rowsOf(m, 'needs')).toEqual([{ text: 'item', right: '1m', link: `${base}/needs-you?item=it1` }])
  // Running: the projects, the busiest first, then the change against 7 days ago; the title keeps the Flow page
  expect(m.details.running.title).toBe('Running · 2')
  expect(m.details.running.link).toBe(`${base}/flow?state=running`)
  expect(rowsOf(m, 'running')).toEqual([
    { text: 'dotfiles', right: '1', link: `${base}/projects/dotfiles` },
    { text: 'weatherorb', right: '1', link: `${base}/projects/weatherorb` },
    { text: 'Change in 7 days', right: '▲ +2', tone: 'good' },
  ])
  // Paused: by who it waits for, then its projects
  expect(m.details.paused.title).toBe('Paused · 1')
  expect(m.details.paused.link).toBe(`${base}/flow?state=paused`)
  expect(rowsOf(m, 'paused')).toEqual([
    { text: 'on you', right: '1', link: `${base}/flow?state=paused` },
    { text: 'iris', right: '1', link: `${base}/projects/iris` },
    { text: 'Change in 7 days', right: '▲ +3', tone: 'bad' },
  ])
  // Ready: the limit that binds it; Held: what keeps it from starting; the trend of both is Not started
  expect(m.details.ready.link).toBe(`${base}/flow?state=ready`)
  expect(rowsOf(m, 'ready').map((r: any) => [r.text, r.right])).toEqual([
    ['a free seat', '2'],
    ['dotfiles', '1'],
    ['home', '1'],
    ['Not started, change in 7 days', '▲ +9'],
  ])
  expect(m.details.held.title).toBe('Held · 5')
  expect(m.details.held.link).toBe(`${base}/flow?state=held`)
  expect(rowsOf(m, 'held').map((r: any) => [r.text, r.right])).toEqual([
    ['behind another Issue', '2'],
    ['the line is red', '2'],
    ['drained', '1'],
    ['weatherorb', '2'],
    ['argo', '1'],
    ['basalt-ui', '1'],
    ['iris', '1'],
    ['Not started, change in 7 days', '▲ +9'],
  ])
  expect(rowsOf(m, 'held')[0].link).toBe(`${base}/chain`)
  expect(rowsOf(m, 'held')[3].link).toBe(`${base}/projects/weatherorb`)
  expect(m.details.checking.title).toBe('Checking · 1')
  expect(m.details.checking.link).toBe(`${base}/flow?state=checking`)
  expect(rowsOf(m, 'checking')).toEqual([
    { text: 'argo', right: '1', link: `${base}/projects/argo` },
    { text: 'Change in 7 days', right: '– 0', tone: 'neutral' },
  ])
  expect(m.details.production.title).toBe('Production · 3 red')
  expect(rowsOf(m, 'production')[0]).toEqual({
    text: 'weatherorb',
    right: '#30',
    tone: 'bad',
    link: `${base}/issues/30`,
  })
})

test('the Shipped popover: the last 24 hours and 7 days by the hour, 30 days by the day, the projects of the day under them', () => {
  const m = lib.glanceModel(essentials())
  const d = m.details.shipped
  expect(d.title).toBe('Shipped in the last day · 89')
  expect(d.link).toBe(`${base}/flow`)
  const [day, week, month] = d.chart
  expect(d.chart).toHaveLength(3)
  // no daily bars for the 7 days: both short windows are hourly
  expect(d.chart.map((c: any) => [c.caption, c.values.length])).toEqual([
    ['Last 24 hours', 24],
    ['Last 7 days by the hour', 168],
    ['Last 30 days by the day', 30],
  ])
  // the 24 hours are the newest 24 of the 168, the newest hour last
  expect(day.values).toEqual(trend.trend.shippedHourly.slice(-24))
  expect(week.values).toEqual(trend.trend.shippedHourly)
  expect(month.values).toEqual(trend.trend.shippedDaily30)
  expect(day.right).toBe(String(day.values.reduce((a: number, b: number) => a + b, 0)))
  expect(week.right).toMatch(/^\d+ ▲ \+616$/)
  expect(month.right).toBe('435')
  // the projects that shipped in the last day: done or healed only, the busiest first
  expect(rowsOf(m, 'shipped')).toEqual([
    { text: 'dotfiles', right: '2', link: `${base}/projects/dotfiles` },
    { text: 'basalt-ui', right: '1', link: `${base}/projects/basalt-ui` },
    { text: 'weatherorb', right: '1', link: `${base}/projects/weatherorb` },
  ])
  // the height holds the three charts
  expect(d.height).toBe(lib.popupHeight(3, lib.chartHeight(3)))
  expect(d.height).toBeGreaterThan(lib.popupHeight(3))
  // a series the read does not have is not drawn; without the read, none
  const noHourly = lib.glanceModel({
    ...essentials(),
    flow: lib.parseFlow(JSON.stringify({ trend: { ...trend.trend, shippedHourly: [1, 2] }, states: {} })),
  })
  expect(noHourly.details.shipped.chart.map((c: any) => c.caption)).toEqual(['Last 30 days by the day'])
  expect(lib.glanceModel({ ...essentials(), flow: null }).details.shipped).toMatchObject({
    rows: [{ text: 'No trend yet' }],
  })
  expect(lib.glanceModel({ ...essentials(), flow: null }).details.shipped.chart).toBeUndefined()
  expect(lib.shippedProjectsOf([{ outcome: 'done', repo: 'x' }, { outcome: 'dropped', repo: 'y' }, null])).toEqual([
    { project: 'x', count: 1 },
  ])
})

test('the popovers: health by kind only, no uptime', () => {
  const m = lib.glanceModel(full())
  expect(m.details.health.title).toBe('Health · 2')
  expect(rowsOf(m, 'health')).toEqual([{ text: 'door', right: '2', tone: 'warn' }])
  expect(lib.healthRows(null)).toEqual([])
})

test('every popover sits fully above its item: the bottom edge POPUP_GAP over the item, clamped to the window', () => {
  const place = (x: number, width: number, height: number, windowWidth: number | null = null) =>
    lib.placePopup({ item: { x, y: 972, width }, width: lib.POPUP_W, height, windowWidth })
  for (const height of [60, 128, 224, lib.WORST_POPUP_H]) {
    for (const [x, width] of [
      [12, 60],
      [200, 70],
      [560, 70],
    ]) {
      const at = place(x, width, height)
      // never covers the item: the popover's bottom edge is POPUP_GAP over the item's top
      expect(at.y + height, `h ${height} x ${x}`).toBeLessThanOrEqual(972 - lib.POPUP_GAP)
      expect(at.y).toBeGreaterThanOrEqual(lib.EDGE)
      expect(at.x).toBeGreaterThanOrEqual(lib.EDGE)
    }
  }
  // centred over a middle item
  expect(place(400, 80, 100)).toEqual({ x: 400 + 40 - lib.POPUP_W / 2, y: 972 - 100 - lib.POPUP_GAP })
  // the first item at the left end: pushed in from the edge, not off the window
  expect(place(4, 40, 100).x).toBe(lib.EDGE)
  // the last item at the right end of a known window: pulled back inside it
  const right = place(1700, 60, 100, 1760)
  expect(right.x + lib.POPUP_W).toBeLessThanOrEqual(1760 - lib.EDGE)
  expect(place(1700, 60, 100, 1760).x).toBe(1760 - lib.EDGE - lib.POPUP_W)
  // an unknown window width leaves the right side alone
  expect(place(1700, 60, 100).x).toBe(1700 + 30 - lib.POPUP_W / 2)
  // the overlay spec carries it, with the item and the height for a re-placement
  const spec = lib.popupSpec({ kind: 'detail', item: 'running' }, { x: 100, y: 972, width: 60 }, 120)
  expect(spec).toMatchObject({ mod: 'jk-glance', kind: 'popup', frame: 'none', width: lib.POPUP_W, height: 120 })
  expect(spec.at).toEqual({
    x: 100 + 30 - lib.POPUP_W / 2 < lib.EDGE ? lib.EDGE : 100 + 30 - lib.POPUP_W / 2,
    y: 972 - 120 - lib.POPUP_GAP,
  })
  expect(spec.props).toEqual({ kind: 'detail', item: 'running', anchor: { x: 100, y: 972, width: 60 }, height: 120 })
})

test('the sidebar block is one line: Needs you and the lead count', () => {
  expect(lib.glanceModel(essentials()).side).toMatchObject({
    text: 'Needs you · 1 · 2 leads',
    tone: 'bad',
    link: `${base}/needs-you?item=it1`,
  })
  const quiet = lib.glanceModel({
    ...essentials(),
    overview: lib.parseOverview(JSON.stringify({ counts: { work: workBody({ running: 1 }) } })),
  })
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
  expect(JSON.stringify(essentials().overview.projects.running)).toBe('["weatherorb","dotfiles"]')
})

test('no retired state word is drawn: item labels, titles, rows and tooltips', () => {
  const m = lib.glanceModel(essentials())
  const drawn = JSON.stringify([
    m.items.map((i: any) => [i.label, i.tip]),
    Object.values(m.details).map((d: any) => [d.title, d.rows.map((r: any) => [r.text, r.right])]),
    m.side,
  ])
  expect(drawn).not.toMatch(/queued|waiting|working|watching|settling/i)
  expect(m.items.map((i: any) => i.label).slice(0, 6)).toEqual([
    'Needs you',
    'Running',
    'Paused',
    'Ready',
    'Held',
    'Checking',
  ])
})

test('the model degrades per part', () => {
  // no board read: production is unknown, not green, and shipped has no figure
  const noFlow = lib.glanceModel({ ...essentials(), flow: null })
  expect(itemOf(noFlow, 'production')).toMatchObject({ value: '', dot: 'dim' })
  expect(noFlow.details.production.title).toBe('Production · –')
  expect(itemOf(noFlow, 'shipped').value).toBe('–')
  // the split comes from the overview's counts; the trend row needs the board
  expect(rowsOf(noFlow, 'ready').map((r: any) => r.text)).toEqual(['a free seat', 'dotfiles', 'home'])
  // a trend older than 10 min is dropped with the board
  expect(itemOf(lib.glanceModel({ ...essentials(), flowAt: NOW - 11 * 60000 }), 'production').dot).toBe('dim')
  // no overview: the board's own work counts stand in, health is unknown
  const noOverview = lib.glanceModel({ ...essentials(), overview: null })
  expect(
    noOverview.items
      .filter((i: any) => ['running', 'paused', 'ready', 'held', 'checking'].includes(i.key))
      .map((i: any) => i.value),
  ).toEqual(['2', '0', '2', '5', '0'])
  expect(itemOf(noOverview, 'health')).toBeUndefined()
  // no host read: no host for the mini's chip
  expect(lib.glanceModel({ ...essentials(), machine: null }).host).toBeNull()
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

test('projectRows: by project, the busiest first, a count, a link to the project and nothing of an Issue', () => {
  const projects = [...[1, 2, 3].map(() => 'software-factory'), 'dotfiles', 'argo']
  expect(lib.projectRows(projects, base)).toEqual([
    { text: 'software-factory', right: '3', link: `${base}/projects/software-factory` },
    { text: 'argo', right: '1', link: `${base}/projects/argo` },
    { text: 'dotfiles', right: '1', link: `${base}/projects/dotfiles` },
  ])
  expect(lib.projectRows([], base)).toEqual([])
  expect(lib.projectRows(['a b'], base)[0].link).toBe(`${base}/projects/a%20b`)
  expect(lib.projectRows(['x'], '')[0].link).toBeNull()
})

test('splitRows: one row per non-empty split, the largest first; every queue kind lands where the contract puts it', () => {
  const work = lib.workFromColumns({
    queued: {
      issues: [
        'chain',
        'drain',
        'doctor',
        'boot',
        'load',
        'memory',
        'lane',
        'window',
        'cap',
        'claim',
        'spec',
        'line',
        'finalizing',
      ].map((kind) => ({ queue: { kind } })),
    },
  })
  expect(work.split.ready).toEqual({ seat: 0, host: 4, repo: 3, account: 1 })
  expect(work.split.held).toEqual({ issue: 1, line: 1, drain: 1, spec: 1, settling: 1 })
  expect(lib.splitRows(work, 'ready', base)).toEqual([
    { text: 'the host', right: '4', link: `${base}/flow?state=ready` },
    { text: "the repo's claims", right: '3', link: `${base}/flow?state=ready` },
    { text: "the account's window", right: '1', link: `${base}/flow?state=ready` },
  ])
  expect(lib.splitRows(work, 'held', base).map((r: any) => r.text)).toEqual([
    'behind another Issue',
    'the line is red',
    'drained',
    'an open Spec',
    'being settled',
  ])
  expect(lib.splitRows(work, 'held', base)[0].link).toBe(`${base}/chain`)
  expect(lib.splitRows(lib.parseWork(workBody()), 'paused', base).map((r: any) => r.text)).toEqual(['on you'])
  expect(lib.splitRows(null, 'ready', base)).toEqual([])
  expect(lib.splitRows(zeroWork, 'ready', base)).toEqual([])
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

const WORK_WORDS = ['running', 'paused', 'ready', 'held', 'checking']

// The tallest a board can get: every list far past its cap, every figure at its widest.
const worstCase = () => {
  const kinds = ['chain', 'drain', 'doctor', 'boot', 'load', 'memory', 'lane', 'window', 'cap', 'claim', 'spec']
  const board = {
    at: AT,
    closedRecently: Array.from({ length: 40 }, (_, i) => ({
      repo: `ship${i}`,
      outcome: 'done',
      closedAt: ago(i * 30),
    })),
    trend: {
      states: {},
      shipped: [999, 999, 999, 999, 999, 999, 999],
      shippedBefore: 1,
      shippedHourly: Array(168).fill(9),
      shippedDaily30: Array(30).fill(99),
    },
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
        counts: {
          work: {
            running: 99,
            paused: 99,
            ready: 99,
            held: 99,
            checking: 99,
            split: {
              paused: { you: 25, timer: 25, issue: 25, stalled: 24 },
              ready: { seat: 25, host: 25, repo: 25, account: 24 },
              held: { issue: 20, line: 20, drain: 20, spec: 20, settling: 19 },
            },
          },
          asks: 99,
          humanQueue: 99,
          health: 99,
        },
        health: Array.from({ length: 12 }, (_, i) => ({ kind: `kind${i}` })),
        issues: WORK_WORDS.flatMap((word, s) =>
          Array.from({ length: 30 }, (_, i) => ({
            id: s * 100 + i + 1,
            state: 'queued',
            repoName: `project-${i}`,
            work: { word, split: null },
          })),
        ),
      }),
    ),
    flow: lib.parseFlow(JSON.stringify(board)),
    machine: lib.parseMachine(
      '{"load":360,"loadCeiling":36,"memory":{"swapUsedPct":99},"memoryCeilings":{"swapUsedPct":75}}',
    ),
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
    expect(d.height, key).toBe(lib.popupHeight(d.rows.length, d.chart ? lib.chartHeight(d.chart.length) : 0))
    expect(d.height, key).toBeLessThanOrEqual(lib.WORST_POPUP_H)
  }
  expect(m.details.needs.rows.at(-1).text).toMatch(/^\+\d+ more$/)
  expect(m.details.health.rows.at(-1).text).toMatch(/^\+\d+ more$/)
  for (const word of ['running', 'paused', 'ready', 'held', 'checking']) {
    expect(m.details[word].rows.at(-1).text, word).toMatch(/^\+\d+ more$/)
  }
  // the Shipped popover lists at most SHIPPED_ROWS projects under its two charts
  expect(m.details.shipped.rows).toHaveLength(lib.SHIPPED_ROWS)
  expect(m.details.shipped.rows.at(-1).text).toMatch(/^\+\d+ more$/)
  expect(m.details.shipped.chart).toHaveLength(3)
  // with a trend, its row keeps its place after the capped projects
  const withTrend = lib.glanceModel({ ...worstCase(), flow: lib.parseFlow(JSON.stringify(trend)) })
  expect(withTrend.details.running.rows).toHaveLength(lib.MAX_ROWS)
  expect(withTrend.details.running.rows.at(-2).text).toMatch(/^\+\d+ more$/)
  expect(withTrend.details.running.rows.at(-1).text).toBe('Change in 7 days')
  // the splits (up to five rows) leave the projects what is left of the eight rows
  expect(withTrend.details.held.rows).toHaveLength(lib.MAX_ROWS)
  expect(withTrend.details.held.rows.slice(0, 5).map((r: any) => r.text)).toEqual([
    'behind another Issue',
    'the line is red',
    'drained',
    'an open Spec',
    'being settled',
  ])
  expect(withTrend.details.held.rows.at(-1).text).toBe('Not started, change in 7 days')
})

test('the bar fits its block at its widest', () => {
  const m = lib.glanceModel(worstCase())
  expect(m.items).toHaveLength(9)
  expect(lib.barWidth(m.items)).toBeLessThanOrEqual(lib.BAR_W)
  // the usual bar is narrower than the worst one
  expect(lib.barWidth(lib.glanceModel(essentials()).items)).toBeLessThan(lib.barWidth(m.items))
})
