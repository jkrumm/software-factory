// jk-glance — the factory at a glance, in three roles of one mod (props():
//   { bar: true }                a status-bar segment: short items, left to right: Needs you, Working, Waiting, Queued,
//                                Shipped today, Production, CPU, RAM, Load (percent of its ceiling), Health. It polls
//                                the factory and publishes shared("jk.factory.glance"); a click on an item opens its popover.
//   { kind: "detail", item }     the popover (an overlay popup of this same mod): the detail of one item, read from
//                                shared("jk.factory.glance"), each row a link into the Console. It never polls.
//   no props                     the sidebar block, one line: Needs you and the lead count (GLANCE_H px high). It polls too:
//                                keep it out of a layout that already has the bar.
// A click on a row opens the factory Console at that place in the default browser (`open` on this computer). Read-only:
// links, no controls. No per-lead row anywhere: the leads show as a count, by project in the popover.
// Every 15 s ONE call on the mini reads `factory read needs`, `read overview` (counts, health, uptime, the open Issues),
// `read issues`, `read sessions` and `read machine` (token through secrets-run, never argv), the host's CPU and RAM and the
// Console's base URL (FACTORY_CONSOLE_URL in the mini's ~/.config/factory/env). Every 60 s a second call reads `factory read
// flow`: the 7-day trend, the reason each queued Issue waits and the projects whose production is red. Each part parses on
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
// macOS: "<cpu %> <used GiB> <total GiB>". Used = active + wired + compressed, the figure Activity Monitor calls memory used
// (the same as the status bar's own). Not part of `read machine`, which has the load and swap only.
const STATS = `export LC_ALL=C; cpu=$(ps -A -o %cpu= | awk -v n="$(sysctl -n hw.ncpu)" '{s+=$1} END{printf "%.1f", s/n}'); used=$(vm_stat | awk '/page size of/{ps=$8} /Pages active/{a=$3} /Pages wired/{w=$4} /occupied by compressor/{c=$5} END{printf "%.1f", (a+w+c)*ps/1073741824}'); echo "$cpu $used $(sysctl -n hw.memsize | awk '{printf "%.0f", $1/1073741824}')"`
const URL_READ = `grep -m1 '^FACTORY_CONSOLE_URL=' "$HOME/.config/factory/env" | cut -d= -f2-`
const CMD = `{ ${SECRETS} sh -c '${READS}'; } 2>/dev/null; echo @@; ${STATS} 2>/dev/null; echo @@; ${URL_READ} 2>/dev/null`
// The Flow page's own read: the 7-day series live in its `trend`, the queue reasons in its queued column.
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
const BAR_W = 780
const BAR_H = 28
// Text metrics for the width estimate: the bar's 11.8 px text is at most this wide per character; an item has 4 px padding
// each side, a dot is 7 px and 5 px from its text, the items sit 2 px apart and a separator takes 9 px with its gap.
const CHAR_W = 6.2
const ITEM_PAD = 8
const DOT_W = 12
const ITEM_GAP = 2
const SEP_W = 9

// The popover: a card of POPUP_W px with a title row and at most MAX_ROWS rows, each ROW_H px high, 2 px apart.
const POPUP_W = 340
const POPUP_PAD = 12
const TITLE_H = 22
const ROW_H = 20
const ROW_GAP = 2
const MAX_ROWS = 8
const MAX_DOWN = 4

// The popover's height for a detail: what the card draws, so the overlay can sit its bottom edge above the item.
const popupHeight = (rows) => 2 * POPUP_PAD + 2 + TITLE_H + rows * (ROW_H + ROW_GAP)
const WORST_POPUP_H = popupHeight(MAX_ROWS)

// "needs @@ overview @@ issues @@ sessions @@ machine @@ stats @@ url": each part is null when it does not parse.
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

// The monitors roll-up of the overview: counts and the names of what is down (infra names, a few, clipped).
function parseUptime(u) {
  if (!u || typeof u !== 'object') return null
  if (!Number.isFinite(u.up) || !Number.isFinite(u.down) || !Number.isFinite(u.total)) return null
  const downNames = asArray(u.downNames)
    .filter((n) => typeof n === 'string' && n.trim())
    .slice(0, 10)
    .map((n) => clip(n, 80))
  return { up: num(u.up), down: num(u.down), total: num(u.total), downNames }
}

