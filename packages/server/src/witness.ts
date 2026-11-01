import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SQL } from 'bun'
import type { Clock } from './clock.ts'
import { childEnv, runProcess } from './exec.ts'
import { agentName } from './runner.ts'
import { paneGoneWithdrawn, recordEvent, RUNNER_SESSION, TERMINAL_ADDRESS } from './sessions.ts'

export const WITNESS_INTERVAL_MS = 60_000
/** A change the runner announces is looked at after this long, so a burst (lost, restarted, a status) is one pass. */
export const WITNESS_DEBOUNCE_MS = 2_000
const PROBE_CONCURRENCY = 4
/** Consecutive passes with no runner agent for a session before its pane counts as gone. */
export const MISSES_FOR_GONE = 2
/** `pid@core id`, what `serverId()` answers; the format before it (`pid@start time`) is read as "not known yet". */
const SERVER_ID = /^\d+@[0-9a-f]{32}$/

/** What the runner says about one agent. */
export interface AgentSeen {
  /** the terminal's address */
  paneId: string
  /** the name the agent was started under: `rd`'s agent name, or the spawn key as the runner spells it */
  name?: string
  /** the terminal's `factory.key` label: the spawn key, which is the session id */
  factoryKey?: string
  /** `working`, `idle`, `blocked`, ...; null while the agent has said nothing */
  status: string | null
  claudeSessionId?: string
  cwd?: string
}

/** What the runner announces between two passes. */
export type RunnerChange =
  | { kind: 'status'; agent: AgentSeen }
  /** a terminal was lost, finished, removed or restarted as a shell: the agent in it is gone */
  | { kind: 'gone'; paneId: string; factoryKey?: string }
  /** the core is not the one the stream was last connected to */
  | { kind: 'restart' }

/** What the witness needs of the runner; the adapter (`HcEvents`) is the only place that knows how it answers. */
export interface RunnerView {
  /** throws when the runner does not answer: a pass with no answer records nothing */
  agents(): Promise<AgentSeen[]>
  /** who the runner's server is right now (process id and core id); undefined when it cannot be told */
  serverId(): Promise<string | undefined>
  /** changes as they happen; returns the way to stop listening */
  watch?(listener: (change: RunnerChange) => void): () => void
}

/** When the files or commits of a worktree last changed. */
export type WorktreeProbe = (cwd: string) => Promise<Date | undefined>

/**
 * `git log` and `git status` are read without taking a lock the agent's own git could wait on, with the server's
 * secrets out of git's environment and with no repository setting that runs a program (`core.fsmonitor`, hooks): the
 * agent controls the worktree's `.git/config`.
 */
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' }
const GIT_SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']
const MAX_STATTED_FILES = 300
const GIT_TIMEOUT_MS = 8_000

/**
 * The newest of: the last commit, and the modification time of every file git lists as changed or new. Undefined when
 * the directory is not a worktree or git does not answer in time.
 */
export const gitProbe = async (cwd: string, gitBin = 'git'): Promise<Date | undefined> => {
  const env = childEnv(GIT_ENV)
  const git = (...args: string[]) =>
    runProcess([gitBin, '-C', cwd, ...GIT_SAFE, ...args], GIT_TIMEOUT_MS, env).catch(() => undefined)
  const head = await git('log', '-1', '--format=%ct')
  if (head?.exitCode !== 0) return undefined
  let newest = Number(head.stdout.trim()) * 1000 || 0
  // `status` lists paths from the repository root, wherever in the worktree the agent stands.
  const [top, status] = await Promise.all([
    git('rev-parse', '--show-toplevel'),
    git('status', '--porcelain=v1', '-z', '--no-renames'),
  ])
  const root = top?.exitCode === 0 ? top.stdout.trim() : cwd
  if (status?.exitCode === 0) {
    const paths = status.stdout
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.slice(3))
      .slice(0, MAX_STATTED_FILES)
    const times = await Promise.all(
      paths.map((p) =>
        stat(join(root, p)).then(
          (s) => s.mtimeMs,
          () => 0,
        ),
      ),
    )
    newest = Math.max(newest, ...times)
  }
  return newest > 0 ? new Date(newest) : undefined
}

export interface WitnessDeps {
  sql: SQL
  runner: RunnerView
  clock: Clock
  probe: WorktreeProbe
}

