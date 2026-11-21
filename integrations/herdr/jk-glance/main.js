// jk-glance — the factory at a glance, in three roles of one mod (props():
//   { bar: true }                a status-bar segment: short items, left to right: Needs you, Running, Paused, Ready, Held,
//                                Checking (the Console strip's words and figures), Ship (today), Prod, Health (only above 0). The host (CPU, RAM, load) and Uptime Kuma are the mini's chip in
//                                jk-status, not here. It polls the factory and publishes shared("jk.factory.glance"), with the
//                                host's load as a percent of its ceiling in `host`; a click on an item opens its popover.
//   { kind: "detail", item }     the popover (an overlay popup of this same mod): the detail of one item, read from
//                                shared("jk.factory.glance"), each row a link into the Console. It never polls.
//   no props                     the sidebar block, one line: Needs you and the lead count (GLANCE_H px high). It polls too:
//                                keep it out of a layout that already has the bar.
// A click on a row opens the factory Console at that place in the default browser (`open` on this computer). Read-only:
// links, no controls. No per-lead row anywhere: the leads show as a count, by project in the popover.
// Every 15 s ONE call on the mini reads `factory read needs`, `read overview` (counts, health, the open Issues),
// `read issues`, `read sessions` and `read machine` (token through secrets-run, never argv) and the Console's base URL
// (FACTORY_CONSOLE_URL in the mini's ~/.config/factory/env). Every 60 s a second call reads `factory read flow`: the 7-day
// trend, the last day's shipped Issues (by hour and project), the work counts and the projects whose
// production is red. Each part parses on
// its own and keeps its last good answer; no good poll for 2 min dims the bar. API text is data, never interpreted; no ticket
// title or summary is ever drawn (an item shows as its kind, repo and age, a project as its name and a count).
// The 15 s poll also publishes shared("jk.factory.terminals"), the feed jk-pane's header and the tab's Console link show
// (only when it changed).
import { View, div } from 'gpui-kit'
import { v_flex, h_flex } from 'gpui-base'
import { exec, theme, machines, shared, setShared, props as rawProps, openOverlay, closeOverlay } from 'herdr'

// The token comes from the factory's own env template through secrets-run, never argv.
const SECRETS = `PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH"; cd ~/SourceRoot/software-factory && secrets-run run --env-file=.env.tpl --`
// `--format json` goes before the subcommand. Parts are split on a line holding only @@.
const READS =
  'factory --format json read needs; echo; echo @@; factory --format json read overview; echo; echo @@; ' +
  'factory --format json read issues --state all --limit 40; echo; echo @@; factory --format json read sessions --live; echo; ' +
  'echo @@; factory --format json read machine; echo'
const URL_READ = `grep -m1 '^FACTORY_CONSOLE_URL=' "$HOME/.config/factory/env" | cut -d= -f2-`
const CMD = `{ ${SECRETS} sh -c '${READS}'; } 2>/dev/null; echo @@; ${URL_READ} 2>/dev/null`
// The Flow page's own read: the 7-day series live in its `trend`, the work counts in its `work`, the queue kinds in its columns.
const FLOW_CMD = `{ ${SECRETS} sh -c 'factory --format json read flow'; } 2>/dev/null`

const POLL_MS = 15000
const FLOW_MS = 60000

// <glance> pure helpers (integrations/herdr/jk-glance.test.ts runs this block on its own: no imports, no gpui)
const asArray = (v) => (Array.isArray(v) ? v : [])
const num = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
const sum = (values) => values.reduce((total, n) => total + n, 0)

const ADDR = /^t[0-9a-z]+$/

// No good poll for 2 min dims the bar; a trend older than 10 min is dropped.
const STALE_MS = 2 * 60000
const FLOW_STALE_MS = 10 * 60000

// The Console's page for a health line: it has none yet. Set the path (e.g. '/health') when it gets one.
const HEALTH_PATH = null

// The sidebar block, one line: its height in px. The layout's block (dotfiles `config/herdr-app/layouts/jk.json`, block
// `glance`, `size.px`) is this high, or gone once the bar carries the glance.
const GLANCE_H = 28

// The bar: the width in px the block needs for its worst case (`barWidth`, held by a test). The layout gives the bar block
// at least this; a status row is 28 px high.
const BAR_W = 608
const BAR_H = 28
// Text metrics for the width estimate: the bar's 11.8 px text is at most this wide per character; an item has 3 px padding
// each side, a dot is 6 px and 4 px from its text, a value sits 4 px from its label, the items sit 1 px apart and a
// separator takes 7 px with its gap.
const CHAR_W = 6.2
const ITEM_PAD = 6
const DOT_W = 10
const VALUE_GAP = 4
const ITEM_GAP = 1
const SEP_W = 7

// The popover: a card of POPUP_W px with a title row, an optional chart and at most MAX_ROWS rows, each ROW_H px high, 2 px apart.
const POPUP_W = 340
const POPUP_PAD = 12
const TITLE_H = 22
const ROW_H = 20
const ROW_GAP = 2
const MAX_ROWS = 8
// The Shipped popover's charts: three bar charts (the last 24 hours and the last 7 days by the hour, the last 30 days by the
// day), each a caption row over BAR_AREA_H px of bars.
const BAR_AREA_H = 34
const chartHeight = (charts) => charts * (ROW_H + ROW_GAP + BAR_AREA_H) + (charts - 1) * ROW_GAP
// The Shipped popover lists the projects of the last day under its charts, at most this many rows.
const SHIPPED_ROWS = 5
// The gap between a popover's bottom edge and the item it belongs to, and the margin to the window's edges.
const POPUP_GAP = 10
const EDGE = 8

// The popover's height for a detail: what the card draws, so the overlay can sit its bottom edge above the item.
const popupHeight = (rows, extra = 0) =>
  2 * POPUP_PAD + 2 + TITLE_H + rows * (ROW_H + ROW_GAP) + (extra ? extra + ROW_GAP : 0)
const WORST_POPUP_H = popupHeight(MAX_ROWS, chartHeight(3))

