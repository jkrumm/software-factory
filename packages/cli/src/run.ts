import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  DEFAULT_ROLES_FILE,
  DoorRoute,
  DoorRouteList,
  type DoorUnrouted,
  DoorUnroutedList,
  Fleet,
  Health,
  Issue,
  IssueAnswerAck,
  type IssueFactRow,
  IssueFactsRead,
  type IssueKpi,
  IssueList,
  IssueNoteAck,
  IssuePrioAck,
  PRIO_LIMIT,
  type IssueSummary,
  IssueView,
  type StatusIssue,
  type TimelineEntry,
  IssueEvidenceAck,
  IssueVerb,
  IsoTime,
  IssueVerbAck,
  MAX_EVIDENCE_BYTES,
  loadRoleTable,
  Notification,
  NotificationList,
  Project,
  ProjectList,
  ProjectSyncResult,
  Prompt,
  type Quota,
  QueueState,
  QueueView,
  QuotaList,
  type RoleEntry,
  Session,
  SessionList,
  Spawn,
  SpawnList,
  Status,
  WaitOn,
} from '@software-factory/contract'
import pkg from '../package.json' with { type: 'json' }
import { BIN, call, DEFAULT_URL, type Io } from './client.ts'
import { EXIT, FactoryError, usage } from './exit.ts'
import { follow, readVerb } from './read.ts'

/** A call that waits for git on the server; the server's own idle timeout is longer. */
const GIT_CALL_TIMEOUT_MS = 100_000

