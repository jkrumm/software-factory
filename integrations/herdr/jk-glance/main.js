// jk-glance — the sidebar's glance at the factory: what needs the owner, what runs. Two rows of text; a click opens
// the factory Console in the default browser (`open` on this computer). Read-only.
// Every 15 s ONE call on the mini reads `factory read needs` and `factory read overview` (token through secrets-run,
// never argv) and the Console's base URL (FACTORY_CONSOLE_URL in the mini's ~/.config/factory/env). Each part parses on
// its own and keeps its last good answer; no good poll for 2 min dims the block. All API text is data, never interpreted.
// The same poll also reads the Issues and live sessions and publishes shared("jk.factory.terminals"), the feed jk-pane's
// header and the tab's Console link show (only when it changed).
import { View, div } from 'gpui-kit'
import { v_flex } from 'gpui-base'
import { exec, theme, machines, shared, setShared } from 'herdr'

// The token comes from the factory's own env template through secrets-run, never argv.
const SECRETS = `PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH"; cd ~/SourceRoot/software-factory && secrets-run run --env-file=.env.tpl --`
// `--format json` goes before the subcommand. Parts are split on a line holding only @@.
const READS =
  'factory --format json read needs; echo; echo @@; factory --format json read overview; echo; echo @@; ' +
  'factory --format json read issues --state all --limit 40; echo; echo @@; factory --format json read sessions --live; echo'
const URL_READ = `grep -m1 '^FACTORY_CONSOLE_URL=' "$HOME/.config/factory/env" | cut -d= -f2-`
const CMD = `{ ${SECRETS} sh -c '${READS}'; } 2>/dev/null; echo @@; ${URL_READ} 2>/dev/null`

const POLL_MS = 15000
const STALE_MS = 2 * 60000
const TOOLTIP_MAX = 160

// <glance> pure helpers (integrations/herdr/jk-glance.test.ts runs this block on its own: no imports, no gpui)
const asArray = (v) => (Array.isArray(v) ? v : [])
const num = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)

const ADDR = /^t[0-9a-z]+$/

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

function parseOverview(text) {
  let d
  try {
    d = JSON.parse(String(text ?? ''))
  } catch {
    return null
  }
  if (!d || typeof d !== 'object' || !d.counts || typeof d.counts !== 'object') return null
  return { working: num(d.counts.working), waiting: num(d.counts.waiting), queued: num(d.counts.queued) }
}

function parseJson(text) {
  try {
    const d = JSON.parse(String(text ?? ''))
    return d && typeof d === 'object' ? d : null
  } catch {
    return null
  }
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

function needsLabel(needs) {
  const n = needsTotal(needs)
  return n > 0 ? `Needs you · ${n}` : 'Nothing waits on you'
}

function runningLabel(overview) {
  const o = overview ?? { working: 0, waiting: 0, queued: 0 }
  return `Running · ${o.working} working · ${o.queued} queued${o.waiting > 0 ? ` · ${o.waiting} waiting` : ''}`
}

// The Console link for a click: "needs" opens /needs-you (the newest item selected when there is one), "flow" opens /flow.
// Null when the base is not an http(s) URL.
function consoleLink(base, kind, item) {
  const b = String(base ?? '')
    .trim()
    .replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s/]+/i.test(b)) return null
  if (kind === 'flow') return `${b}/flow`
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
// </glance>

export default class JkGlance extends View {
  init(_props, cx) {
    this.needs = null
    this.overview = null
    this.base = ''
    this.issues = null
    this.sessions = null
    this.published = JSON.stringify(shared('jk.factory.terminals') ?? null)
    this.at = 0 // last good poll
    this.polling = false
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx))
    this.refresh(cx)
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

  // The header and tab feed, only when it changed.
  publish() {
    const json = JSON.stringify(terminalsMap(this.issues, this.sessions, this.needs, this.base))
    if (json === this.published) return
    this.published = json
    setShared('jk.factory.terminals', JSON.parse(json))
  }

  open(kind) {
    const url = consoleLink(this.base, kind, newestItem(this.needs))
    if (url) exec('open', [url]).catch(() => {})
  }

  render() {
    const t = theme()
    const box = v_flex().size_full().px(16).py(6).gap(2).justify_center().text_size(12)
    if (!this.at) return box.text_color(t.dim).child(div().truncate().child('Factory: no data'))
    const stale = Date.now() - this.at > STALE_MS
    const link = consoleLink(this.base, 'needs', null)
    const unset = 'FACTORY_CONSOLE_URL is not set on the mini (~/.config/factory/env)'
    const n = needsTotal(this.needs)
    const newest = newestItem(this.needs)
    const working = this.overview?.working ?? 0
    const staleTip = stale ? 'No fresh answer from the factory for 2 min' : null
    const needsTip = staleTip ?? (link ? (newest ? clip(newest.title, TOOLTIP_MAX) : 'Open the Console') : unset)
    const runTip = staleTip ?? (link ? 'Open the flow in the Console' : unset)
    const row = (id, color, tip, kind, text) =>
      div()
        .id(id)
        .truncate()
        .text_color(color)
        .tooltip(tip)
        .child(text)
        .when(Boolean(link), (el) =>
          el
            .cursor_pointer()
            .rounded(4)
            .hover((s) => s.bg(t.hover))
            .on_click(() => this.open(kind)),
        )
    return box
      .when(stale, (el) => el.opacity(0.5))
      .child(row('glance-needs', n > 0 ? t.blocked : t.dim, needsTip, 'needs', needsLabel(this.needs)))
      .child(row('glance-run', working > 0 ? t.working : t.dim, runTip, 'flow', runningLabel(this.overview)))
  }
}