// Where a popover's top left goes: centred over its item, its bottom edge POPUP_GAP px above the item's top (so it never
// covers the item), at least EDGE px from the window's left and top edge, and EDGE px from the right edge when the window's
// width is known. `item` is the item's bounds {x, y, width}.
function placePopup({ item, width, height, windowWidth = null }) {
  const centred = Math.round(item.x + item.width / 2 - width / 2)
  const right = Number.isFinite(windowWidth) ? windowWidth - EDGE - width : Infinity
  return {
    x: Math.max(EDGE, Math.min(centred, right)),
    y: Math.max(EDGE, Math.round(item.y - height - POPUP_GAP)),
  }
}

// The overlay for a popover: frameless (the card draws its own frame, so the measured card is the popup), POPUP_W wide,
// `height` high, placed by placePopup. The item's bounds and the height go along in the props, for a re-placement.
function popupSpec(props, item, height, windowWidth = null) {
  return {
    mod: 'jk-glance',
    kind: 'popup',
    frame: 'none',
    width: POPUP_W,
    height,
    at: placePopup({ item, width: POPUP_W, height, windowWidth }),
    props: { ...props, anchor: item, height },
  }
}

// "needs @@ overview @@ issues @@ sessions @@ machine @@ url": each part is null when it does not parse.
function parseNeeds(text) {
  let d
  try {
    d = JSON.parse(String(text ?? ''))
  } catch {
    return null
  }
  if (!d || typeof d !== 'object' || !Array.isArray(d.items)) return null
  const c = d.counts && typeof d.counts === 'object' ? d.counts : {}
  const counts = {
    decision: num(c.decision),
    review: num(c.review),
    errand: num(c.errand),
    held_signal: num(c.held_signal),
    long_wait: num(c.long_wait),
  }
  // Only what a row draws or links: no title, summary or text of an item is kept.
  const items = d.items
    .filter((i) => i && typeof i === 'object')
    .map((i) => ({
      id: i.id,
      kind: typeof i.kind === 'string' ? i.kind.slice(0, 24) : null,
      repo: typeof i.repo === 'string' ? clip(i.repo, 40) : null,
      issue: typeof i.issue === 'string' ? i.issue : null,
      ageMs: i.ageMs,
    }))
  return { items, counts }
}

// Where work stands: the five words and the splits of three of them (packages/contract/src/work-words.ts, copied: the mod
// has no imports). Stored state names appear only as data keys here.
const WORK_WORDS = ['running', 'paused', 'ready', 'held', 'checking']
const SPLITS = {
  paused: ['you', 'timer', 'issue', 'stalled'],
  ready: ['seat', 'host', 'repo', 'account'],
  held: ['issue', 'line', 'drain', 'spec', 'settling'],
}
const PAUSED_BY_WAIT = {
  decision: 'you',
  review: 'you',
  errand: 'you',
  timer: 'timer',
  dependency: 'issue',
  external: 'issue',
}
const READY_BY_QUEUE = {
  load: 'host',
  memory: 'host',
  boot: 'host',
  doctor: 'host',
  claim: 'repo',
  lane: 'repo',
  cap: 'repo',
  window: 'account',
}
const HELD_BY_QUEUE = {
  chain: 'issue',
  line: 'line',
  drain: 'drain',
  spec: 'spec',
  finalizing: 'settling',
  unknown_project: 'settling',
}

const emptyWork = () => ({
  running: 0,
  paused: 0,
  ready: 0,
  held: 0,
  checking: 0,
  split: Object.fromEntries(
    Object.entries(SPLITS).map(([w, keys]) => [w, Object.fromEntries(keys.map((k) => [k, 0]))]),
  ),
})

// The server's `counts.work` (and the flow's `work`): five counts and three splits, numbers only. Null when absent.
function parseWork(w) {
  if (!w || typeof w !== 'object') return null
  const out = emptyWork()
  for (const word of WORK_WORDS) out[word] = num(w[word])
  for (const [word, keys] of Object.entries(SPLITS)) {
    for (const k of keys) out.split[word][k] = num(w.split?.[word]?.[k])
  }
  return out
}

// The same counts from the flow's columns, when its `work` is absent: workOf of the contract over each Issue's wait reason
// and queue kind.
function workFromColumns(column) {
  if (!column || typeof column !== 'object') return null
  const out = emptyWork()
  const add = (word, split) => {
    out[word]++
    if (split) out.split[word][split]++
  }
  const issues = (state) => asArray(column[state]?.issues).filter((i) => i && typeof i === 'object')
  out.running = issues('working').length
  out.checking = issues('watching').length
  for (const i of issues('waiting')) add('paused', PAUSED_BY_WAIT[i.waitReason] ?? 'stalled')
  issues('settling').forEach(() => add('held', 'settling'))
  for (const i of issues('queued')) {
    const kind = typeof i.queue?.kind === 'string' ? i.queue.kind : null
    if (kind && HELD_BY_QUEUE[kind]) add('held', HELD_BY_QUEUE[kind])
    else add('ready', (kind && READY_BY_QUEUE[kind]) || 'seat')
  }
  return out
}

// Counts, the kinds of the health lines (never their words) and the project of each open Issue by word. Nothing else of the
// overview is kept (its uptime roll-up is Uptime Kuma's chip in jk-status).
function parseOverview(text) {
  let d
  try {
    d = JSON.parse(String(text ?? ''))
  } catch {
    return null
  }
  if (!d || typeof d !== 'object' || !d.counts || typeof d.counts !== 'object') return null
  const c = d.counts
  return {
    work: parseWork(c.work) ?? emptyWork(),
    asks: num(c.asks),
    humanQueue: num(c.humanQueue),
    health: num(c.health),
    healthKinds: asArray(d.health).map((h) => (typeof h?.kind === 'string' ? h.kind.slice(0, 32) : 'other')),
    projects: parseProjects(d.issues),
  }
}

