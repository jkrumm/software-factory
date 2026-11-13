// jk-glance — the sidebar's glance at the factory, an aggregate and no tickets: what waits on the owner (one count), the
// Flow page's four KPIs with their 7-day trend (Working, Waiting, Queued, Shipped this week), health and uptime. A click
// opens the factory Console in the default browser (`open` on this computer). Read-only. 268 px wide, 144 px high.
// Every 15 s ONE call on the mini reads `factory read needs`, `read overview` (counts, health, uptime), `read issues` and
// `read sessions` (token through secrets-run, never argv) and the Console's base URL (FACTORY_CONSOLE_URL in the mini's
// ~/.config/factory/env). Every 60 s a second call reads `factory read flow`, the read the Console's Flow page draws its
// trends from, and keeps only its numbers. Each part parses on its own and keeps its last good answer; no good poll for
// 2 min dims the block. All API text is data, never interpreted; no ticket title, summary or id is ever drawn.
// The 15 s poll also publishes shared("jk.factory.terminals"), the feed jk-pane's header and the tab's Console link show
// (only when it changed).
import { View, div, PathBuilder } from 'gpui-kit'
import { v_flex, h_flex } from 'gpui-base'
import { exec, theme, machines, shared, setShared } from 'herdr'

// The token comes from the factory's own env template through secrets-run, never argv.
const SECRETS = `PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH"; cd ~/SourceRoot/software-factory && secrets-run run --env-file=.env.tpl --`
// `--format json` goes before the subcommand. Parts are split on a line holding only @@.
const READS =
  'factory --format json read needs; echo; echo @@; factory --format json read overview; echo; echo @@; ' +
  'factory --format json read issues --state all --limit 40; echo; echo @@; factory --format json read sessions --live; echo'
const URL_READ = `grep -m1 '^FACTORY_CONSOLE_URL=' "$HOME/.config/factory/env" | cut -d= -f2-`
const CMD = `{ ${SECRETS} sh -c '${READS}'; } 2>/dev/null; echo @@; ${URL_READ} 2>/dev/null`
// The Flow page's own read: the 7-day series live in its `trend`.
const FLOW_CMD = `{ ${SECRETS} sh -c 'factory --format json read flow'; } 2>/dev/null`

const POLL_MS = 15000
const FLOW_MS = 60000

// <glance> pure helpers (integrations/herdr/jk-glance.test.ts runs this block on its own: no imports, no gpui)
const asArray = (v) => (Array.isArray(v) ? v : [])
const num = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
const sum = (values) => values.reduce((total, n) => total + n, 0)

const ADDR = /^t[0-9a-z]+$/

// No good poll for 2 min dims the block; a trend older than 10 min is dropped.
const STALE_MS = 2 * 60000
const FLOW_STALE_MS = 10 * 60000

// The sparkline and the bars of a KPI cell, in px.
const SPARK_W = 48
const SPARK_H = 16
const SPARK_PAD = 2
// The Console's page for a health line: it has none yet. Set the path (e.g. '/health') when it gets one.
const HEALTH_PATH = null