const HELP = `usage: ${BIN} [--format json|plain] <command>

commands:
  version         the CLI's version
  health          the server's /health
  spawn list      the spawn queue, newest first
  spawn create <key> --repo <path> --prompt <text> [--role <role>] [--parent <session>] [--space <path>] [--new-space]
                  queue a spawn (idempotent by key; the parent defaults to $FACTORY_SESSION: the send-back rule counts a
                  session's workers). The tab goes into the space of --space (default: the repo);
                  --new-space asks for a space of its own. Every spawn is a tab. Uses the token when FACTORY_TOKEN is set and
                  the socket otherwise
  spawn get <key> one spawn: status, hold, account, pane, tab, workspace (token or socket, as spawn create)
  spawn cancel <key>
                  end a queued or waiting spawn that was never claimed (state cancelled, its key is spent; the same call again is
                  the same answer; a claimed or started one is exit 5, its row in details.spawn). Token or socket, as spawn create
  spawn requeue <key>
                  put a failed spawn back in the queue with a fresh retry budget
  fleet [--refresh]
                  the fleet read model (plain: asks first, then the health line, then the open Issues, then the repos with their sessions, then the digest; --format json: all of it, the digest's spend per day under "digest").
                  --refresh builds it now instead of reading the last build. Token only (exit 3 without FACTORY_TOKEN): the model holds
                  IuRoot's text, which a pane's model must not read, so the socket does not serve it
  read overview|issues [--state open|closed|all] [--limit n]|issue <id>|sessions [--issue n] [--role r] [--live]|session <id>|asks|health|accounts
                  the read API (/v1), for people: titles, one-sentence summaries, insights (tool calls, subagents, tokens, time
                  working). --format json prints the body as the contract has it; plain prints one row per item, an id leading
                  the row. Token only
  follow [--issue <id>] [--since <cursor>] [--until-closed]
                  the change stream (/v1/stream): one line per frame (json: {"event","id","data"}; plain: time, id, words).
                  Reconnects after a drop with the last cursor (1 s to 15 s backoff); SIGINT or SIGTERM exits 0. A cursor the server
                  does not know (410) is exit 1: read the resources again. --until-closed (needs --issue) exits 0 once that Issue
                  is closed. Token only
  status          one screen: what needs a look, the open Issues (state, repo, lead, phase, what it waits for, evidence
                  missing, open questions), sessions by state (walled, blocked, stuck first), the queue with its hold
                  reasons, accounts with their readings, notes not yet delivered
  session list [--all]
                  the sessions, newest first, with their derived state (--all adds the dead)
  session get <id>
                  one session: state, turn, wait, pane, tab, Claude session id, the runner's last word (token or socket)
  session wait --on workers|deploy|owner | --done [--session <id>]
                  declare what this session is waiting on, or that the wait is over (default: $FACTORY_SESSION)
  session note <session> <text> [--id <id>]
                  type <text> into the session once it is at its prompt (held while it works), confirmed by its next
                  turn; --id makes a repeated call one note (default: a fresh id per call). Use -- before text that
                  starts with a dash
  issue new --repo <path> --title <text> [--facts @file|-] [--key <key>] [--source request|alert] [--after <id> …]
                  file an Issue. --after (repeatable, up to 20) holds it until those Issues are closed: each must exist and be open, else
                  nothing is filed (exit 2). A repeat of --key returns the stored Issue and ignores --after. --facts is JSON up to 32 KiB, from a file or stdin, kept as data. --key makes a replay one
                  Issue, whatever became of it (default: a fresh key per call). A repo must be inside the allowed roots
                  (token or socket, as spawn create)
  issue list      the Issues, newest first (token or socket)
  issue facts [--since <iso>]
                  one row per attempt of the Issues filed since --since (default: all) and the four KPIs over them: owner asks per
                  Issue, Issues verified with zero owner touch, verify green on the first hold, window points (the usage tracker's: -).
                  plain: one tab-separated line per attempt (issue, attempt, outcome, filed, admitted, landed, verified, closed, asks,
                  owner touches, holds, first pass, review tier), then the KPI line (token or socket)
  issue prio <id> <n> [--id <call id>]   (a negative n goes after --: issue prio 7 -- -5)
                  the owner's order among a project's queued Issues (token only): n is an integer -1000..1000, higher is admitted first,
                  the latest call wins, none is 0. A blocked Issue (--after) waits whatever its prio. A closed Issue is refused (exit 5)
  issue show <id> one Issue: its facts, its story from the lifecycle's events and the inbox oldest first, its evidence and its
                  questions (token or socket). What senders filed is data: --format plain shows it on one cut line each
  issue note <id> <text> [--wake] [--id <call id>]
                  a note for the Issue's lead (token only): typed into its pane through the session notes, once per call id
                  (--id makes a repeated call one note). An Issue with no lead running keeps it and the next brief carries it.
                  --wake also takes a waiting Issue back to working when it waits on a time, is blocked or is parked (not a
                  question: that is issue answer; not a dependency or a lost lead); otherwise it is a plain note.
                  Use -- before text that starts with a dash
  issue phase|wait|ship|close|block|ask|drop <id> [--id <call id>] [verb flags]
                  a lead's report on its Issue (token, or the socket from a lead's pane: $FACTORY_SESSION says which lead,
                  and it may only report on the Issue it works). One event per call; --id makes a repeated call one event.
                  Any of them ends a timed wait early (a wait Issue's lead need not wait it out); blocked and decision waits keep their rules
                  (the owner's way out of a block is issue note --wake).
                    phase  --phase <name> [--note <text>]
                    wait   --until <ISO time> [--why <text>]  a timed wait; the Issue wakes then
                    ship   --summary <text> --commit <sha> … [--evidence kind=<k>[,link=<url>][,note=<text>] …]
                           the merged commits; refused (exit 5, saying what is missing) until the evidence they require is on record
                           deploy mode make: deploy from the repo's main checkout first (git pull --ff-only, make deploy, make verify, make version);
                           the hold then runs make version (the deployed commit sha) and is red unless it holds the commits
                    close  --summary <text> (--commit <sha> … | --document <path or url>)
                           done, nothing deployed; refused (exit 5) when the commits touch deployable paths
                    block  --reason <text>                              it cannot go on and nobody can answer
                    ask    --question <text> [--option <text> …] [--default <option>] [--expires <ISO time>]
                    drop   --reason <text>                              it should not be done
  issue answer <id> <text> [--decision <id>] [--id <call id>]
                  answer the Issue's open question (the owner's way back from an ask; token only: a pane has none, so a lead cannot answer itself). The lead is
                  told in a note. --decision names the question when more than one was asked; --id makes a repeated call
                  one answer. Use -- before text that starts with a dash
  notify list [--pending]
                  what the factory told the owner, newest first: key, kind, status, attempts, text (--pending: not yet sent)
  notify test     send one line through the live path (the outbox and ntfy) and say whether it arrived; exit 1 if not (token)
  issue evidence <id> --kind ui|service|infra|data|review (--link <url> | --file <path> | --stdin) [--id <call id>]
                  record evidence, a link or up to 32 KiB of text; it counts for a ship when it is no older than the merged commit
  issue reopen <id> --reason <text> [--id <call id>]
                  the same fault within 30 days of closing: a new attempt in a fresh worktree. Past 30 days it is refused: issue new
  issue stop <id> --reason <text> [--id <call id>]
                  the owner's end of an Issue in any open state, one with no lead too: closed as dropped, then finalized like
                  every close. Token only, never the socket. A closed Issue is refused (exit 5)
  issue resume <id> [--attempt <n>] [--id <call id>]
                  open an attempt's archived session in a tab of its own, as a fork; the archive stays as it was
  project list    the projects: manifest or defaults, leads, who holds the claim and who waits, broken manifests (token or socket)
  project show <name>
                  one project: the manifest in force, the make contract (which of check, test, deploy, verify, restart, quality, logs,
                  status its Makefile has), the claim, a manifest that does not parse (token or socket)
  project sync    read every project's project.yaml and Makefile now (token)
  door route set <source> <monitor> <repo>
                  send the alerts of a monitor (Kuma: its name; HyperDX: the alert's title without trailing numbers) to a
                  repo: they become Issues there. The repo must be inside the allowed roots and never IuRoot. Token only.
                  Use -- before a monitor that starts with a dash
  door route rm <source> <monitor>
                  remove a route: its alerts count as unrouted again
  door route list the routes, with how many quiet alerts (an up with no open Issue) each counted
  door unrouted   the monitors that raised alerts with no route: source, monitor, count, last seen, last title
  door token new <source> [--rotate]
                  write a fresh token (32 random bytes, base64url) for the source into the door's tokens file
                  (FACTORY_DOOR_TOKENS_FILE, default ~/.config/factory/door-tokens.json, mode 0600) and print it once.
                  Offline, no server. An existing source needs --rotate; the door reads the file at start, so restart it
  queue get [--project <path>]
                  the queue state (run, pace or drain) of the global scope or a project, the effective one, and every scope set
                  (token or socket)
  queue set run|pace|drain [--project <path>]
                  set it: drain starts nothing new (queued spawns stay queued), pace allows one session per project and
                  spends only toward the weekly pace; the most restrictive scope that applies wins
  slot run [--name <label>] -- <cmd> [args…]
                  run <cmd> in one of the host's test slots (FACTORY_SLOTS on the server, default 2): waits for a free one,
                  renews the lease while the command runs, gives it back when it ends. The exit code, stdout and stderr are
                  the command's own. Fails open only on an outage: no server runs the command anyway with one line on stderr.
                  Contention keeps waiting; no slot within FACTORY_SLOT_WAIT_MS (default 45 min) exits 75 without running
                  the command, unless FACTORY_SLOT_OPEN=1. Goes by the socket, needs no token
  quota get       the newest reading of every account (percent of the 5-hour window and the week, resets, fresh or not)
  quota refresh   read the account picker now and store the readings
  role list       the role table: role, tier, effort (reads the tracked file, no server and no token)
  role get <role> one role: {"role", "tier", "effort"}
  hook <event>    the Claude Code hook entry (session-start, user-prompt-submit, stop, stop-failure, notification,
                  session-end); reads the hook JSON on stdin, spools it, tells the server, always exits 0

--all            list: include dead sessions
--on <what>      session wait: workers, deploy or owner
--done           session wait: the wait is over
--session <id>   session wait: the session (default $FACTORY_SESSION)
--id <id>        session note, issue note|prio: the call's idempotency key
--wake           issue note: also end a timed wait, a block or a park
--repo, --prompt, --role, --parent, --space, --new-space  spawn create
--title, --facts, --key, --source, --after  issue new
--rotate         door token new: replace the source's token
--decision      issue answer: the question it is for
--pending       notify list: only what is not sent
--since <iso>    issue facts: only Issues filed at or after it (follow: a stream cursor)
--state, --limit, --issue, --role, --live  read issues|sessions filters (--issue also follow)
--until-closed   follow: exit 0 once the --issue Issue is closed
--phase, --note, --until, --why, --summary, --commit, --document, --evidence, --reason, --question, --option, --default, --expires  issue <verb>
--kind, --link, --file, --stdin  issue evidence
--attempt <n>    issue resume: which attempt (default: the latest)
--name <label>   slot run: what the slot is for (default: the command)
--project <path> queue: the project (a repo inside the allowed roots); without it the global scope
--format json    one JSON line (default)
--format plain   tab-separated lines, or the bare value
FACTORY_URL      the server (default ${DEFAULT_URL})
FACTORY_TOKEN    the bearer token the server requires (not needed for version, health, session wait|note, slot run and role; issue note needs it;
                 spawn create|get, session get, queue get and issue new|list|show|evidence|reopen|resume|<verb> (not stop) fall back to the socket without it)
FACTORY_ROLES_FILE  the role table (default: config/roles.json of this checkout or release)
FACTORY_SOCKET   the server's unix socket for what a pane may do without a token (default ~/.local/share/factory/hook.sock)
FACTORY_DOOR_TOKENS_FILE  door token new: the door's tokens file
FACTORY_SLOT_WAIT_MS  slot run: longest wait for a slot before exiting 75 without running (default 2700000, 45 min)
FACTORY_SLOT_OPEN  slot run: 1 runs the command anyway when the wait runs out

Data goes to stdout, messages to stderr as one JSON line; the exit codes are agw's. ${BIN} never prompts.
`

type Format = 'json' | 'plain'

const cell = (value: unknown) => (value === null || value === undefined ? '-' : String(value))

const spawnLine = (s: Spawn) =>
  [s.key, s.status, s.account, s.resumeAt, s.attempts, s.session, s.role, s.hold].map(cell).join('\t')