// The open Issues as their project only (never a number, phase or words): the project name of each, per word. An Issue's
// word is its card's `work.word`; a card without one falls back to the word its stored state alone decides.
const WORD_OF_STATE = { working: 'running', waiting: 'paused', watching: 'checking' }
function parseProjects(issues) {
  const out = Object.fromEntries(WORK_WORDS.map((w) => [w, []]))
  for (const i of asArray(issues)) {
    if (!i || !Number.isInteger(i.id)) continue
    const word = WORK_WORDS.includes(i.work?.word) ? i.work.word : WORD_OF_STATE[i.state]
    if (!word) continue
    out[word].push(clip(typeof i.repoName === 'string' && i.repoName ? i.repoName : '?', 40))
  }
  return out
}

// The host's figures and the ceilings above which no new lead is admitted (`factory read machine`).
function parseMachine(text) {
  const d = parseJson(text)
  if (!d || !Number.isFinite(d.load) || !d.memory || !Number.isFinite(d.memory.swapUsedPct)) return null
  const ceiling = (v) => (Number.isFinite(v) && v > 0 ? v : null)
  return {
    load: d.load,
    loadCeiling: ceiling(d.loadCeiling),
    swapPct: d.memory.swapUsedPct,
    swapCeiling: ceiling(d.memoryCeilings?.swapUsedPct),
  }
}

function parseJson(text) {
  try {
    const d = JSON.parse(String(text ?? ''))
    return d && typeof d === 'object' ? d : null
  } catch {
    return null
  }
}

// The Flow page's trend, numbers only (the read also holds Issue titles; they never leave this function): the daily samples
// (oldest first, the last is now) of Running, Paused, Not started (Ready and Held share the stored queued and settling
// states, so the trend shows their sum) and Checking, the daily shipped counts and the week before, the shipped
// Issues by the hour of the last 7 days (168 buckets, the last is the hour ending now) and by the day of the last 30, the
// work counts, and from what closed in the last day the shipped Issues by project.
function parseFlow(text) {
  const d = parseJson(text)
  if (!d) return null
  const t = d.trend && typeof d.trend === 'object' ? d.trend : {}
  const states = t.states && typeof t.states === 'object' ? t.states : {}
  const line = (v) => (Array.isArray(v) && v.length >= 2 ? v.map(num) : null)
  const series = (v, n) => (Array.isArray(v) && v.length === n ? v.map(num) : null)
  const queued = line(states.queued)
  const settling = line(states.settling)
  const flow = {
    running: line(states.working),
    paused: line(states.waiting),
    notStarted: queued ? queued.map((n, i) => n + (settling?.[i] ?? 0)) : null,
    checking: line(states.watching),
    shipped: Array.isArray(t.shipped) && t.shipped.length ? t.shipped.map(num) : null,
    shippedBefore: Number.isFinite(t.shippedBefore) ? num(t.shippedBefore) : null,
    shippedHourly: series(t.shippedHourly, 168),
    shippedDaily30: series(t.shippedDaily30, 30),
  }
  const column = d.states && typeof d.states === 'object' ? d.states : null
  const hasTrend = Object.values(flow).some((v) => v !== null)
  if (!hasTrend && !column) return null
  return {
    ...flow,
    work: parseWork(d.work) ?? workFromColumns(column),
    shippedProjects: shippedProjectsOf(d.closedRecently),
    ...queueReasons(column),
  }
}

// What shipped in the last day (outcome done or healed, the Flow page's own rule) by project, the busiest first. Only the
// project and the outcome of a closed Issue are read, never its words.
function shippedProjectsOf(closed) {
  const byProject = new Map()
  for (const c of asArray(closed)) {
    if (!c || (c.outcome !== 'done' && c.outcome !== 'healed')) continue
    const project = typeof c.repo === 'string' && c.repo ? clip(c.repo, 40) : '?'
    byProject.set(project, (byProject.get(project) ?? 0) + 1)
  }
  return [...byProject]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([project, count]) => ({ project, count }))
}

const NOT_A_FIX_LINE = new Set(['chain', 'spec', 'finalizing', 'unknown_project'])
const LINE_MESSAGE = /^production of (\S+) is red \(Issue (\d+)\)/

// From the board's columns: the projects whose production is red (`red`: the incident that stops the line). Words of an
// Issue never leave this function. A project is red while an incident Issue is queued or working and nothing blocks it (the
// server's own rule, domains/planning/queue.ts); the queued Issues held by that line carry the same project and incident.
function queueReasons(column) {
  const red = new Map()
  const put = (project, n) => {
    if (project && !red.has(project)) red.set(project, n)
  }
  const numberOf = (id) => {
    const m = /^issue_(\d+)$/.exec(String(id ?? ''))
    return m ? Number(m[1]) : null
  }
  for (const state of ['working', 'queued']) {
    for (const i of asArray(column?.[state]?.issues)) {
      if (!i || typeof i !== 'object') continue
      const repo = typeof i.repo === 'string' ? clip(i.repo, 40) : null
      const kind = typeof i.queue?.kind === 'string' ? i.queue.kind.slice(0, 24) : null
      if (i.kind === 'incident' && !(kind && NOT_A_FIX_LINE.has(kind))) put(repo, numberOf(i.id))
      if (kind === 'line') {
        const m = LINE_MESSAGE.exec(String(i.queue.message ?? ''))
        if (m) put(clip(m[1], 40), Number(m[2]))
      }
    }
  }
  return { red: [...red].map(([project, n]) => ({ project, n })) }
}

const parseIssues = (text) => {
  const d = parseJson(text)
  return Array.isArray(d?.issues) ? d.issues.filter((c) => c && Number.isInteger(c.id)) : null
}
const parseSessions = (text) => {
  const d = parseJson(text)
  return Array.isArray(d?.sessions) ? d.sessions.filter((s) => s && typeof s.id === 'string') : null
}

function parsePoll(stdout) {
  const parts = String(stdout ?? '').split(/^@@$/m)
  const url = (parts[5] ?? '').trim().split('\n')[0].trim()
  return {
    needs: parseNeeds(parts[0]),
    overview: parseOverview(parts[1]),
    issues: parseIssues(parts[2]),
    sessions: parseSessions(parts[3]),
    machine: parseMachine(parts[4]),
    base: parts.length >= 6 ? url : null,
  }
}

// A repo's name from a session's working folder (a factory worktree resolves to its repo).
function repoOf(path) {
  const p = String(path ?? '')
    .replace(/\/\.claude\/worktrees\/.*$/, '')
    .replace(/\/+$/, '')
  return p.split('/').pop() || null
}