// "needs @@ overview @@ issues @@ sessions @@ url": each part is null when it does not parse.
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
  const items = d.items.filter((i) => i && typeof i === 'object')
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
// of working, waiting and queued (oldest first, the last is now), the daily shipped counts and the week before.
function parseFlow(text) {
  const t = parseJson(text)?.trend
  if (!t || typeof t !== 'object') return null
  const states = t.states && typeof t.states === 'object' ? t.states : {}
  const line = (v) => (Array.isArray(v) && v.length >= 2 ? v.map(num) : null)
  const flow = {
    working: line(states.working),
    waiting: line(states.waiting),
    queued: line(states.queued),
    shipped: Array.isArray(t.shipped) && t.shipped.length ? t.shipped.map(num) : null,
    shippedBefore: Number.isFinite(t.shippedBefore) ? num(t.shippedBefore) : null,
  }
  return Object.values(flow).some((v) => v !== null) ? flow : null
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
  const url = (parts[4] ?? '').trim().split('\n')[0].trim()
  return {
    needs: parseNeeds(parts[0]),
    overview: parseOverview(parts[1]),
    issues: parseIssues(parts[2]),
    sessions: parseSessions(parts[3]),
    base: parts.length >= 5 ? url : null,
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
  if (kind === 'health') return HEALTH_PATH ? `${b}${HEALTH_PATH}` : null
  const id = item?.id
  return `${b}/needs-you${id != null && id !== '' ? `?item=${encodeURIComponent(String(id))}` : ''}`
}

// An Issue's place in the Console. The Console has no Issue page yet, so: the Issue's newest Needs you item when it has
// one, else the flow. Null when the base is not an http(s) URL.
function issueLink(base, issue, needs) {
  const ref = `issue_${issue}`
  const own = { items: asArray(needs?.items).filter((i) => i.issue === ref) }
  const item = newestItem(own)
  return consoleLink(base, item ? 'needs' : 'flow', item)
}

// -- the KPI cells: the Console's Flow page figures (apps/console/src/lib/flow.ts statsOf), the same rules.

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

// Per KPI: its figure, the change against 7 days ago and the samples to draw. The figure of a state is the overview's
// count (the last trend sample when the overview is missing); the change is last sample minus first, shipped this week
// minus the week before. A part that is missing leaves its fields null.
function kpiCells(overview, flow) {
  return KPIS.map((def) => {
    if (def.key === 'shipped') {
      const bars = flow?.shipped ?? null
      const value = bars ? sum(bars) : null
      const delta = bars && flow.shippedBefore !== null ? value - flow.shippedBefore : null
      return { ...def, value, delta, tone: toneOf(delta, def.higherIsBetter), line: null, bars }
    }
    const line = flow?.[def.key] ?? null
    const value = overview ? overview[def.key] : line ? line[line.length - 1] : null
    const delta = line ? line[line.length - 1] - line[0] : null
    return { ...def, value, delta, tone: toneOf(delta, def.higherIsBetter), line, bars: null }
  })
}

// -- geometry. Pure and total: an empty series, one point, all zeros, a NaN or 200 points never throw.

const finiteOr0 = (n) => (Number.isFinite(n) ? n : 0)

// At most `cap` values: a longer series is cut into `cap` runs of consecutive values, each its mean.
function bucket(values, cap) {
  if (values.length <= cap) return values
  const out = []
  for (let i = 0; i < cap; i++) {
    const from = Math.floor((i * values.length) / cap)
    const to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / cap))
    const run = values.slice(from, to)
    out.push(sum(run) / run.length)
  }
  return out
}

// The points of a sparkline in a w x h box, [x, y] in px with y down. The scale is the series' own range; all equal draws
// a line at the foot for zeros and at mid height otherwise; one point sits at mid width.
function sparkPoints(values, w = SPARK_W, h = SPARK_H, pad = SPARK_PAD) {
  const v = bucket(asArray(values).map(finiteOr0), Math.max(1, Math.floor(w)))
  if (!v.length) return []
  const lo = Math.min(...v)
  const hi = Math.max(...v)
  const top = pad
  const foot = h - pad
  const y = (n) => (hi === lo ? (hi === 0 ? foot : (top + foot) / 2) : foot - ((n - lo) / (hi - lo)) * (foot - top))
  const x = (i) => (v.length === 1 ? w / 2 : pad + (i / (v.length - 1)) * (w - 2 * pad))
  return v.map((n, i) => [Math.round(x(i) * 100) / 100, Math.round(y(n) * 100) / 100])
}

// A coordinate of a drawn path as a share of its box: the path scales with the element it fills.
const pct = (n, total) => `${Math.round((n / total) * 10000) / 100}%`
const pathPercent = (points, w = SPARK_W, h = SPARK_H) => points.map(([x, y]) => [pct(x, w), pct(y, h)])