const projectLine = (p: Project) =>
  [
    p.name,
    p.source,
    p.manifest.deploy.mode,
    `leads ${p.manifest.leads}`,
    `held ${p.claim.holders.join(',') || '-'}`,
    `queued ${p.claim.queued.join(',') || '-'}`,
    p.manifestError ? `broken ${p.manifestError.issue === null ? '' : `#${p.manifestError.issue}`}` : '',
  ]
    .filter(Boolean)
    .join('\t')

/** One project in full: the plain form is a few lines, the json form the whole object. */
const projectScreen = (p: Project): string =>
  [
    projectLine(p),
    `repo\t${p.repo}`,
    `ship\t${p.manifest.ship.map((r) => `${r.paths.join(',')} via ${r.via}`).join('; ')}`,
    `hold\t${p.manifest.deploy.hold}`,
    `make\t${
      p.makeTargets === null
        ? 'not read'
        : p.makeTargets.makefile
          ? Object.entries(p.makeTargets)
              .filter(([name]) => name !== 'makefile')
              .map(([name, has]) => `${name} ${has ? 'yes' : 'no'}`)
              .join(', ')
          : 'no Makefile'
    }`,
    ...(p.manifestError ? [`error\t${p.manifestError.message}`] : []),
    ...(p.planError ? [`plan error\t${p.planError}`] : []),
    ...(p.plan?.rows.map(
      (r) => `plan\t${r.key}\t${r.state}${r.issue === null ? '' : ` #${r.issue}`}${r.reason ? `\t${r.reason}` : ''}`,
    ) ?? []),
  ].join('\n')

const queueLine = (q: QueueView) => [q.scope.project ?? 'global', q.state, q.effective, q.setAt].map(cell).join('\t')

const quotaLine = (q: Quota) =>
  [
    q.account,
    q.fiveHourUsed,
    q.weeklyUsed,
    q.fiveHourResetsAt,
    q.weeklyResetsAt,
    q.fresh ? 'fresh' : 'stale',
    q.authOk ? 'auth ok' : 'auth failed',
  ]
    .map(cell)
    .join('\t')

const promptLine = (p: Prompt) =>
  [p.id, p.session, p.status, p.sentCount, p.sentAt, p.deliveredAt, p.error].map(cell).join('\t')

// Control characters (C1 too), the bidi overrides and isolates that reorder what follows, the line and paragraph separators, and the
// characters that show as nothing (zero-width, soft hyphen, BOM, word joiner): all of them go.
// oxlint-disable-next-line no-control-regex -- exactly what is removed
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]+/g