// What the pane header and the tab show per terminal: app terminal address (`mini/<id>`) -> the Issue's words, its state
// (the stored one, a data key) and the Console link. No ids, roles or phases: the screen
// says what the work is about, the link is where the Issue is. Only these fields are shared (shared is persisted and every
// mod re-renders on a change): no insights, no elapsed time.
function terminalsMap(issues, sessions, needs, base) {
  const byId = new Map(asArray(issues).map((c) => [c.id, c]))
  const out = {}
  const rows = asArray(sessions)
    .filter((s) => s.terminal && ADDR.test(String(s.terminal.id)))
    .sort((a, b) => String(a.terminal.id).localeCompare(String(b.terminal.id)))
  for (const s of rows) {
    const c = Number.isInteger(s.issue) ? byId.get(s.issue) : null
    // A closed Issue's lead has ended: its terminal and tab are gone, whatever the session read still says.
    if (c?.state === 'closed') continue
    out[`mini/${s.terminal.id}`] = {
      title: c?.title ?? s.title ?? null,
      summary: c?.summary ?? s.summary ?? null,
      state: c?.state ?? s.state ?? null,
      repo: c?.repoName ?? repoOf(s.repo),
      link: Number.isInteger(s.issue) ? issueLink(base, s.issue, needs) : null,
    }
  }
  return out
}

const needsTotal = (needs) => (needs ? Object.values(needs.counts).reduce((s, n) => s + n, 0) : 0)

// What waits on the owner: the overview's asks and human queue; the needs read when the overview is missing.
const needsCount = (overview, needs) => (overview ? overview.asks + overview.humanQueue : needsTotal(needs))

// The newest item: the smallest ageMs (falls back to the first listed).
function newestItem(needs) {
  const items = asArray(needs?.items)
  if (!items.length) return null
  return items.reduce(
    (best, i) => (Number.isFinite(i.ageMs) && (!Number.isFinite(best.ageMs) || i.ageMs < best.ageMs) ? i : best),
    items[0],
  )
}

const clip = (s, max) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

const needsLabel = (n) => (n > 0 ? `Needs you · ${n}` : 'Nothing waits on you')

// The Console link for a click: "needs" opens /needs-you (the item selected when one is given), "flow" opens /flow,
// "health" the health page when the Console has one. Null when the base is not an http(s) URL.
function consoleLink(base, kind, item) {
  const b = String(base ?? '')
    .trim()
    .replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s/]+/i.test(b)) return null
  if (kind === 'flow') return `${b}/flow`
  if (WORK_WORDS.includes(kind)) return `${b}/flow?state=${kind}`
  if (kind === 'project') return `${b}/projects/${encodeURIComponent(String(item ?? ''))}`
  if (kind === 'issue') return Number.isInteger(item) ? `${b}/issues/${item}` : `${b}/flow`
  if (kind === 'chain') return `${b}/chain`
  if (kind === 'health') return HEALTH_PATH ? `${b}${HEALTH_PATH}` : null
  const id = item?.id
  return `${b}/needs-you${id != null && id !== '' ? `?item=${encodeURIComponent(String(id))}` : ''}`
}

// An Issue's place in the Console: its newest Needs you item when it has one (the thing the owner has to answer), else its
// page (`/issues/<n>`). Null when the base is not an http(s) URL.
function issueLink(base, issue, needs) {
  const ref = `issue_${issue}`
  const own = { items: asArray(needs?.items).filter((i) => i.issue === ref) }
  const item = newestItem(own)
  return item ? consoleLink(base, 'needs', item) : consoleLink(base, 'issue', issue)
}

// -- the figures behind the bar: the Console's Flow page figures (apps/console/src/lib/flow.ts statsOf), the same rules.

// `series` is the trend line a word is read from; Ready and Held share the Not started one.
const KPIS = [
  { key: 'running', label: 'Running', higherIsBetter: true, series: 'running' },
  { key: 'paused', label: 'Paused', higherIsBetter: false, series: 'paused' },
  { key: 'ready', label: 'Ready', higherIsBetter: false, series: 'notStarted' },
  { key: 'held', label: 'Held', higherIsBetter: false, series: 'notStarted' },
  { key: 'checking', label: 'Checking', higherIsBetter: false, series: 'checking' },
  { key: 'shipped', label: 'Shipped this week', higherIsBetter: true },
]
const KPI_TITLE = Object.fromEntries(KPIS.map((k) => [k.key, k.label]))

// good, bad or neutral: the direction of the change times whether more is better (0 and unknown are neutral).
function toneOf(delta, higherIsBetter) {
  if (!Number.isFinite(delta) || delta === 0) return 'neutral'
  return delta > 0 === higherIsBetter ? 'good' : 'bad'
}

function deltaText(delta) {
  if (!Number.isFinite(delta)) return ''
  if (delta === 0) return '– 0'
  return delta > 0 ? `▲ +${delta}` : `▼ −${Math.abs(delta)}`
}

// The work counts the strip shows: the overview's, else the flow's (the server computes both with one function).
const workOf = (overview, flow) => overview?.work ?? flow?.work ?? null

// Per KPI: its figure and the change against 7 days ago. The figure of a word is the work count (the last trend sample of
// a word that has its own line when no count is there); the change is last sample minus first, shipped this week minus the
// week before. A part that is missing leaves its fields null.
function kpiCells(overview, flow) {
  const work = workOf(overview, flow)
  return KPIS.map((def) => {
    if (def.key === 'shipped') {
      const bars = flow?.shipped ?? null
      const value = bars ? sum(bars) : null
      const delta = bars && flow.shippedBefore !== null ? value - flow.shippedBefore : null
      return { ...def, value, delta, tone: toneOf(delta, def.higherIsBetter) }
    }
    const line = flow?.[def.series] ?? null
    const own = def.series === def.key && line ? line[line.length - 1] : null
    const value = work ? work[def.key] : own
    const delta = line ? line[line.length - 1] - line[0] : null
    return { ...def, value, delta, tone: toneOf(delta, def.higherIsBetter) }
  })
}