// Bar heights in px (at most `cap` bars): the largest fills the box, a zero is a 1 px stub, all zeros are all stubs.
function barHeights(values, h = SPARK_H, cap = 14) {
  const v = bucket(
    asArray(values).map((n) => Math.max(0, finiteOr0(n))),
    cap,
  )
  const hi = Math.max(0, ...v)
  return v.map((n) => (hi === 0 || n === 0 ? 1 : Math.max(2, Math.round((n / hi) * h))))
}

// -- the view model: every word the block shows, in one pure object (the render only draws it).
// No Issue title, summary or id enters it: the reads are parsed down to counts, kinds and monitor names. `link` is a URL
// for a click and is never drawn.

const healthTone = (overview) => {
  if (!overview) return 'dim'
  if (overview.health === 0) return 'good'
  const kinds = overview.healthKinds
  return kinds.length && kinds.every((k) => k === 'door') ? 'warn' : 'bad'
}

function glanceModel({ needs, overview, flow, base, at, now, flowAt }) {
  if (!at) return { empty: true, text: 'Factory: no data' }
  const stale = now - at > STALE_MS
  const trend = flow && now - flowAt <= FLOW_STALE_MS ? flow : null
  const unset = 'FACTORY_CONSOLE_URL is not set on the mini (~/.config/factory/env)'
  const staleTip = stale ? 'No fresh answer from the factory for 2 min' : null
  const tip = (text, link) => staleTip ?? (link ? text : unset)
  const n = needsCount(overview, needs)
  const needsLink = consoleLink(base, 'needs', newestItem(needs))
  const flowLink = consoleLink(base, 'flow', null)
  const cells = kpiCells(overview, trend).map((c) => ({
    key: c.key,
    label: c.label,
    value: c.value === null ? '–' : String(c.value),
    delta: deltaText(c.delta),
    tone: c.tone,
    line: c.line,
    bars: c.bars,
    link: flowLink,
    tip: tip(
      c.value === null
        ? c.label
        : `${c.label}: ${c.value}${c.delta === null ? '' : ` (${deltaText(c.delta)} vs 7 days ago)`}`,
      flowLink,
    ),
  }))
  const up = overview?.uptime ?? null
  const downList = up?.downNames.length ? `Down: ${up.downNames.join(', ')}` : up?.down ? `${up.down} down` : 'All up'
  return {
    empty: false,
    stale,
    needs: {
      text: needsLabel(n),
      tone: n > 0 ? 'bad' : 'dim',
      link: needsLink,
      tip: tip('Open the Console', needsLink),
    },
    cells,
    health: {
      text: `Health · ${overview ? overview.health : '–'}`,
      tone: healthTone(overview),
      link: consoleLink(base, 'health', null),
      tip: staleTip ?? 'Health lines of the factory',
      uptime:
        up && up.total > 0
          ? { text: `Uptime · ${up.up}/${up.total} up`, tone: up.down > 0 ? 'bad' : 'dim', tip: staleTip ?? downList }
          : null,
    },
  }
}
// </glance>