/** Someone else's text on the owner's terminal: one line, hidden characters gone, cut. */
const oneLine = (value: unknown, max = 160): string => {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  const clean = text.replace(HIDDEN, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

const lastSegment = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

/** One open Issue on one line: id, state, repo, lead, last phase, then only what is the case. */
const statusIssueLine = (i: StatusIssue) =>
  [
    `#${i.id}`,
    i.state,
    oneLine(lastSegment(i.repo), 60),
    i.lead ? oneLine(i.lead, 80) : '-',
    i.phase ? `phase ${oneLine(i.phase, 40)}` : 'phase -',
    i.waiting ? `waiting ${i.waiting}` : '',
    i.wakeAt ? `looks again ${i.wakeAt}` : '',
    i.missing.length > 0 ? `evidence missing ${i.missing.join(',')}` : '',
    i.decisions > 0 ? `${i.decisions} open ${i.decisions === 1 ? 'question' : 'questions'}` : '',
    i.finalizeError ? `finalize failed: ${oneLine(i.finalizeError, 80)}` : '',
    oneLine(i.title, 60),
  ]
    .filter(Boolean)
    .join('\t')

const stewardLine = (r: NonNullable<Status['steward']>): string =>
  `steward: ${r.acts} act${r.acts === 1 ? '' : 's'} in 24 h, ${r.exhausted} handed to the owner`

/** The status screen: the asks first (ATTENTION), the health line after them, then each section a header and tab-separated rows. */
export function statusScreen(s: Status): string {
  const section = (title: string, rows: string[]) => [title, ...(rows.length ? rows.map((r) => `  ${r}`) : ['  -'])]
  return [
    ...section(
      'ATTENTION',
      s.attention.map((line) => oneLine(line, 1_000)),
    ),
    ...section(
      'HEALTH',
      s.health.map((line) => oneLine(line, 1_000)),
    ),
    ...section('ISSUES', [
      ...s.issues.map(statusIssueLine),
      ...(s.issuesMore > 0 ? [`... ${s.issuesMore} more not shown`] : []),
    ]),
    ...section(
      'SESSIONS',
      s.sessions.map((x) =>
        [
          x.state,
          x.since ?? '-',
          x.id,
          x.role ?? '-',
          x.account ?? '-',
          `turn ${x.turn}`,
          x.wait ? `wait ${x.wait}` : '',
        ]
          .filter(Boolean)
          .join('\t'),
      ),
    ),
    ...section(
      `QUEUE (${s.queue.effective})`,
      s.queue.spawns.map((x) =>
        [
          x.key,
          x.status,
          x.hold ? `hold ${x.hold}` : '',
          x.account ?? '-',
          x.resumeAt ? `at ${x.resumeAt}` : '',
          x.error ?? '',
        ]
          .filter(Boolean)
          .join('\t'),
      ),
    ),
    ...section('ACCOUNTS', s.accounts.map(quotaLine)),
    ...(s.steward && (s.steward.acts > 0 || s.steward.exhausted > 0) ? [stewardLine(s.steward)] : []),
    ...section('NOTES', [
      ...s.notes.map(promptLine),
      ...(s.notesMore > 0 ? [`... ${s.notesMore} more not shown`] : []),
    ]),
  ].join('\n')
}

/** The fleet on one screen: the asks, oldest first, the health line, the open Issues, then each repo with its live sessions. */
export function fleetScreen(f: Fleet): string {
  const out: string[] = []
  const s = f.summary
  out.push(
    `FLEET\t${s.working} working\t${s.idle} idle\t${s.done} done\t${s.asks} asks (${s.staleAsks} older than 24 h)`,
  )
  out.push('ASKS')
  if (f.asks.length === 0) out.push('  -')
  for (const a of f.asks) {
    out.push(`  ${a.id}\t${a.kind}\t${a.repo?.split('/').at(-1) ?? '-'}\t${a.at}\t${oneLine(a.short ?? a.text, 100)}`)
  }
  out.push('HEALTH')
  if (f.health.length === 0) out.push('  -')
  for (const h of f.health) {
    out.push(`  ${h.id}\t${h.kind}\t${h.repo?.split('/').at(-1) ?? '-'}\t${h.since}\t${oneLine(h.text, 160)}`)
  }
  out.push('ISSUES')
  if (f.issues.length === 0) out.push('  -')
  for (const i of f.issues) {
    out.push(
      `  ${i.id}\t${i.state}\t${i.repo.split('/').at(-1) ?? '-'}\t${i.kind ?? '-'}\t${i.size ?? '-'}\t${i.lead ?? '-'}\t${oneLine(i.title, 80)}`,
    )
  }
  out.push('REPOS')
  if (f.repos.length === 0) out.push('  -')
  for (const r of f.repos) {
    out.push(`  ${r.name}${r.visible ? ' (visible)' : ''}`)
    for (const x of r.sessions) {
      out.push(`    ${x.state}\t${x.id}\t${x.role ?? '-'}\t${oneLine(x.headline ?? x.title ?? '-', 60)}`)
    }
  }
  const d = f.digest
  const today = d.days[0]
  out.push(
    d.enabled
      ? `DIGEST\ton${d.pending ? ' (waiting for a run)' : ''}\t${today ? `${today.day}: ${today.calls} calls, ${today.failed} failed, $${today.costUsd.toFixed(4)}` : 'no call yet'}${d.lastError ? `\tlast pass failed: ${oneLine(d.lastError, 100)}` : ''}`
      : 'DIGEST\toff',
  )
  if (f.errors.length > 0) {
    out.push('ERRORS')
    for (const e of f.errors) out.push(`  ${oneLine(e, 200)}`)
  }
  return out.join('\n')
}

const roleLine = (r: RoleEntry) => [r.role, r.tier, r.effort].join('\t')

const issueLine = (i: IssueSummary) =>
  [i.id, i.state, i.reason ?? i.outcome, i.source, i.repo, i.title]
    .map((value) => (typeof value === 'string' ? oneLine(value, 1000) : cell(value)))
    .join('\t')

/** `issue facts`, one line per attempt: Issue, attempt, outcome, the times, asks, owner touches, holds, first-pass, review tier. */
export const factLine = (r: IssueFactRow): string =>
  [
    r.issueId,
    r.attempt,
    r.outcome,
    r.filedAt,
    r.admittedAt,
    r.landedAt,
    r.verifiedAt,
    r.closedAt,
    r.asks,
    r.ownerTouches,
    r.holds,
    r.verifyFirstPass,
    r.reviewTier,
  ]
    .map(cell)
    .join('\t')

const count = (r: IssueKpi['ownerAsksPerIssue'], open = 0): string =>
  `(${r.numerator}/${r.denominator}${open > 0 ? `, open ${open}` : ''})`
const percent = (r: IssueKpi['zeroTouch'], open = 0): string =>
  `${r.value === null ? '-' : Math.round(r.value * 100)} % ${count(r, open)}`

/** The four KPIs on one line; a rate over nothing is `-`, and the window points are the usage tracker's, so always `-` here. */
export const kpiLine = (k: IssueKpi): string =>
  [
    `asks/issue ${k.ownerAsksPerIssue.value === null ? '-' : k.ownerAsksPerIssue.value.toFixed(2)} ${count(k.ownerAsksPerIssue)}`,
    `zero-touch ${percent(k.zeroTouch)}`,
    `first-hold ${percent(k.verifyFirstHold, k.verifyFirstHold.open)}`,
    `window ${k.windowPointsPerIssue.value ?? '-'}`,
  ].join('  ')

/** Longest a value of a payload is shown: what a note or a refusal says is whole up to what a verb accepts. */
const WORDS_MAX = 4_000

/**
 * What an entry's payload says, for a screen: `key=value` with each value cut, so a long free text cannot push the rest off the line. Data,
 * as filed; without `attempt` (the line's neighbours say it) and the commits `ship` derived (the verb's own fields have them).
 */
const payloadSummary = (payload: unknown): string => {
  if (payload === null || payload === undefined) return ''
  if (typeof payload !== 'object' || Array.isArray(payload)) return oneLine(payload, WORDS_MAX)
  return Object.entries(payload as Record<string, unknown>)
    .filter(([name]) => name !== 'derived' && name !== 'attempt')
    .map(([name, value]) => `${oneLine(name, 40)}=${oneLine(value, WORDS_MAX)}`)
    .join(' ')
}

const timelineLine = (t: TimelineEntry) =>
  [
    t.at,
    t.source === 'inbox' ? `${t.kind} (${t.result ?? 'not handled yet'})` : t.kind,
    t.from || t.to ? `${t.from ?? '-'}→${t.to ?? '-'}` : '',
    t.session ? oneLine(t.session, 80) : '',
    t.detail ? oneLine(t.detail, WORDS_MAX) : payloadSummary(t.payload),
  ]
    .map((part, i) => (i < 2 ? part : part || '-'))
    .join('\t')

/** One Issue for a terminal: its row, its facts as one cut line of data, its evidence, its questions, then the story, oldest first. */
function issueViewScreen(v: IssueView): string {
  return [
    issueLine(v),
    `facts\t${oneLine(v.facts, 400)}`,
    ...(v.evidenceCut > 0 ? [`... ${v.evidenceCut} earlier evidence entries not shown`] : []),
    ...v.evidence.map((e) =>
      [
        'evidence',
        e.at,
        oneLine(e.kind, 40),
        oneLine(e.author, 80),
        `attempt ${e.attempt ?? '-'}`,
        e.link ? oneLine(e.link, 300) : payloadSummary(e.payload),
      ].join('\t'),
    ),
    ...v.decisions.map((d) =>
      [
        'question',
        d.id,
        d.answeredAt
          ? `answered by ${oneLine(d.answeredBy ?? '-', 40)}${d.answerSource ? ` from ${oneLine(d.answerSource, 120)}` : ''}`
          : 'open',
        oneLine(d.question),
        d.answer ? `answer: ${oneLine(d.answer)}` : d.default ? `default ${oneLine(d.default, 60)}` : '',
      ]
        .filter((part) => part !== '')
        .join('\t'),
    ),
    ...(v.timelineCut > 0 ? [`... ${v.timelineCut} earlier entries not shown`] : []),
    ...v.timeline.map(timelineLine),
  ].join('\n')
}

const routeLine = (r: DoorRoute) => [r.source, r.monitor, r.repo, r.quiet, r.lastQuietAt].map(cell).join('\t')

const unroutedLine = (u: DoorUnrouted) => [u.source, u.monitor, u.count, u.lastSeen, u.lastTitle].map(cell).join('\t')

const notificationLine = (n: Notification) =>
  [n.key, n.kind, n.status, n.attempts, n.error, n.text.replace(/\s+/g, ' ')].map(cell).join('\t')

const sessionLine = (s: Session) =>
  [s.id, s.state, s.wait, s.turn, s.pane, s.claudeSessionId, s.lastEventAt].map(cell).join('\t')

interface Flags {
  all?: boolean
  refresh?: boolean
  on?: string
  done?: boolean
  session?: string
  project?: string
  id?: string
  repo?: string
  prompt?: string
  role?: string
  parent?: string
  space?: string
  'new-space'?: boolean
  name?: string
  title?: string
  facts?: string
  key?: string
  source?: string
  rotate?: boolean
  phase?: string
  note?: string
  until?: string
  why?: string
  summary?: string
  evidence?: string[]
  after?: string[]
  commit?: string[]
  document?: string
  kind?: string
  link?: string
  file?: string
  stdin?: boolean
  wake?: boolean
  attempt?: string
  reason?: string
  question?: string
  option?: string[]
  default?: string
  expires?: string
  decision?: string
  pending?: boolean
  since?: string
  state?: string
  limit?: string
  issue?: string
  live?: boolean
  'until-closed'?: boolean
}

/** `--facts @file` or `--facts -`: the text must be JSON, and the server keeps the size limit. */
async function readFacts(from: string, io: Io): Promise<unknown> {
  if (from !== '-' && !from.startsWith('@')) throw usage('--facts takes @file or - (stdin)')
  const text = await (from === '-'
    ? (io.stdin?.() ?? Promise.resolve(''))
    : Bun.file(from.slice(1))
        .text()
        .catch(() => {
          throw usage(`cannot read ${from.slice(1)}`)
        }))
  try {
    return JSON.parse(text)
  } catch {
    throw usage('--facts is not valid JSON')
  }
}

/** `door route set|rm|list`, `door unrouted` and `door token new`. */
async function door(words: string[], format: Format, flags: Flags, io: Io): Promise<void> {
  const print = (json: unknown, plain: string) => io.out(`${format === 'json' ? JSON.stringify(json) : plain}\n`)
  const key = words.slice(0, 3).join(' ')

  if (key === 'door route set') {
    const [, , , source, monitor, repo] = words
    if (!source || !monitor || !repo || words.length > 6) throw usage('usage: door route set <source> <monitor> <repo>')
    const { body } = await call(io, '/door/routes', {
      method: 'PUT',
      auth: true,
      schema: DoorRoute,
      body: { source, monitor, repo: resolve(repo) },
    })
    return print(body, routeLine(body))
  }

  if (key === 'door route rm') {
    const [, , , source, monitor] = words
    if (!source || !monitor || words.length > 5) throw usage('usage: door route rm <source> <monitor>')
    const { body } = await call(io, '/door/routes', {
      method: 'DELETE',
      auth: true,
      schema: DoorRoute,
      body: { source, monitor },
    })
    return print(body, routeLine(body))
  }

  if (words.join(' ') === 'door route list') {
    const { body } = await call(io, '/door/routes', { auth: true, schema: DoorRouteList })
    const lines = body.routes.map(routeLine)
    if (format === 'plain' && !lines.length) return
    return print(body, lines.join('\n'))
  }

  if (words.join(' ') === 'door unrouted') {
    const { body } = await call(io, '/door/unrouted', { auth: true, schema: DoorUnroutedList })
    const lines = body.unrouted.map(unroutedLine)
    if (format === 'plain' && !lines.length) return
    return print(body, lines.join('\n'))
  }

  if (key === 'door token new') {
    const source = words[3]
    if (!source || words.length > 4) throw usage('usage: door token new <source> [--rotate]')
    const { newToken, TokenExists, tokensFileFrom, TokensError } = await import('@software-factory/door/tokens')
    try {
      const token = newToken(tokensFileFrom(io.env), source, { rotate: flags.rotate })
      return print({ source, token }, token)
    } catch (error) {
      if (error instanceof TokenExists) throw new FactoryError('conflict', error.message)
      if (error instanceof TokensError) throw new FactoryError('general', error.message)
      throw error
    }
  }

  throw usage(
    'usage: door route set <source> <monitor> <repo> | door route rm <source> <monitor> | door route list | door unrouted | door token new <source>',
  )
}

const EVIDENCE = /^kind=([^,]+)(?:,link=([^,]+))?(?:,note=(.*))?$/s

/** `kind=screenshot,link=https://…,note=phone width` → the evidence the server stores. */
function parseEvidence(text: string): { kind: string; link?: string; note?: string } {
  const match = EVIDENCE.exec(text)
  if (!match?.[1]) throw usage('--evidence is kind=<kind>[,link=<url>][,note=<text>]')
  return { kind: match[1], ...(match[2] ? { link: match[2] } : {}), ...(match[3] ? { note: match[3] } : {}) }
}

/** What `issue evidence` records: a link, or the text of a file or of stdin, kept to the limit here so the answer says which. */
async function evidenceBody(flags: Flags, io: Io): Promise<{ link: string } | { text: string }> {
  const sources = [flags.link !== undefined, flags.file !== undefined, flags.stdin === true].filter(Boolean)
  if (sources.length !== 1) throw usage('issue evidence takes one of --link, --file and --stdin')
  if (flags.link !== undefined) return { link: flags.link }
  const text = flags.stdin
    ? await (io.stdin?.() ?? Promise.resolve(''))
    : await Bun.file(flags.file ?? '')
        .text()
        .catch(() => {
          throw usage(`cannot read ${flags.file}`)
        })
  if (!text) throw usage('the evidence is empty')
  if (Buffer.byteLength(text) > MAX_EVIDENCE_BYTES)
    throw usage(`the evidence is larger than ${MAX_EVIDENCE_BYTES} bytes`)
  return { text }
}

/** The body of a lead's verb from its flags; the server checks every value again. */
function verbBody(verb: IssueVerb, flags: Flags, io: Io): Record<string, unknown> {
  const need = (name: keyof Flags): string => {
    const value = flags[name]
    if (typeof value !== 'string' || !value) throw usage(`issue ${verb} needs --${name}`)
    return value
  }
  const session = flags.session ?? io.env.FACTORY_SESSION
  const common = { ...(flags.id ? { id: flags.id } : {}), ...(session ? { session } : {}) }
  const optional = (name: keyof Flags, field: string = name): Record<string, string> => {
    const value = flags[name]
    return typeof value === 'string' && value ? { [field]: value } : {}
  }
  switch (verb) {
    case 'phase':
      return { ...common, phase: need('phase'), ...optional('note') }
    case 'wait':
      return { ...common, until: need('until'), ...optional('why') }
    case 'ship':
      if (!flags.commit?.length) throw usage('issue ship needs --commit <merged sha>, once per commit')
      return {
        ...common,
        summary: need('summary'),
        commits: flags.commit,
        ...(flags.evidence?.length ? { evidence: flags.evidence.map(parseEvidence) } : {}),
      }
    case 'close':
      return {
        ...common,
        summary: need('summary'),
        ...(flags.commit?.length ? { commits: flags.commit } : {}),
        ...optional('document'),
      }
    case 'block':
    case 'drop':
      return { ...common, reason: need('reason') }
    case 'ask':
      return {
        ...common,
        question: need('question'),
        ...(flags.option?.length ? { options: flags.option } : {}),
        ...optional('default'),
        ...optional('expires', 'expiresAt'),
      }
  }
}

async function execute(words: string[], format: Format, flags: Flags, io: Io): Promise<void> {
  const print = (json: unknown, plain: string) => io.out(`${format === 'json' ? JSON.stringify(json) : plain}\n`)
  const key = words.join(' ')

  if (key === 'version') return print({ version: pkg.version }, pkg.version)

  if (key === 'health') {
    const { body } = await call(io, '/health', { auth: false, schema: Health, also: [503] })
    print(body, `${body.status}\t${body.version}`)
    if (body.status !== 'ok') {
      throw new FactoryError('general', `server is not ok: ${body.status}${body.reason ? ` (${body.reason})` : ''}`)
    }
    return
  }

  if (words[0] === 'read') return readVerb(words, format, flags, io)

  if (key === 'follow') return follow(format, flags, io)

  if (key === 'spawn list') {
    const { body } = await call(io, '/spawns', { auth: true, schema: SpawnList })
    const lines = body.spawns.map(spawnLine)
    if (format === 'plain' && !lines.length) return
    return print(body, lines.join('\n'))
  }

  if (words[0] === 'spawn' && words[1] === 'create') {
    const name = words[2]
    if (!name || words.length > 3 || !flags.repo || !flags.prompt) {
      throw usage(
        'usage: spawn create <key> --repo <path> --prompt <text> [--role <role>] [--parent <session>] [--space <path>] [--new-space]',
      )
    }
    const parent = flags.parent ?? io.env.FACTORY_SESSION
    // With a token it is the HTTP route; a pane has none, and goes by the socket (the same body, the same checks).
    const { body } = await call(io, '/spawns', {
      method: 'POST',
      auth: true,
      socket: 'fallback',
      schema: Spawn,
      body: {
        key: name,
        repo: resolve(flags.repo),
        prompt: flags.prompt,
        ...(flags.role ? { role: flags.role } : {}),
        ...(parent ? { parent } : {}),
        ...(flags.space ? { space: resolve(flags.space) } : {}),
        ...(flags['new-space'] ? { new_space: true } : {}),
      },
    })
    return print(body, spawnLine(body))
  }

  if (words[0] === 'spawn' && words[1] === 'get') {
    const target = words[2]
    if (!target || words.length > 3) throw usage('usage: spawn get <key>')
    const { body } = await call(io, `/spawns/${encodeURIComponent(target)}`, {
      auth: true,
      socket: 'fallback',
      schema: Spawn,
    })
    return print(body, spawnLine(body))
  }

  if (words[0] === 'fleet') {
    if (!io.env.FACTORY_TOKEN) {
      throw new FactoryError(
        'auth',
        "fleet needs FACTORY_TOKEN: the model holds IuRoot's text, which a pane's model must not read",
        {
          hint: 'run it under secrets-run with the repo .env.tpl, or export FACTORY_TOKEN',
        },
      )
    }
    if (words.length > 1) throw usage('usage: fleet [--refresh]')
    const refresh = flags.refresh === true
    const { body } = await call(io, refresh ? '/fleet/refresh' : '/fleet', {
      method: refresh ? 'POST' : 'GET',
      auth: true,
      timeoutMs: refresh ? 60_000 : undefined,
      schema: Fleet,
    })
    return print(body, fleetScreen(body))
  }

  if (key === 'status') {
    const { body } = await call(io, '/status', { auth: true, schema: Status })
    return print(body, statusScreen(body))
  }

  if (words[0] === 'session' && words[1] === 'note') {
    const target = words[2]
    const text = words.slice(3).join(' ')
    if (!target || !text) throw usage('usage: session note <session> <text> [--id <id>]')
    const { body } = await call(io, `/sessions/${encodeURIComponent(target)}/note`, {
      method: 'POST',
      auth: false,
      socket: true,
      schema: Prompt,
      body: { id: flags.id ?? `note:${crypto.randomUUID()}`, text },
    })
    return print(body, promptLine(body))
  }

  if (words[0] === 'spawn' && words[1] === 'cancel') {
    const target = words[2]
    if (!target || words.length > 3) throw usage('usage: spawn cancel <key>')
    const { body } = await call(io, `/spawns/${encodeURIComponent(target)}/cancel`, {
      method: 'POST',
      auth: true,
      socket: 'fallback',
      schema: Spawn,
    })
    return print(body, spawnLine(body))
  }

  if (words[0] === 'spawn' && words[1] === 'requeue') {
    const target = words[2]
    if (!target || words.length > 3) throw usage('usage: spawn requeue <key>')
    const { body } = await call(io, `/spawns/${encodeURIComponent(target)}/requeue`, {
      method: 'POST',
      auth: true,
      schema: Spawn,
    })
    return print(body, spawnLine(body))
  }

  if (key === 'session list') {
    const { body } = await call(io, `/sessions${flags.all ? '?all=1' : ''}`, { auth: true, schema: SessionList })
    const lines = body.sessions.map(sessionLine)
    if (format === 'plain' && !lines.length) return
    return print(body, lines.join('\n'))
  }

  if (words[0] === 'session' && words[1] === 'get') {
    const target = words[2]
    if (!target || words.length > 3) throw usage('usage: session get <id>')
    const { body } = await call(io, `/sessions/${encodeURIComponent(target)}`, {
      auth: true,
      socket: 'fallback',
      schema: Session,
    })
    return print(body, sessionLine(body))
  }

  if (key === 'session wait') {
    const target = flags.session ?? io.env.FACTORY_SESSION
    if (!target) throw usage('no session: set FACTORY_SESSION or pass --session <id>')
    if (Boolean(flags.done) === (flags.on !== undefined))
      throw usage('usage: session wait --on workers|deploy|owner | --done')
    const on = flags.on === undefined ? undefined : WaitOn.safeParse(flags.on)
    if (on && !on.success) throw usage(`--on must be workers, deploy or owner, got: ${flags.on}`)
    const { body } = await call(io, `/sessions/${encodeURIComponent(target)}/wait`, {
      method: 'POST',
      auth: false,
      socket: true,
      schema: Session,
      body: on?.success ? { on: on.data } : { done: true },
    })
    return print(body, sessionLine(body))
  }

  if (key === 'issue new') {
    if (!flags.repo || !flags.title) {
      throw usage(
        'usage: issue new --repo <path> --title <text> [--facts @file|-] [--key <key>] [--source <source>] [--after <id> …]',
      )
    }
    const facts = flags.facts === undefined ? undefined : await readFacts(flags.facts, io)
    const after = (flags.after ?? []).map((id) => {
      if (!/^[1-9][0-9]{0,9}$/.test(id)) throw usage(`--after takes an Issue id, not ${id}`)
      return Number(id)
    })
    const { body } = await call(io, '/issues', {
      method: 'POST',
      auth: true,
      socket: 'fallback',
      schema: Issue,
      body: {
        repo: resolve(flags.repo),
        title: flags.title,
        source_key: flags.key ?? crypto.randomUUID(),
        ...(flags.source ? { source: flags.source } : {}),
        ...(after.length > 0 ? { after } : {}),
        ...(facts === undefined ? {} : { facts }),
      },
    })
    return print(body, issueLine(body))
  }

  if (key === 'issue list') {
    const { body } = await call(io, '/issues', { auth: true, socket: 'fallback', schema: IssueList })
    const lines = body.issues.map(issueLine)
    if (format === 'plain' && !lines.length) return
    return print(body, lines.join('\n'))
  }

  if (key === 'issue facts') {
    if (flags.since !== undefined && !IsoTime.safeParse(flags.since).success) {
      throw usage('--since takes an ISO 8601 time with a Z or an offset, like 2026-11-02T07:30:00Z')
    }
    const query = flags.since === undefined ? '' : `?since=${encodeURIComponent(flags.since)}`
    const { body } = await call(io, `/issues/facts${query}`, { auth: true, socket: 'fallback', schema: IssueFactsRead })
    return print(body, [...body.rows.map(factLine), kpiLine(body.kpi)].join('\n'))
  }

  if (words[0] === 'issue' && words[1] === 'show') {
    const target = words[2]
    if (!target || words.length > 3) throw usage('usage: issue show <id>')
    const { body } = await call(io, `/issues/${encodeURIComponent(target)}/timeline`, {
      auth: true,
      socket: 'fallback',
      schema: IssueView,
    })
    return print(body, issueViewScreen(body))
  }

  if (words[0] === 'issue' && words[1] === 'note') {
    const target = words[2]
    const text = words.slice(3).join(' ')
    if (!target || !/^[1-9][0-9]{0,9}$/.test(target) || !text)
      throw usage('usage: issue note <id> <text> [--wake] [--id <call id>]')
    if (!io.env.FACTORY_TOKEN) {
      throw new FactoryError('auth', "issue note needs FACTORY_TOKEN: it is the owner's note, a pane has none", {
        hint: 'run it under secrets-run with the repo .env.tpl, or export FACTORY_TOKEN',
      })
    }
    const { body } = await call(io, `/issues/${target}/note`, {
      method: 'POST',
      auth: true,
      schema: IssueNoteAck,
      body: { text, ...(flags.wake ? { wake: true } : {}), ...(flags.id ? { id: flags.id } : {}) },
    })
    return print(body, [body.issue, 'note', body.duplicate ? 'duplicate' : 'filed', body.key, body.state].join('\t'))
  }

  if (words[0] === 'issue' && words[1] === 'prio') {
    const [, , target, value] = words
    const n = Number(value)
    if (
      !target ||
      !/^[1-9][0-9]{0,9}$/.test(target) ||
      words.length !== 4 ||
      !/^-?[0-9]+$/.test(value ?? '') ||
      Math.abs(n) > PRIO_LIMIT
    )
      throw usage(`usage: issue prio <id> <n> [--id <call id>] (n an integer, -${PRIO_LIMIT}..${PRIO_LIMIT})`)
    if (!io.env.FACTORY_TOKEN) {
      throw new FactoryError('auth', "issue prio needs FACTORY_TOKEN: it is the owner's order, a pane has none", {
        hint: 'run it under secrets-run with the repo .env.tpl, or export FACTORY_TOKEN',
      })
    }
    const { body } = await call(io, `/issues/${target}/prio`, {
      method: 'POST',
      auth: true,
      schema: IssuePrioAck,
      body: { value: n, ...(flags.id ? { id: flags.id } : {}) },
    })
    return print(body, [body.issue, 'prio', body.duplicate ? 'duplicate' : 'filed', body.key, body.state].join('\t'))
  }

  if (words[0] === 'issue' && words[1] === 'answer') {
    const target = words[2]
    const answer = words.slice(3).join(' ')
    if (!target || !/^[1-9][0-9]{0,9}$/.test(target) || !answer)
      throw usage('usage: issue answer <id> <text> [--decision <id>] [--id <call id>]')
    const decision = flags.decision === undefined ? undefined : Number(flags.decision)
    if (decision !== undefined && !/^[1-9][0-9]{0,15}$/.test(flags.decision ?? ''))
      throw usage('--decision is a question id')
    if (!io.env.FACTORY_TOKEN) {
      throw new FactoryError(
        'auth',
        'issue answer needs FACTORY_TOKEN: a pane has none, so a lead cannot answer itself',
        {
          hint: 'run it under secrets-run with the repo .env.tpl, or export FACTORY_TOKEN',
        },
      )
    }
    const { body } = await call(io, `/issues/${target}/answer`, {
      method: 'POST',
      auth: true,
      schema: IssueAnswerAck,
      body: {
        answer,
        ...(decision === undefined ? {} : { decision }),
        ...(flags.id ? { id: flags.id } : {}),
      },
    })
    return print(body, [body.issue, 'answer', body.duplicate ? 'duplicate' : 'filed', body.key, body.state].join('\t'))
  }

  if (key === 'notify list' || key === 'notify test') {
    if (key === 'notify test') {
      const { body } = await call(io, '/notifications/test', {
        method: 'POST',
        auth: true,
        timeoutMs: 30_000,
        schema: Notification,
      })
      print(body, notificationLine(body))
      // A sent row that still carries an error was counted as sent without a delivery: the notifier is off.
      if (body.status !== 'sent' || body.error) {
        throw new FactoryError('general', `the test message was not delivered${body.error ? `: ${body.error}` : ''}`)
      }
      return
    }
    const { body } = await call(io, `/notifications${flags.pending ? '?pending=1' : ''}`, {
      auth: true,
      schema: NotificationList,
    })
    const lines = body.notifications.map(notificationLine)
    if (format === 'plain' && !lines.length) return
    return print(body, lines.join('\n'))
  }

  if (words[0] === 'issue' && words[1] === 'evidence') {
    const target = words[2]
    if (!target || words.length > 3 || !/^[1-9][0-9]{0,9}$/.test(target) || !flags.kind) {
      throw usage('usage: issue evidence <id> --kind <kind> (--link <url> | --file <path> | --stdin)')
    }
    const session = flags.session ?? io.env.FACTORY_SESSION
    const { body } = await call(io, `/issues/${target}/evidence`, {
      method: 'POST',
      auth: true,
      socket: 'fallback',
      schema: IssueEvidenceAck,
      body: {
        kind: flags.kind,
        ...(await evidenceBody(flags, io)),
        ...(flags.id ? { id: flags.id } : {}),
        ...(session ? { session } : {}),
      },
    })
    return print(body, [body.issue, body.kind, body.duplicate ? 'duplicate' : 'filed', body.key, body.at].join('\t'))
  }

  if (words[0] === 'issue' && (words[1] === 'reopen' || words[1] === 'stop')) {
    const [, verb, target] = words
    if (!target || words.length > 3 || !/^[1-9][0-9]{0,9}$/.test(target) || !flags.reason) {
      throw usage(`usage: issue ${verb} <id> --reason <text>`)
    }
    // `stop` is the owner's and takes the token; no pane reaches it by the socket.
    const { status, body } = await call(io, `/issues/${target}/${verb}`, {
      method: 'POST',
      auth: true,
      ...(verb === 'reopen' ? { socket: 'fallback' as const } : {}),
      schema: Issue,
      timeoutMs: GIT_CALL_TIMEOUT_MS,
      body: { reason: flags.reason, ...(flags.id ? { id: flags.id } : {}) },
    })
    print(body, issueLine(body))
    if (status === 202) {
      throw new FactoryError('pending', `the ${verb} is filed and not answered yet`, {
        hint: `\`${BIN} issue show ${body.id}\` shows where the Issue stands`,
      })
    }
    return
  }

  if (words[0] === 'issue' && words[1] === 'resume') {
    const target = words[2]
    const attempt = flags.attempt === undefined ? undefined : Number(flags.attempt)
    if (!target || words.length > 3 || !/^[1-9][0-9]{0,9}$/.test(target) || Number.isNaN(attempt)) {
      throw usage('usage: issue resume <id> [--attempt <n>]')
    }
    const { body } = await call(io, `/issues/${target}/resume`, {
      method: 'POST',
      auth: true,
      socket: 'fallback',
      schema: Spawn,
      body: { ...(attempt === undefined ? {} : { attempt }), ...(flags.id ? { id: flags.id } : {}) },
    })
    return print(body, spawnLine(body))
  }

  const verb = words[0] === 'issue' ? IssueVerb.safeParse(words[1]) : undefined
  if (verb?.success) {
    const target = words[2]
    if (!target || words.length > 3 || !/^[1-9][0-9]{0,9}$/.test(target))
      throw usage(`usage: issue ${verb.data} <id> [flags]`)
    const { body } = await call(io, `/issues/${target}/${verb.data}`, {
      method: 'POST',
      auth: true,
      socket: 'fallback',
      schema: IssueVerbAck,
      timeoutMs: GIT_CALL_TIMEOUT_MS,
      body: verbBody(verb.data, flags, io),
    })
    print(body, [body.issue, body.verb, body.duplicate ? 'duplicate' : 'filed', body.key, body.state].join('\t'))
    // `ship` and `close` are answered by the lifecycle (a refusal is exit 5); an answer that is not in yet is not a success.
    if ((verb.data === 'ship' || verb.data === 'close') && body.result === null) {
      throw new FactoryError('pending', `${verb.data} is filed and not answered yet`, {
        hint: `\`${BIN} issue show ${body.issue}\` shows where the Issue stands`,
      })
    }
    return
  }

  if (key === 'project list') {
    const { body } = await call(io, '/projects', { auth: true, socket: 'fallback', schema: ProjectList })
    const lines = body.projects.map(projectLine)
    if (format === 'plain' && !lines.length) return
    return print(body, lines.join('\n'))
  }

  if (words[0] === 'project' && words[1] === 'show') {
    const target = words[2]
    if (!target || words.length > 3) throw usage('usage: project show <name>')
    const { body } = await call(io, `/projects/${encodeURIComponent(target)}`, {
      auth: true,
      socket: 'fallback',
      schema: Project,
    })
    return print(body, projectScreen(body))
  }

  if (key === 'project sync') {
    const { body } = await call(io, '/projects/sync', {
      method: 'POST',
      auth: true,
      schema: ProjectSyncResult,
      timeoutMs: GIT_CALL_TIMEOUT_MS,
    })
    const lines = [
      `synced ${body.synced}`,
      ...body.broken.map((b) => `broken ${b.project}${b.issue === null ? '' : ` #${b.issue}`}`),
      ...body.errors.map((e) => `error ${e}`),
    ]
    return print(body, lines.join('\n'))
  }
  if (words[0] === 'door') return door(words, format, flags, io)

  if (key === 'queue get') {
    const query = flags.project === undefined ? '' : `?project=${encodeURIComponent(resolve(flags.project))}`
    const { body } = await call(io, `/queue${query}`, { auth: true, socket: 'fallback', schema: QueueView })
    return print(body, queueLine(body))
  }

  if (words[0] === 'queue' && words[1] === 'set') {
    const state = QueueState.safeParse(words[2])
    if (!state.success || words.length > 3) throw usage('usage: queue set run|pace|drain [--project <path>]')
    const { body } = await call(io, '/queue', {
      method: 'PUT',
      auth: true,
      schema: QueueView,
      body: { state: state.data, ...(flags.project === undefined ? {} : { project: resolve(flags.project) }) },
    })
    return print(body, queueLine(body))
  }

  if (key === 'quota get' || key === 'quota refresh') {
    const refresh = key === 'quota refresh'
    const { body } = await call(io, refresh ? '/quota/refresh' : '/quota', {
      method: refresh ? 'POST' : 'GET',
      auth: true,
      schema: QuotaList,
    })
    const lines = body.quota.map(quotaLine)
    if (format === 'plain' && !lines.length) return
    return print(body, lines.join('\n'))
  }

  if (words[0] === 'role') {
    const table = await loadRoleTable(io.env.FACTORY_ROLES_FILE || DEFAULT_ROLES_FILE).catch((error) => {
      throw new FactoryError('general', error instanceof Error ? error.message : String(error))
    })
    if (key === 'role list') {
      const roles = [...table.values()]
      return print({ roles }, roles.map(roleLine).join('\n'))
    }
    if (words[1] === 'get' && words.length === 3) {
      const entry = table.get(words[2] ?? '')
      if (!entry) {
        throw new FactoryError('not_found', `unknown role ${words[2]}`, {
          hint: `one of ${[...table.keys()].join(', ')}`,
        })
      }
      return print(entry, roleLine(entry))
    }
    throw usage('usage: role list | role get <role>')
  }

  throw usage(words.length ? `unknown command: ${key}` : 'no command', `${BIN} --help lists the commands`)
}

/** Runs one invocation and returns its exit code. Nothing asks anything; stdin is read only for `--facts -`. */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
    } catch (error) {
      throw usage(error instanceof Error ? error.message : String(error), `${BIN} --help lists the flags`)
    }
    if (parsed.values.help) {
      io.out(HELP)
      return EXIT.ok
    }
    const format = parsed.values.format ?? 'json'
    if (format !== 'json' && format !== 'plain') throw usage(`--format must be json or plain, got: ${format}`)
    if (!parsed.positionals.length) {
      io.out(HELP)
      return EXIT.ok
    }
    // The command's own exit code is this process's: it does not go through `execute`, which only prints.
    if (parsed.positionals[0] === 'slot') {
      if (parsed.positionals[1] !== 'run') throw usage('usage: slot run [--name <label>] -- <cmd> [args…]')
      const { slotRun } = await import('./slot.ts')
      return await slotRun({ name: parsed.values.name, command: parsed.positionals.slice(2) }, io)
    }
    await execute(parsed.positionals, format, parsed.values, io)
    return EXIT.ok
  } catch (error) {
    if (error instanceof FactoryError) {
      io.err(`${error.toErrorLine()}\n`)
      return error.exitCode
    }
    io.err(`${new FactoryError('general', error instanceof Error ? error.message : String(error)).toErrorLine()}\n`)
    return EXIT.general
  }
}