const healthTone = (overview) => {
  if (!overview) return 'dim'
  if (overview.health === 0) return 'good'
  const kinds = overview.healthKinds
  return kinds.length && kinds.every((k) => k === 'door') ? 'warn' : 'bad'
}

// -- the rows of a popover. Each is pure data for the render: text, an optional right text, a tone and a link.

const ageText = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const min = Math.floor(ms / 60000)
  if (min < 60) return `${Math.max(1, min)}m`
  const h = Math.floor(min / 60)
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`
}

const KIND_WORD = { held_signal: 'signal', long_wait: 'wait' }

// At most `max` rows: a longer list ends in one "+N more" row (that link, when there is one).
function capRows(rows, moreLink, max = MAX_ROWS) {
  if (rows.length <= max) return rows
  return [...rows.slice(0, max - 1), { text: `+${rows.length - max + 1} more`, tone: 'dim', link: moreLink }]
}

// The items that wait on the owner, the newest first, one row each: kind, repo, age; the link opens that item in the Console.
function needsRows(needs, base) {
  const byAge = [...asArray(needs?.items)].sort(
    (a, b) => (Number.isFinite(a.ageMs) ? a.ageMs : Infinity) - (Number.isFinite(b.ageMs) ? b.ageMs : Infinity),
  )
  return byAge.map((i) => ({
    text: [KIND_WORD[i.kind] ?? i.kind ?? 'item', i.repo].filter(Boolean).join(' · '),
    right: ageText(i.ageMs),
    link: consoleLink(base, 'needs', i),
  }))
}

// A state's projects, the busiest first, one row each: the project and its count, never an Issue of its own. A click opens
// that project's page in the Console. `reasonOf(project)` is an optional dim note between the two (Queued: what binds it).
function projectRows(projects, base, reasonOf = null) {
  const byProject = new Map()
  for (const p of asArray(projects)) byProject.set(p, (byProject.get(p) ?? 0) + 1)
  return [...byProject]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([project, count]) => ({
      text: project,
      ...(reasonOf?.(project) ? { note: reasonOf(project) } : {}),
      right: String(count),
      link: consoleLink(base, 'project', project),
    }))
}

// What each split of Paused, Ready and Held reads as (`seat`: only room in the allowance holds it).
const SPLIT_WORD = {
  paused: {
    you: 'on you',
    timer: 'on a timer',
    issue: 'on another Issue',
    stalled: 'stalled',
  },
  ready: {
    seat: 'room in the allowance',
    host: 'the host',
    repo: "the repo's claims",
    account: "the account's window",
  },
  held: {
    issue: 'behind another Issue',
    line: 'the line is red',
    drain: 'drained',
    spec: 'an open Spec',
    settling: 'being settled',
  },
}

// One row per non-empty split of a word, the largest first; the held-by-another-Issue row opens the chain. A word with no
// counts yet (null) has no rows.
function splitRows(work, word, base) {
  const split = work?.split?.[word]
  if (!split) return []
  return SPLITS[word]
    .filter((k) => split[k] > 0)
    .sort((a, b) => split[b] - split[a])
    .map((k) => ({
      text: SPLIT_WORD[word][k],
      right: String(split[k]),
      link: consoleLink(base, word === 'held' && k === 'issue' ? 'chain' : word, null),
    }))
}

// Production per project: red while an incident stops its line; each red project links to that incident's page.
function productionRows(red, base) {
  const list = asArray(red)
  return {
    rows: list.map((r) => ({
      text: r.project,
      right: r.n ? `#${r.n}` : '',
      tone: 'bad',
      link: consoleLink(base, 'issue', r.n),
    })),
    red: list.length,
  }
}

const TONE_RANK = { neutral: 0, dim: 0, good: 0, warn: 1, bad: 2 }
const worseTone = (a, b) => (TONE_RANK[b] > TONE_RANK[a] ? b : a)
// Warn from 75 % of a ceiling, red at or over it.
const ratioTone = (ratio) => (ratio >= 1 ? 'bad' : ratio >= 0.75 ? 'warn' : 'neutral')

// The host as the mini's chip in jk-status may read it (shared("jk.factory.glance").host): the one-minute load and its
// ceiling (the load above which no new lead is admitted), the load as a percent of that ceiling (null with no ceiling or no
// read), swap and its ceiling, and the tone of the worse of the two ratios. Null while `read machine` has not answered.
function hostOf(machine) {
  if (!machine) return null
  const loadRatio = machine.loadCeiling ? machine.load / machine.loadCeiling : null
  const swapRatio = machine.swapCeiling ? machine.swapPct / machine.swapCeiling : null
  return {
    load: Math.round(machine.load * 10) / 10,
    loadCeiling: machine.loadCeiling,
    loadPct: loadRatio === null ? null : Math.round(loadRatio * 100),
    swapPct: Math.round(machine.swapPct),
    swapCeiling: machine.swapCeiling,
    tone: worseTone(ratioTone(loadRatio ?? 0), ratioTone(swapRatio ?? 0)),
  }
}

// Health lines by kind, never their words.
function healthRows(overview) {
  if (!overview) return []
  const kinds = new Map()
  for (const k of overview.healthKinds) kinds.set(k, (kinds.get(k) ?? 0) + 1)
  return [...kinds].map(([kind, n]) => ({ text: kind, right: String(n), tone: kind === 'door' ? 'warn' : 'bad' }))
}

// -- the view model: every word the bar and its popovers show, in one pure object (the render only draws it, and it is what
// the bar publishes as shared("jk.factory.glance")). No Issue title, summary, number or phase enters it: the reads are parsed
// down to counts, kinds and monitor names. `link` is a URL for a click and is never drawn.