export interface WitnessResult {
  seen: number
  restarted: boolean
  gone: string[]
}

interface Row {
  id: string
  pane: string | null
  claude_session_id: string | null
  cwd: string | null
  pane_misses: number
  agent_seen_at: Date | null
  /** the last of session_started / session_ended / pane_gone, and when */
  life: string | null
  life_at: Date | null
  hook_after: boolean
}

function match(row: Row, all: readonly AgentSeen[]): AgentSeen | undefined {
  // A terminal that carries another session's key is that session's, whatever its address, name or Claude session id say
  // (addresses are reused after a core is wiped).
  const agents = all.filter((a) => a.factoryKey === undefined || a.factoryKey === row.id)
  return (
    agents.find((a) => a.factoryKey === row.id) ??
    (row.claude_session_id ? agents.find((a) => a.claudeSessionId === row.claude_session_id) : undefined) ??
    (row.pane ? agents.find((a) => a.paneId === row.pane) : undefined) ??
    agents.find((a) => a.name === row.id || a.name === agentName(row.id))
  )
}

/**
 * One pass: ask the runner what it runs, record it, and report what hooks cannot show.
 *
 * - The runner's server changing (core pid or id) is the event `runner_restarted`. A stored identity in the older format
 *   (`pid@start time`, from before herdr-core) is replaced without an event: nothing is known to have restarted.
 * - Each session's agent is found (by its `factory.key` label, Claude session id, terminal address or name); its status
 *   and the worktree's last change are stored for `stuck`.
 * - A session no agent matches for two passes in a row, and whose pane is a terminal of this core, has a gone pane:
 *   `pane_gone`, which is `dead`. Not in the pass where the runner itself restarted, when its terminals are coming back.
 */
export async function witness(deps: WitnessDeps): Promise<WitnessResult> {
  const { sql, runner, clock } = deps
  const agents = await runner.agents()
  const server = await runner.serverId()
  const now = clock.now()

  let restarted = false
  if (server) {
    const [known] = await sql`SELECT value FROM factory.witness WHERE name = 'runner_server'`
    if (known && SERVER_ID.test(known.value) && known.value !== server) {
      restarted = true
      await recordEvent(sql, {
        key: `runner_restarted:${server}`,
        session: RUNNER_SESSION,
        kind: 'runner_restarted',
        at: now,
        payload: { from: known.value, to: server },
      })
    }
    await sql`
      INSERT INTO factory.witness (name, value, at) VALUES ('runner_server', ${server}, ${now})
      ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, at = EXCLUDED.at`
  }

  const rows: Row[] = await sql`
    SELECT s.id, s.pane, s.claude_session_id, s.cwd, s.pane_misses, s.agent_seen_at, l.kind AS life, l.at AS life_at,
           EXISTS (
             SELECT 1 FROM factory.events h
             WHERE h.session = s.id AND h.at > l.at
               AND h.kind IN ('session_started', 'turn_started', 'turn_ended', 'limit_stop', 'quota_resume', 'prompt_blocked', 'prompt_idle')
           ) AS hook_after
    FROM factory.sessions s
    LEFT JOIN LATERAL (
      SELECT kind, at FROM factory.events
      WHERE session = s.id AND kind IN ('session_started', 'session_ended', 'pane_gone')
      ORDER BY at DESC, id DESC LIMIT 1) l ON true`

  const gone: string[] = []
  const probes: (() => Promise<void>)[] = []
  for (const row of rows) {
    // An ended session is history. One whose pane was reported gone is still looked for: an agent that comes back
    // (the runner was slow, a pane was renamed) takes the session out of `dead` again.
    if (row.life === 'session_ended') continue
    const agent = match(row, agents)
    if (agent) {
      await sql`
        UPDATE factory.sessions
        SET pane = ${agent.paneId}, agent_status = ${agent.status}, agent_seen_at = ${now},
            herdr_status = ${agent.status}, herdr_seen_at = ${now}, pane_misses = 0
        WHERE id = ${row.id}`
      const dir = row.cwd ?? agent.cwd
      if (agent.status === 'working' && dir) {
        probes.push(async () => {
          const changed = await deps.probe(dir)
          if (changed) await sql`UPDATE factory.sessions SET worktree_changed_at = ${changed} WHERE id = ${row.id}`
        })
      }
      continue
    }
    // Nothing to conclude from a runner that could not be identified, or one that has just restarted, or from a pane
    // that is not a terminal of this core (an `rd` session still in a classic pane): the witness cannot see it.
    const stillGone =
      row.life === 'pane_gone' &&
      row.life_at !== null &&
      !paneGoneWithdrawn({ goneAt: row.life_at, hookAfter: row.hook_after, agentSeenAt: row.agent_seen_at })
    if (!row.pane || !TERMINAL_ADDRESS.test(row.pane) || restarted || !server || stillGone) continue
    const misses = row.pane_misses + 1
    await sql`UPDATE factory.sessions SET pane_misses = ${misses}, agent_status = NULL, herdr_status = NULL WHERE id = ${row.id}`
    if (misses < MISSES_FOR_GONE) continue
    // One key per disappearance: a pane that came back and went again is a second event, not a replay of the first.
    const [{ starts, gones }] = await sql`
      SELECT count(*) FILTER (WHERE kind = 'session_started')::int AS starts,
             count(*) FILTER (WHERE kind = 'pane_gone')::int AS gones
      FROM factory.events WHERE session = ${row.id}`
    await recordEvent(sql, {
      key: `${row.id}:pane_gone:${starts}:${gones + 1}`,
      session: row.id,
      kind: 'pane_gone',
      at: now,
      payload: { pane: row.pane },
    })
    gone.push(row.id)
  }
  // A few at a time: each probe is two git processes and a stat per changed file.
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, probes.length) }, async () => {
      for (let probe = probes.shift(); probe; probe = probes.shift()) await probe()
    }),
  )
  return { seen: agents.length, restarted, gone }
}