const OPTIONS = {
  format: { type: 'string' },
  all: { type: 'boolean' },
  refresh: { type: 'boolean' },
  on: { type: 'string' },
  done: { type: 'boolean' },
  session: { type: 'string' },
  project: { type: 'string' },
  id: { type: 'string' },
  repo: { type: 'string' },
  prompt: { type: 'string' },
  role: { type: 'string' },
  parent: { type: 'string' },
  space: { type: 'string' },
  'new-space': { type: 'boolean' },
  name: { type: 'string' },
  title: { type: 'string' },
  facts: { type: 'string' },
  key: { type: 'string' },
  source: { type: 'string' },
  after: { type: 'string', multiple: true },
  rotate: { type: 'boolean' },
  phase: { type: 'string' },
  note: { type: 'string' },
  until: { type: 'string' },
  why: { type: 'string' },
  summary: { type: 'string' },
  evidence: { type: 'string', multiple: true },
  commit: { type: 'string', multiple: true },
  document: { type: 'string' },
  kind: { type: 'string' },
  link: { type: 'string' },
  file: { type: 'string' },
  stdin: { type: 'boolean' },
  wake: { type: 'boolean' },
  attempt: { type: 'string' },
  reason: { type: 'string' },
  question: { type: 'string' },
  option: { type: 'string', multiple: true },
  default: { type: 'string' },
  expires: { type: 'string' },
  decision: { type: 'string' },
  pending: { type: 'boolean' },
  since: { type: 'string' },
  state: { type: 'string' },
  limit: { type: 'string' },
  issue: { type: 'string' },
  live: { type: 'boolean' },
  'until-closed': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const