// The bar's items by group (a separator between groups): key, label, value, tone and an optional dot. `dim` greys the label
// of an item at 0. The host (CPU, RAM, load) and Uptime Kuma are not items: they are the mini's chip in jk-status, which
// reads the load as a percent of its ceiling from `host`.
function glanceModel({ needs, overview, flow, machine, base, at, now, flowAt }) {
  if (!at) return { empty: true, text: 'Factory: no data' }
  const stale = now - at > STALE_MS
  const trend = flow && now - flowAt <= FLOW_STALE_MS ? flow : null
  const unset = 'FACTORY_CONSOLE_URL is not set on the mini (~/.config/factory/env)'
  const staleTip = stale ? 'No fresh answer from the factory for 2 min' : null
  const n = needsCount(overview, needs)
  const cells = Object.fromEntries(kpiCells(overview, trend).map((c) => [c.key, c]))
  const fig = (v) => (v === null || v === undefined ? '–' : String(v))
  const prod = trend ? productionRows(trend.red, base) : null // null until the board's read has answered: unknown is not green
  const shippedToday = trend?.shipped ? trend.shipped[trend.shipped.length - 1] : null
  const healthLines = overview ? overview.health : 0

  const item = (group, key, label, value, tone, tip, dot = null) => ({
    group,
    key,
    label,
    value,
    tone,
    dot,
    dim: value === '0',
    tip: staleTip ?? tip,
  })
  const count = (key, label, value, tip) => item(1, key, label, fig(value), 'neutral', tip)
  const items = [
    item(0, 'needs', 'Needs you', fig(n), n > 0 ? 'bad' : 'dim', n > 0 ? `${n} wait on you` : 'Nothing waits on you'),
    count('running', 'Running', cells.running.value, 'A lead works on these now'),
    count('paused', 'Paused', cells.paused.value, 'Started, held by a named wait'),
    count('ready', 'Ready', cells.ready.value, 'Not started, held only by capacity'),
    count('held', 'Held', cells.held.value, 'Not started, cannot start whatever the capacity'),
    {
      ...count('checking', 'Checking', cells.checking.value, 'Shipped, its check pending'),
      tone: 'dim', // quiet: last in the strip
    },
    count('shipped', 'Ship', shippedToday, 'Shipped in the last day'),
    item(
      2,
      'production',
      'Prod',
      prod && prod.red > 0 ? String(prod.red) : '',
      prod && prod.red > 0 ? 'bad' : 'dim',
      !prod ? 'Production: not known yet' : prod.red > 0 ? `${prod.red} projects red` : 'Production is green',
      !prod ? 'dim' : prod.red > 0 ? 'bad' : 'good',
    ),
    // only while there is a line to read: at 0 (and while unknown) the item is not on the bar
    ...(healthLines > 0
      ? [
          item(
            3,
            'health',
            'Health',
            String(healthLines),
            healthTone(overview),
            'Health lines of the factory',
            healthTone(overview),
          ),
        ]
      : []),
  ]

  const flowLink = consoleLink(base, 'flow', null)
  const needsLink = consoleLink(base, 'needs', newestItem(needs))
  const trendRow = (c, text = 'Change in 7 days') =>
    c.delta === null ? [] : [{ text, right: deltaText(c.delta), tone: c.tone }]
  const detail = (title, tone, link, rows, chart = null) => ({
    title,
    tone,
    link,
    rows,
    ...(chart ? { chart } : {}),
    height: popupHeight(rows.length, chart ? chartHeight(chart.length) : 0),
  })
  const needsList = needsRows(needs, base)
  const work = workOf(overview, trend)
  const notStarted = 'Not started, change in 7 days'
  // A word's popover: its split rows (Paused, Ready, Held), then one row per project with its count, the busiest first, then
  // the change in 7 days (Ready and Held: the Not started one). The rows are at most MAX_ROWS.
  const byWord = (word, text = 'Change in 7 days') => {
    const link = consoleLink(base, word, null)
    const trendRows = trendRow(cells[word], text)
    const splits = splitRows(work, word, base)
    const room = MAX_ROWS - trendRows.length - splits.length
    const projects = room >= 1 ? capRows(projectRows(overview?.projects?.[word], base), link, room) : []
    const all = [...splits, ...projects, ...trendRows]
    return detail(
      `${KPI_TITLE[word]} · ${fig(cells[word].value)}`,
      'neutral',
      link,
      all.length ? all : [{ text: 'Open the Flow page', tone: 'dim' }],
    )
  }
  const shippedWeek = cells.shipped
  // the shipped charts: the last 24 hours and the last 7 days by the hour, the last 30 days by the day (no daily 7-day bars)
  const chart = (caption, values, extra = '') => (values ? [{ caption, right: `${sum(values)}${extra}`, values }] : [])
  const charts = [
    ...chart('Last 24 hours', trend?.shippedHourly?.slice(-24) ?? null),
    ...chart(
      'Last 7 days by the hour',
      trend?.shippedHourly ?? null,
      shippedWeek.delta === null ? '' : ` ${deltaText(shippedWeek.delta)}`,
    ),
    ...chart('Last 30 days by the day', trend?.shippedDaily30 ?? null),
  ]
  const shippedRows = trend?.shippedProjects?.length
    ? capRows(
        trend.shippedProjects.map((p) => ({
          text: p.project,
          right: String(p.count),
          link: consoleLink(base, 'project', p.project),
        })),
        flowLink,
        SHIPPED_ROWS,
      )
    : [{ text: trend ? 'Nothing shipped in the last day' : 'No trend yet', tone: 'dim' }]
  const details = {
    needs: detail(
      needsLabel(n),
      n > 0 ? 'bad' : 'dim',
      needsLink,
      needsList.length
        ? capRows(needsList, needsLink)
        : [{ text: n > 0 ? 'Open the Console' : 'Nothing to answer', tone: 'dim' }],
    ),
    running: byWord('running'),
    paused: byWord('paused'),
    ready: byWord('ready', notStarted),
    held: byWord('held', notStarted),
    checking: byWord('checking'),
    shipped: detail(
      `Shipped in the last day · ${fig(shippedToday)}`,
      'neutral',
      flowLink,
      shippedRows,
      charts.length ? charts : null,
    ),
    production: detail(
      !prod ? 'Production · –' : prod.red > 0 ? `Production · ${prod.red} red` : 'Production · green',
      !prod ? 'dim' : prod.red > 0 ? 'bad' : 'good',
      flowLink,
      !prod
        ? [{ text: 'Not known yet', tone: 'dim' }]
        : prod.red > 0
          ? capRows(prod.rows, flowLink)
          : [{ text: 'No project is red', tone: 'dim' }],
    ),
    health: detail(
      `Health · ${overview ? overview.health : '–'}`,
      healthTone(overview),
      consoleLink(base, 'health', null),
      capRows(healthRows(overview), null),
    ),
  }

  return {
    empty: false,
    stale,
    items,
    details,
    // the host, for the mini's chip in jk-status (null until `read machine` has answered): `loadPct` is the one-minute load
    // as a percent of the ceiling above which no new lead is admitted
    host: hostOf(machine),
    // the sidebar block's one line: what waits on the owner and how many leads run
    side: {
      text: `${needsLabel(n)}${overview ? ` · ${overview.work.running} ${overview.work.running === 1 ? 'lead' : 'leads'}` : ''}`,
      tone: n > 0 ? 'bad' : 'dim',
      link: needsLink,
      tip: staleTip ?? (needsLink ? 'Open the Console' : unset),
    },
  }
}