/**
 * Runs the witness now, then every interval, and in between when the runner announces something: an agent's status is
 * stored at once (a cheap update, so `stuck` and `blocked` do not lag a minute), and a lost, finished or removed terminal
 * of a known session, or a restarted core, asks for a pass after a short debounce. A pass that fails is logged and the
 * next one tries again.
 */
export function startWitness(
  deps: WitnessDeps,
  intervalMs: number = WITNESS_INTERVAL_MS,
  debounceMs: number = WITNESS_DEBOUNCE_MS,
): { stop(): Promise<void> } {
  let inFlight: Promise<void> | undefined
  let again = false
  let stopped = false
  let debounce: Timer | undefined
  const pass = () => {
    if (stopped) return
    if (inFlight) {
      again = true
      return
    }
    inFlight = witness(deps)
      .then((result) => {
        if (result.restarted || result.gone.length) console.log('witness', result)
      })
      .catch((error) => console.error('witness failed', error instanceof Error ? error.message : String(error)))
      .finally(() => {
        inFlight = undefined
        if (again) {
          again = false
          pass()
        }
      })
  }
  const soon = () => {
    if (stopped || debounce) return
    debounce = setTimeout(() => {
      debounce = undefined
      pass()
    }, debounceMs)
  }

  const onChange = async (change: RunnerChange) => {
    if (change.kind === 'restart') return soon()
    if (change.kind === 'gone') {
      const known = await deps.sql`
        SELECT 1 FROM factory.sessions
        WHERE ${change.factoryKey === undefined ? deps.sql`pane = ${change.paneId}` : deps.sql`id = ${change.factoryKey}`}
        LIMIT 1`
      if (known.length > 0) soon()
      return
    }
    const { agent } = change
    const now = deps.clock.now()
    await deps.sql`
      UPDATE factory.sessions
      SET agent_status = ${agent.status}, agent_seen_at = ${now}, herdr_status = ${agent.status}, herdr_seen_at = ${now}
      WHERE ${agent.factoryKey === undefined ? deps.sql`pane = ${agent.paneId}` : deps.sql`id = ${agent.factoryKey}`}`
  }
  const unwatch = deps.runner.watch?.((change) => {
    onChange(change).catch((error) =>
      console.error('witness change failed', error instanceof Error ? error.message : String(error)),
    )
  })

  pass()
  const timer = setInterval(pass, intervalMs)
  return {
    stop: async () => {
      stopped = true
      clearInterval(timer)
      clearTimeout(debounce)
      unwatch?.()
      await inFlight
    },
  }
}