export default class JkGlance extends View {
  init(_props, cx) {
    this.needs = null
    this.overview = null
    this.flow = null
    this.base = ''
    this.issues = null
    this.sessions = null
    this.published = JSON.stringify(shared('jk.factory.terminals') ?? null)
    this.at = 0 // last good poll
    this.flowAt = 0
    this.polling = false
    this.flowPolling = false
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx))
    cx.timer.every(FLOW_MS, (cx) => this.refreshFlow(cx))
    this.refresh(cx)
    this.refreshFlow(cx)
  }

  refresh(cx) {
    if (this.polling || machines().find((m) => m.name === 'mini')?.layout !== 'ready') {
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
      if (next?.base != null) this.base = next.base
      if (next?.issues) this.issues = next.issues
      if (next?.sessions) this.sessions = next.sessions
      // Both from this poll, or a new Issue's header would flicker through its session's words.
      if (next?.issues && next?.sessions) this.publish()
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

  open(url) {
    if (url) exec('open', [url]).catch(() => {})
  }

  render() {
    const t = theme()
    const root = v_flex().size_full().px(8).py(8).gap(6).text_size(11)
    const m = glanceModel({
      needs: this.needs,
      overview: this.overview,
      flow: this.flow,
      base: this.base,
      at: this.at,
      now: Date.now(),
      flowAt: this.flowAt,
    })
    if (m.empty) return root.justify_center().text_color(t.dim).child(div().truncate().child(m.text))
    const color = { good: t.ansi2, bad: t.blocked, warn: t.ansi3, dim: t.dim, neutral: t.muted }
    // A cell or row that opens the Console when it has a link.
    const clickable = (el, link) =>
      el.when(Boolean(link), (e) =>
        e
          .cursor_pointer()
          .rounded(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.open(link)),
      )
    const sparkline = (c) => {
      const box = div().relative().flex_none().w(SPARK_W).h(SPARK_H)
      if (c.bars) {
        const heights = barHeights(c.bars)
        const bw = Math.max(1, Math.floor((SPARK_W - (heights.length - 1)) / heights.length))
        return h_flex()
          .flex_none()
          .w(SPARK_W)
          .h(SPARK_H)
          .gap(1)
          .items_end()
          .children(
            heights.map((bh, i) =>
              div()
                .w(bw)
                .h(bh)
                .bg(color[i === heights.length - 1 ? c.tone : 'neutral'])
                .opacity(i === heights.length - 1 ? 1 : 0.55),
            ),
          )
      }
      const pts = c.line ? sparkPoints(c.line) : []
      if (!pts.length) return box
      const [lx, ly] = pts[pts.length - 1]
      const path = PathBuilder.stroke(1.25)
      pathPercent(pts).forEach(([x, y], i) => (i === 0 ? path.move_to(x, y) : path.line_to(x, y)))
      return box
        .when(pts.length >= 2, (e) =>
          e.child(window.paint_path(path.build(), color.neutral).absolute().top(0).left(0).size_full()),
        )
        .child(
          div()
            .absolute()
            .left(lx - 2)
            .top(ly - 2)
            .w(4)
            .h(4)
            .rounded(2)
            .bg(color[c.tone]),
        )
    }
    const cell = (c) =>
      clickable(
        v_flex()
          .id(`glance-${c.key}`)
          .flex_1()
          .h(40)
          .px(6)
          .py(3)
          .gap(1)
          .tooltip(c.tip)
          .child(div().truncate().text_size(10).text_color(t.muted).child(c.label))
          .child(
            h_flex()
              .items_end()
              .justify_between()
              .child(
                h_flex()
                  .items_baseline()
                  .gap(4)
                  .child(div().text_size(16).text_color(t.foreground).child(c.value))
                  .child(div().text_size(10).text_color(color[c.tone]).child(c.delta)),
              )
              .child(sparkline(c)),
          ),
        c.link,
      )
    const needsRow = clickable(
      div()
        .id('glance-needs')
        .h(16)
        .px(6)
        .truncate()
        .text_size(12)
        .text_color(color[m.needs.tone])
        .tooltip(m.needs.tip)
        .child(m.needs.text),
      m.needs.link,
    )
    const healthRow = h_flex()
      .h(14)
      .px(6)
      .gap(10)
      .items_center()
      .child(
        clickable(
          h_flex()
            .id('glance-health')
            .gap(5)
            .items_center()
            .tooltip(m.health.tip)
            .child(div().w(7).h(7).rounded(4).bg(color[m.health.tone]))
            .child(div().text_color(t.muted).child(m.health.text)),
          m.health.link,
        ),
      )
      .when(Boolean(m.health.uptime), (el) =>
        el.child(
          div()
            .id('glance-uptime')
            .truncate()
            .tooltip(m.health.uptime.tip)
            .text_color(color[m.health.uptime.tone])
            .child(m.health.uptime.text),
        ),
      )
    return root
      .when(m.stale, (el) => el.opacity(0.5))
      .child(needsRow)
      .child(
        v_flex()
          .gap(4)
          .child(h_flex().gap(0).child(cell(m.cells[0])).child(cell(m.cells[1])))
          .child(h_flex().gap(0).child(cell(m.cells[2])).child(cell(m.cells[3]))),
      )
      .child(healthRow)
  }
}