// The width in px a bar of these items needs (an estimate: CHAR_W per character), and the widest it can get (every figure at
// its longest) for the test. `items` are the model's.
function barWidth(items) {
  let w = 0
  items.forEach((it, i) => {
    const chars = it.label.length + (it.value ? it.value.length : 0)
    w += chars * CHAR_W + ITEM_PAD + (it.value ? VALUE_GAP : 0) + (it.dot ? DOT_W : 0) + (i > 0 ? ITEM_GAP : 0)
    if (i > 0 && it.group !== items[i - 1].group) w += SEP_W
  })
  return Math.ceil(w) + 2 * 8
}
// </glance>

const DETAIL_KEY = 'jk.factory.glance'

export default class JkGlance extends View {
  init(_props, cx) {
    this.role = this.roleOf()
    this.needs = null
    this.overview = null
    this.flow = null
    this.machine = null
    this.base = ''
    this.issues = null
    this.sessions = null
    this.published = JSON.stringify(shared('jk.factory.terminals') ?? null)
    this.publishedGlance = ''
    this.at = 0 // last good poll
    this.flowAt = 0
    this.polling = false
    this.flowPolling = false
    if (this.role === 'popup') return // the popover reads the bar's published model and never polls
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx))
    cx.timer.every(FLOW_MS, (cx) => this.refreshFlow(cx))
    this.refresh(cx)
    this.refreshFlow(cx)
  }

  props() {
    return rawProps() ?? {}
  }

  roleOf() {
    const p = this.props()
    return p.kind === 'detail' ? 'popup' : p.bar ? 'bar' : 'side'
  }

  model() {
    return glanceModel({
      needs: this.needs,
      overview: this.overview,
      flow: this.flow,
      machine: this.machine,
      base: this.base,
      at: this.at,
      now: Date.now(),
      flowAt: this.flowAt,
    })
  }

  refresh(cx) {
    if (this.polling || machines().find((m) => m.name === 'mini')?.layout !== 'ready') {
      this.publishGlance()
      cx.notify() // the stale dimming follows the clock
      return
    }
    this.polling = true
    cx.spawn(async (cx) => {
      const r = await exec('sh', ['-c', CMD], { on: 'mini' }).catch(() => null)
      this.polling = false
      const next = r?.stdout ? parsePoll(r.stdout) : null
      if (next?.needs || next?.overview) this.at = Date.now()
      if (next?.needs) this.needs = next.needs
      if (next?.overview) this.overview = next.overview
      if (next?.machine) this.machine = next.machine
      if (next?.base != null) this.base = next.base
      if (next?.issues) this.issues = next.issues
      if (next?.sessions) this.sessions = next.sessions
      // Both from this poll, or a new Issue's header would flicker through its session's words.
      if (next?.issues && next?.sessions) this.publish()
      this.publishGlance()
      cx.notify()
    })
  }

  // The 7-day trend: the heavier read, once a minute, on its own.
  refreshFlow(cx) {
    if (this.flowPolling || machines().find((m) => m.name === 'mini')?.layout !== 'ready') return
    this.flowPolling = true
    cx.spawn(async (cx) => {
      const r = await exec('sh', ['-c', FLOW_CMD], { on: 'mini' }).catch(() => null)
      this.flowPolling = false
      const flow = r?.stdout ? parseFlow(r.stdout) : null
      if (flow) {
        this.flow = flow
        this.flowAt = Date.now()
        this.publishGlance()
        cx.notify()
      }
    })
  }

  // The header and tab feed, only when it changed.
  publish() {
    const json = JSON.stringify(terminalsMap(this.issues, this.sessions, this.needs, this.base))
    if (json === this.published) return
    this.published = json
    setShared('jk.factory.terminals', JSON.parse(json))
  }

  // The popovers' feed (the bar's model: items and details), only when it changed. Only the bar publishes it.
  publishGlance() {
    if (this.role !== 'bar') return
    const m = this.model()
    const json = JSON.stringify(m)
    if (json === this.publishedGlance) return
    this.publishedGlance = json
    setShared(DETAIL_KEY, JSON.parse(json))
  }

  open(url) {
    if (url) exec('open', [url]).catch(() => {})
  }

  track(key, e) {
    if (e?.bounds) (this.bounds ??= {})[key] = e.bounds
  }

  // The popover sits fully above the clicked item, its bottom edge POPUP_GAP px over the item's top (placePopup), its card
  // POPUP_W wide and as high as its rows. The item's bounds travel in the props so the popover can place itself again once
  // it has measured its real height (fit).
  openDetail(key, event) {
    const d = this.shown?.details?.[key]
    if (!d) return
    // The item's bounds (from the click, else the hover record); only trusted when they are bar-sized, since a press can
    // report a child's or an outer element's bounds.
    const b = [event?.bounds, this.bounds?.[key]].find((x) => x && x.height <= 40)
    const p = event?.position
    const item = b ? { x: b.x, y: b.y, width: b.width } : p ? { x: p.x - 20, y: p.y - 14, width: 40 } : null
    const props = { kind: 'detail', item: key }
    if (!item) return openOverlay({ mod: 'jk-glance', kind: 'popup', props })
    openOverlay(popupSpec(props, item, d.height))
  }

  render() {
    const t = theme()
    const color = { good: t.ansi2, bad: t.blocked, warn: t.ansi3, dim: t.dim, neutral: t.muted }
    // A row that opens the Console when it has a link.
    const clickable = (el, link, after) =>
      el.when(Boolean(link), (e) =>
        e
          .cursor_pointer()
          .rounded(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => {
            this.open(link)
            after?.()
          }),
      )
    if (this.role === 'popup') return this.renderPopup(t, color, clickable)

    const m = this.model()
    this.shown = m
    if (this.role === 'side') {
      const root = h_flex().size_full().px(8).items_center().text_size(11)
      if (m.empty) return root.text_color(t.dim).child(div().truncate().child(m.text))
      return root
        .when(m.stale, (el) => el.opacity(0.5))
        .child(
          clickable(
            div()
              .id('glance-side')
              .truncate()
              .px(6)
              .text_color(color[m.side.tone])
              .tooltip(m.side.tip)
              .child(m.side.text),
            m.side.link,
          ),
        )
    }

    const bar = h_flex()
      .size_full()
      .px(8)
      .gap(ITEM_GAP)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
    if (m.empty) return bar.text_color(t.dim).child(div().truncate().child(m.text))
    const sep = () =>
      div()
        .w(1)
        .h(12)
        .mx((SEP_W - 1) / 2)
        .flex_none()
        .bg(t.border)
    const cell = (it) =>
      h_flex()
        .id(`glance-${it.key}`)
        .flex_none()
        .gap(VALUE_GAP)
        .items_center()
        .px(ITEM_PAD / 2)
        .rounded(5)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .tooltip(it.tip)
        .on_mouse_move((e) => this.track(it.key, e))
        .on_mouse_up('left', (e) => this.openDetail(it.key, e))
        .when(Boolean(it.dot), (el) =>
          el.child(
            div()
              .w(DOT_W - VALUE_GAP)
              .h(DOT_W - VALUE_GAP)
              .flex_none()
              .rounded(4)
              .bg(color[it.dot]),
          ),
        )
        .child(
          div()
            .flex_none()
            .text_color(it.dim ? t.dim : t.muted)
            .child(it.label),
        )
        .when(Boolean(it.value), (el) => el.child(div().flex_none().text_color(color[it.tone]).child(it.value)))
    const children = []
    m.items.forEach((it, i) => {
      if (i > 0 && it.group !== m.items[i - 1].group) children.push(sep())
      children.push(cell(it))
    })
    return bar.when(m.stale, (el) => el.opacity(0.5)).children(children)
  }

  // The card knows its real height once laid out: when the guess (`height`, from the rows) was off, it places itself again
  // once so its bottom edge sits POPUP_GAP px over the item and never over it.
  fit(size) {
    const { anchor, height, refit, kind, item } = this.props()
    const h = Math.ceil(size.height)
    if (!anchor || !height || !h || refit || Math.abs(h - height) <= 2) return
    closeOverlay(this.props().overlay)
    openOverlay(popupSpec({ kind, item, refit: true }, anchor, h))
  }

  // The popover card: a title (a link to the item's page), an optional chart and one row per detail row, each a link when it
  // has one. The bar's published model is the only source; a row click opens the Console and closes the popover.
  renderPopup(t, color, clickable) {
    const d = shared(DETAIL_KEY)?.details?.[this.props().item]
    const close = () => closeOverlay(this.props().overlay)
    const card = v_flex()
      .id('glance-detail')
      .w_full()
      .p(POPUP_PAD)
      .gap(ROW_GAP)
      .rounded(10)
      .border_1()
      .border_color(t.border)
      .bg(t.popover)
      .text_size(11.8)
      .text_color(t.foreground)
      .on_size_change((size) => this.fit(size))
      .on_mouse_down('left', () => {})
    if (!d) return card.child(div().h(TITLE_H).text_color(t.dim).child('No data yet'))
    const row = (r, i) =>
      clickable(
        h_flex()
          .id(`glance-row-${i}`)
          .h(ROW_H)
          .flex_none()
          .px(4)
          .gap(8)
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(8)
              .child(
                div()
                  .max_w(170)
                  .truncate()
                  .text_color(color[r.tone ?? 'neutral'] ?? t.muted)
                  .child(r.text),
              )
              .when(Boolean(r.note), (el) =>
                el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(r.note)),
              ),
          )
          .when(Boolean(r.right), (el) => el.child(div().flex_none().text_color(t.dim).child(r.right))),
        r.link,
        close,
      )
    // One bar chart: a caption row over bars as high as their value against the chart's largest; the newest bar is lit.
    const chart = (c) => {
      const max = Math.max(1, ...c.values)
      return v_flex()
        .flex_none()
        .gap(ROW_GAP)
        .child(
          h_flex()
            .h(ROW_H)
            .px(4)
            .items_center()
            .justify_between()
            .child(div().text_color(t.muted).child(c.caption))
            .child(div().text_color(t.dim).child(c.right)),
        )
        .child(
          h_flex()
            .h(BAR_AREA_H)
            .px(4)
            .gap(c.values.length > 60 ? 0 : 2) // 168 hourly bars side by side, the others a hair apart
            .items_end()
            .children(
              c.values.map((v, i) =>
                div()
                  .flex_1()
                  .h(v > 0 ? Math.max(3, Math.round((v / max) * BAR_AREA_H)) : 1)
                  .rounded(1)
                  .bg(v === 0 ? t.border : i === c.values.length - 1 ? t.foreground : t.muted),
              ),
            ),
        )
    }
    return card
      .child(
        clickable(
          div()
            .id('glance-title')
            .h(TITLE_H)
            .flex_none()
            .px(4)
            .truncate()
            .text_size(13)
            .text_color(color[d.tone] ?? t.foreground)
            .child(d.title),
          d.link,
          close,
        ),
      )
      .when(Boolean(d.chart), (el) => el.child(v_flex().flex_none().gap(ROW_GAP).children(d.chart.map(chart))))
      .children(d.rows.map(row))
  }
}