// Counts, the kinds of the health lines (never their words) and the uptime. Nothing else of the overview is kept.
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
    working: num(c.working),
    waiting: num(c.waiting),
    queued: num(c.queued),
    asks: num(c.asks),
    humanQueue: num(c.humanQueue),
    health: num(c.health),
    healthKinds: asArray(d.health).map((h) => (typeof h?.kind === 'string' ? h.kind.slice(0, 32) : 'other')),
    uptime: parseUptime(d.uptime),
    leads: parseLeads(d.issues),
  }
}

// The running leads: an open Issue in the working state, as its project only (never its number, phase or words).
function parseLeads(issues) {
  return asArray(issues)
    .filter((i) => i && i.state === 'working' && Number.isInteger(i.id))
    .map((i) => ({ repo: clip(typeof i.repoName === 'string' && i.repoName ? i.repoName : '?', 40) }))
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

// The host's CPU and memory: "<cpu %> <used GiB> <total GiB>" (STATS). Null when it does not parse.
function parseStats(text) {
  const [cpu, used, total] = String(text ?? '')
    .trim()
    .split(/\s+/)
    .map(Number)
  if (![cpu, used, total].every(Number.isFinite) || total <= 0 || cpu < 0 || used < 0) return null
  return { cpu, usedG: used, totalG: total, ramPct: (used / total) * 100 }
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
// of working, waiting and queued (oldest first, the last is now), the daily shipped counts and the week before.
function parseFlow(text) {
  const d = parseJson(text)
  if (!d) return null
  const t = d.trend && typeof d.trend === 'object' ? d.trend : {}
  const states = t.states && typeof t.states === 'object' ? t.states : {}
  const line = (v) => (Array.isArray(v) && v.length >= 2 ? v.map(num) : null)
  const flow = {
    working: line(states.working),
    waiting: line(states.waiting),
    queued: line(states.queued),
    shipped: Array.isArray(t.shipped) && t.shipped.length ? t.shipped.map(num) : null,
    shippedBefore: Number.isFinite(t.shippedBefore) ? num(t.shippedBefore) : null,
  }
  const column = d.states && typeof d.states === 'object' ? d.states : null
  const hasTrend = Object.values(flow).some((v) => v !== null)
  if (!hasTrend && !column) return null
  return { ...flow, ...queueReasons(column) }
}

const NOT_A_FIX_LINE = new Set(['chain', 'spec', 'finalizing', 'unknown_project'])
const LINE_MESSAGE = /^production of (\S+) is red \(Issue (\d+)\)/

// From the board's columns: why each queued Issue waits (`why`: its queue kind, `seat` when nothing but a free account holds
// it, and its project) and the projects whose production is red (`red`: the incident that stops the line). Words of an
// Issue never leave this function. A project is red while an incident Issue is queued or working and nothing blocks it (the
// server's own rule, domains/planning/queue.ts); the queued Issues held by that line carry the same project and incident.
function queueReasons(column) {
  const why = []
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
      if (state === 'queued') why.push({ kind: kind ?? 'seat', project: repo })
      if (i.kind === 'incident' && !(kind && NOT_A_FIX_LINE.has(kind))) put(repo, numberOf(i.id))
      if (kind === 'line') {
        const m = LINE_MESSAGE.exec(String(i.queue.message ?? ''))
        if (m) put(clip(m[1], 40), Number(m[2]))
      }
    }
  }
  return { why, red: [...red].map(([project, n]) => ({ project, n })) }
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
  const url = (parts[6] ?? '').trim().split('\n')[0].trim()
  return {
    needs: parseNeeds(parts[0]),
    overview: parseOverview(parts[1]),
    issues: parseIssues(parts[2]),
    sessions: parseSessions(parts[3]),
    machine: parseMachine(parts[4]),
    stats: parseStats(parts[5]),
    base: parts.length >= 7 ? url : null,
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
// (the language's: settling, queued, working, waiting, watching) and the Console link. No ids, roles or phases: the screen
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
  if (kind === 'working' || kind === 'waiting' || kind === 'queued') return `${b}/flow?state=${kind}`
  if (kind === 'project') return `${b}/flow?project=${encodeURIComponent(String(item ?? ''))}`
  if (kind === 'issue') return Number.isInteger(item) ? `${b}/issues/${item}` : `${b}/flow`
  if (kind === 'host') return `${b}/throughput`
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

const KPIS = [
  { key: 'working', label: 'Working', higherIsBetter: true },
  { key: 'waiting', label: 'Waiting', higherIsBetter: false },
  { key: 'queued', label: 'Queued', higherIsBetter: false },
  { key: 'shipped', label: 'Shipped this week', higherIsBetter: true },
]

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

// Per KPI: its figure and the change against 7 days ago. The figure of a state is the overview's count (the last trend
// sample when the overview is missing); the change is last sample minus first, shipped this week minus the week before. A
// part that is missing leaves its fields null.
function kpiCells(overview, flow) {
  return KPIS.map((def) => {
    if (def.key === 'shipped') {
      const bars = flow?.shipped ?? null
      const value = bars ? sum(bars) : null
      const delta = bars && flow.shippedBefore !== null ? value - flow.shippedBefore : null
      return { ...def, value, delta, tone: toneOf(delta, def.higherIsBetter) }
    }
    const line = flow?.[def.key] ?? null
    const value = overview ? overview[def.key] : line ? line[line.length - 1] : null
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

// Running leads by project, the busiest first: a project and its count, never a lead of its own.
function projectRows(leads, base) {
  const byProject = new Map()
  for (const l of asArray(leads)) byProject.set(l.repo, (byProject.get(l.repo) ?? 0) + 1)
  return [...byProject]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([project, count]) => ({ text: project, right: String(count), link: consoleLink(base, 'project', project) }))
}

// How a queued Issue's binding reason reads (the queue kinds of domains/planning/queue.ts and describe.ts; `seat` is none).
const WHY_WORD = {
  line: 'production red, only fixes run',
  chain: 'waits for another Issue',
  drain: 'the queue is draining',
  claim: 'its repo has no free claim',
  spec: 'a Spec waits for your verdict',
  finalizing: 'the last attempt is ending',
  unknown_project: 'its repo is not known yet',
  doctor: 'the host doctor holds new work back',
  boot: 'the host has just booted',
  load: 'the host is busy',
  memory: 'the host is short of memory',
  lane: 'its resource lane is full',
  window: 'every account window is closed',
  cap: 'every account is at its lead cap',
  seat: 'waits for a free seat', // no reason recorded: only a free account holds it
}

// Queued Issues grouped by the reason that holds them, the largest group first; the tail past MAX_ROWS - 2 reasons is one
// "other reasons" row (the last row of the popover is the trend's).
const MAX_REASONS = MAX_ROWS - 2
function queueRows(why, base) {
  const groups = new Map()
  for (const w of asArray(why)) {
    const g = groups.get(w.kind) ?? { count: 0, projects: [] }
    g.count++
    if (w.project && !g.projects.includes(w.project)) g.projects.push(w.project)
    groups.set(w.kind, g)
  }
  const sorted = [...groups].sort((a, b) => b[1].count - a[1].count)
  const shown = sorted.length > MAX_REASONS ? sorted.slice(0, MAX_REASONS - 1) : sorted
  const rows = shown.map(([kind, g]) => ({
    text: `${WHY_WORD[kind] ?? kind}${kind === 'line' ? `: ${g.projects.join(', ')}` : ''}`,
    right: String(g.count),
    link: consoleLink(base, kind === 'chain' ? 'chain' : 'queued', null),
  }))
  const rest = sorted.slice(shown.length)
  if (rest.length) {
    rows.push({
      text: `${rest.length} other reasons`,
      right: String(sum(rest.map(([, g]) => g.count))),
      link: consoleLink(base, 'queued', null),
    })
  }
  return rows
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
// CPU and memory have no ceiling of the factory's: the status bar's own red from 85 %, amber from 70.
const useTone = (pct) => (pct >= 85 ? 'bad' : pct >= 70 ? 'warn' : 'neutral')

// The host's figures, each as the percent the bar shows: CPU and RAM of the host, load as a share of the ceiling above which
// no new lead is admitted (the plain figure when no ceiling is known), swap as its own percent against its ceiling. Null per
// figure while its read is missing.
function hostFigures(machine, stats) {
  const loadRatio = machine?.loadCeiling ? machine.load / machine.loadCeiling : null
  const swapRatio = machine?.swapCeiling ? machine.swapPct / machine.swapCeiling : null
  return {
    cpu: stats ? { value: `${Math.round(stats.cpu)}%`, tone: useTone(stats.cpu) } : null,
    ram: stats ? { value: `${Math.round(stats.ramPct)}%`, tone: useTone(stats.ramPct) } : null,
    load: machine
      ? {
          value: loadRatio === null ? `${Math.round(machine.load)}` : `${Math.round(loadRatio * 100)}%`,
          // the two ceilings stop new leads alike: the load figure is as red as the worse of them
          tone: worseTone(ratioTone(loadRatio ?? 0), ratioTone(swapRatio ?? 0)),
        }
      : null,
  }
}

// The host popover's rows: every figure with what it is against.
function hostRows(machine, stats) {
  const rows = []
  if (stats) {
    rows.push({ text: 'CPU', right: `${Math.round(stats.cpu)}%`, tone: useTone(stats.cpu) })
    rows.push({
      text: 'RAM',
      right: `${Math.round(stats.ramPct)}% · ${Math.round(stats.usedG)} of ${Math.round(stats.totalG)} G`,
      tone: useTone(stats.ramPct),
    })
  }
  if (machine) {
    const loadRatio = machine.loadCeiling ? machine.load / machine.loadCeiling : null
    rows.push({
      text: 'Load',
      right:
        loadRatio === null
          ? `${machine.load}`
          : `${Math.round(loadRatio * 100)}% · ${Math.round(machine.load * 10) / 10} of ${Math.round(machine.loadCeiling)}`,
      tone: ratioTone(loadRatio ?? 0),
    })
    const swapRatio = machine.swapCeiling ? machine.swapPct / machine.swapCeiling : null
    rows.push({
      text: 'Swap',
      right: `${Math.round(machine.swapPct)}%${machine.swapCeiling ? ` of ${Math.round(machine.swapCeiling)}%` : ''}`,
      tone: ratioTone(swapRatio ?? 0),
    })
    if (machine.loadCeiling || machine.swapCeiling) rows.push({ text: 'New leads stop at a ceiling', tone: 'dim' })
  }
  return rows
}

// Health lines by kind and the uptime roll-up, never their words.
function healthRows(overview) {
  if (!overview) return []
  const kinds = new Map()
  for (const k of overview.healthKinds) kinds.set(k, (kinds.get(k) ?? 0) + 1)
  const rows = [...kinds].map(([kind, n]) => ({ text: kind, right: String(n), tone: kind === 'door' ? 'warn' : 'bad' }))
  const up = overview.uptime
  if (up && up.total > 0) {
    rows.push({ text: 'Uptime', right: `${up.up} of ${up.total} up`, tone: up.down > 0 ? 'bad' : 'dim' })
    for (const name of up.downNames.slice(0, MAX_DOWN)) rows.push({ text: name, right: 'down', tone: 'bad' })
  }
  if (!rows.length) rows.push({ text: 'Nothing to report', tone: 'dim' })
  return rows
}

// -- the view model: every word the bar and its popovers show, in one pure object (the render only draws it, and it is what
// the bar publishes as shared("jk.factory.glance")). No Issue title, summary, number or phase enters it: the reads are parsed
// down to counts, kinds and monitor names. `link` is a URL for a click and is never drawn.

// The bar's items by group (a separator between groups): key, label, value, tone and an optional dot.
function glanceModel({ needs, overview, flow, machine, stats, base, at, now, flowAt }) {
  if (!at) return { empty: true, text: 'Factory: no data' }
  const stale = now - at > STALE_MS
  const trend = flow && now - flowAt <= FLOW_STALE_MS ? flow : null
  const unset = 'FACTORY_CONSOLE_URL is not set on the mini (~/.config/factory/env)'
  const staleTip = stale ? 'No fresh answer from the factory for 2 min' : null
  const n = needsCount(overview, needs)
  const cells = Object.fromEntries(kpiCells(overview, trend).map((c) => [c.key, c]))
  const fig = (v) => (v === null || v === undefined ? '–' : String(v))
  const host = hostFigures(machine, stats)
  const prod = trend ? productionRows(trend.red, base) : null // null until the board's read has answered: unknown is not green
  const shippedToday = trend?.shipped ? trend.shipped[trend.shipped.length - 1] : null
  const healthKnown = Boolean(overview)

  const item = (group, key, label, value, tone, tip, dot = null) => ({
    group,
    key,
    label,
    value,
    tone,
    dot,
    tip: staleTip ?? tip,
  })
  const items = [
    item(0, 'needs', 'Needs you', fig(n), n > 0 ? 'bad' : 'dim', n > 0 ? `${n} wait on you` : 'Nothing waits on you'),
    item(1, 'working', 'Working', fig(cells.working.value), 'neutral', 'Leads working'),
    item(1, 'waiting', 'Waiting', fig(cells.waiting.value), 'neutral', 'Issues waiting'),
    item(1, 'queued', 'Queued', fig(cells.queued.value), 'neutral', 'Issues queued'),
    item(1, 'shipped', 'Shipped', fig(shippedToday), 'neutral', 'Shipped today'),
    item(
      2,
      'production',
      'Prod',
      prod && prod.red > 0 ? String(prod.red) : '',
      prod && prod.red > 0 ? 'bad' : 'dim',
      !prod ? 'Production: not known yet' : prod.red > 0 ? `${prod.red} projects red` : 'Production is green',
      !prod ? 'dim' : prod.red > 0 ? 'bad' : 'good',
    ),
    item(3, 'cpu', 'CPU', host.cpu?.value ?? '–', host.cpu?.tone ?? 'dim', 'CPU of the host'),
    item(3, 'ram', 'RAM', host.ram?.value ?? '–', host.ram?.tone ?? 'dim', 'Memory of the host in use'),
    item(
      3,
      'load',
      'Load',
      host.load?.value ?? '–',
      host.load?.tone ?? 'dim',
      machine?.loadCeiling
        ? `Load ${machine.load} of ${machine.loadCeiling}: new leads stop at the ceiling`
        : 'Load of the host',
    ),
    item(
      4,
      'health',
      'Health',
      healthKnown ? String(overview.health) : '–',
      healthTone(overview),
      'Health lines of the factory',
      healthTone(overview),
    ),
  ]

  const flowLink = consoleLink(base, 'flow', null)
  const needsLink = consoleLink(base, 'needs', newestItem(needs))
  const trendRow = (c) =>
    c.delta === null ? [] : [{ text: 'Change in 7 days', right: deltaText(c.delta), tone: c.tone }]
  const detail = (title, tone, link, rows) => ({
    title,
    tone,
    link,
    rows,
    height: popupHeight(rows.length),
  })
  const shippedWeek = cells.shipped
  const queueList = trend ? queueRows(trend.why, base) : []
  const needsList = needsRows(needs, base)
  const projects = projectRows(overview?.leads, base)
  const hostList = hostRows(machine, stats)
  const hostDetail = detail(
    'Host',
    'neutral',
    consoleLink(base, 'host', null),
    hostList.length ? hostList : [{ text: 'Not known yet', tone: 'dim' }],
  )
  const details = {
    needs: detail(
      needsLabel(n),
      n > 0 ? 'bad' : 'dim',
      needsLink,
      needsList.length
        ? capRows(needsList, needsLink)
        : [{ text: n > 0 ? 'Open the Console' : 'Nothing to answer', tone: 'dim' }],
    ),
    working: detail(`Working · ${fig(cells.working.value)}`, 'neutral', consoleLink(base, 'working', null), [
      ...capRows(projects, consoleLink(base, 'working', null), MAX_ROWS - trendRow(cells.working).length),
      ...trendRow(cells.working),
    ]),
    waiting: detail(
      `Waiting · ${fig(cells.waiting.value)}`,
      'neutral',
      consoleLink(base, 'waiting', null),
      trendRow(cells.waiting).length ? trendRow(cells.waiting) : [{ text: 'Open the Flow page', tone: 'dim' }],
    ),
    queued: detail(`Queued · ${fig(cells.queued.value)}`, 'neutral', consoleLink(base, 'queued', null), [
      ...queueList,
      ...trendRow(cells.queued),
    ]),
    shipped: detail(
      `Shipped today · ${fig(shippedToday)}`,
      'neutral',
      flowLink,
      shippedWeek.value === null
        ? [{ text: 'No trend yet', tone: 'dim' }]
        : [
            { text: 'This week', right: String(shippedWeek.value) },
            ...(trend?.shippedBefore != null ? [{ text: 'The week before', right: String(trend.shippedBefore) }] : []),
            ...trendRow(shippedWeek),
          ],
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
    // the three host items share one popover
    cpu: hostDetail,
    ram: hostDetail,
    load: hostDetail,
    health: detail(
      `Health · ${healthKnown ? overview.health : '–'}`,
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
    // the sidebar block's one line: what waits on the owner and how many leads run
    side: {
      text: `${needsLabel(n)}${overview ? ` · ${overview.working} ${overview.working === 1 ? 'lead' : 'leads'}` : ''}`,
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
    const chars = it.label.length + (it.value ? 1 + it.value.length : 0)
    w += chars * CHAR_W + ITEM_PAD + (it.dot ? DOT_W : 0) + (i > 0 ? ITEM_GAP : 0)
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
    this.stats = null
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
      stats: this.stats,
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
      if (next?.stats) this.stats = next.stats
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

  // The popover ends 10 px above the clicked item (anchor = its top centre), its card POPUP_W wide and as high as its rows.
  openDetail(key, event) {
    const d = this.shown?.details?.[key]
    if (!d) return
    // The item's bounds (from the click, else the hover record); only trusted when they are bar-sized, since a press can
    // report a child's or an outer element's bounds.
    const b = [event?.bounds, this.bounds?.[key]].find((x) => x && x.height <= 40)
    const p = event?.position
    const anchor = b ? { x: b.x + b.width / 2, y: b.y } : p ? { x: p.x, y: p.y - 14 } : null
    const props = { kind: 'detail', item: key }
    if (!anchor) return openOverlay({ mod: 'jk-glance', kind: 'popup', props })
    openOverlay({
      mod: 'jk-glance',
      kind: 'popup',
      frame: 'none',
      width: POPUP_W,
      height: d.height,
      at: {
        x: Math.max(8, Math.round(anchor.x - POPUP_W / 2)),
        y: Math.max(8, Math.round(anchor.y - d.height - 10)),
      },
      props,
    })
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
    const sep = () => div().w(1).h(12).mx(4).flex_none().bg(t.border)
    const cell = (it) =>
      h_flex()
        .id(`glance-${it.key}`)
        .flex_none()
        .gap(5)
        .items_center()
        .px(4)
        .rounded(5)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .tooltip(it.tip)
        .on_mouse_move((e) => this.track(it.key, e))
        .on_mouse_up('left', (e) => this.openDetail(it.key, e))
        .when(Boolean(it.dot), (el) => el.child(div().w(7).h(7).flex_none().rounded(4).bg(color[it.dot])))
        .child(div().flex_none().child(it.label))
        .when(Boolean(it.value), (el) => el.child(div().flex_none().text_color(color[it.tone]).child(it.value)))
    const children = []
    m.items.forEach((it, i) => {
      if (i > 0 && it.group !== m.items[i - 1].group) children.push(sep())
      children.push(cell(it))
    })
    return bar.when(m.stale, (el) => el.opacity(0.5)).children(children)
  }

  // The popover card: a title (a link to the item's page) and one row per detail row, each a link when it has one. The
  // bar's published model is the only source; a row click opens the Console and closes the popover.
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
      .on_mouse_down('left', () => {})
    if (!d) return card.child(div().h(TITLE_H).text_color(t.dim).child('No data yet'))
    const row = (r, i) =>
      clickable(
        h_flex()
          .id(`glance-row-${i}`)
          .h(ROW_H)
          .px(4)
          .gap(8)
          .items_center()
          .justify_between()
          .child(
            div()
              .flex_1()
              .truncate()
              .text_color(color[r.tone ?? 'neutral'] ?? t.muted)
              .child(r.text),
          )
          .when(Boolean(r.right), (el) => el.child(div().flex_none().text_color(t.dim).child(r.right))),
        r.link,
        close,
      )
    return card
      .child(
        clickable(
          div()
            .id('glance-title')
            .h(TITLE_H)
            .px(4)
            .truncate()
            .text_size(13)
            .text_color(color[d.tone] ?? t.foreground)
            .child(d.title),
          d.link,
          close,
        ),
      )
      .children(d.rows.map(row))
  }
}
