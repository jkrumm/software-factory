import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SQL } from 'bun'
import { z } from 'zod'
import type { Clock } from './clock.ts'
import { DEFAULT_PROCESS_TIMEOUT_MS, EXIT_TIMEOUT, runProcess } from './exec.ts'
import { agentName } from './runner.ts'
import { HERDR_SESSION, recordEvent } from './sessions.ts'

export const WITNESS_INTERVAL_MS = 60_000
/** Consecutive passes with no herdr agent for a session before its pane counts as gone. */
export const MISSES_FOR_GONE = 2

/** What herdr says about one agent. */
export interface AgentSeen {
  paneId: string
  /** the name the agent was started under: `rd`'s agent name, or the spawn key as herdr spells it */
  name?: string
  status: string
  claudeSessionId?: string
  cwd?: string
}

/** What the witness needs of herdr; the adapter below is the only place that knows how herdr answers. */
export interface HerdrView {
  /** throws when herdr does not answer: a pass with no answer records nothing */
  agents(): Promise<AgentSeen[]>
  /** who the herdr server is right now (process id and start time); undefined when it cannot be told */
  serverId(): Promise<string | undefined>
}

/** When the files or commits of a worktree last changed. */
export type WorktreeProbe = (cwd: string) => Promise<Date | undefined>

const AgentList = z.object({
  result: z.object({
    agents: z.array(
      z.object({
        agent: z.string().optional(),
        agent_status: z.string(),
        pane_id: z.string(),
        name: z.string().optional(),
        cwd: z.string().optional(),
        agent_session: z.object({ value: z.string() }).partial().optional(),
      }),
    ),
  }),
})

/** herdr through its CLI, every call under the Wave 1 process timeout. */
export class HerdrCli implements HerdrView {
  constructor(private readonly options: { bin: string; timeoutMs?: number; psBin?: string }) {}

  async agents(): Promise<AgentSeen[]> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS
    const result = await runProcess([this.options.bin, 'agent', 'list'], timeoutMs)
    if (result.exitCode === EXIT_TIMEOUT) throw new Error(`herdr agent list timed out after ${timeoutMs} ms`)
    let body: unknown
    try {
      body = JSON.parse(result.stdout)
    } catch {
      throw new Error(`herdr agent list exited ${result.exitCode} and printed something unexpected`)
    }
    const parsed = AgentList.safeParse(body)
    if (!parsed.success) throw new Error(`herdr agent list: ${parsed.error.issues[0]?.message ?? 'unexpected shape'}`)
    return parsed.data.result.agents
      .filter((a) => a.agent === 'claude')
      .map((a) => ({
        paneId: a.pane_id,
        name: a.name,
        status: a.agent_status,
        claudeSessionId: a.agent_session?.value,
        cwd: a.cwd,
      }))
  }

  /** herdr has no call that names its server's process: the process table does (`herdr server`, started by launchd). */
  async serverId(): Promise<string | undefined> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS
    const result = await runProcess([this.options.psBin ?? 'ps', '-axo', 'pid=,lstart=,command='], timeoutMs).catch(
      () => undefined,
    )
    if (!result || result.exitCode !== 0) return undefined
    const servers = result.stdout.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]{8}\s+\d{4})\s+(\S*herdr)\s+server$/.exec(line)
      return match ? [`${match[1]}@${(match[2] ?? '').replace(/\s+/g, ' ')}`] : []
    })
    return servers.length ? servers.sort().join(',') : undefined
  }
}

/** `git log` and `git status` are read without taking a lock the agent's own git could wait on. */
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' }
const MAX_STATTED_FILES = 300
const GIT_TIMEOUT_MS = 8_000

/**
 * The newest of: the last commit, and the modification time of every file git lists as changed or new. Undefined when
 * the directory is not a worktree or git does not answer in time.
 */
export const gitProbe: WorktreeProbe = async (cwd) => {
  const env = { ...process.env, ...GIT_ENV }
  const head = await runProcess(['git', '-C', cwd, 'log', '-1', '--format=%ct'], GIT_TIMEOUT_MS, env).catch(
    () => undefined,
  )
  if (!head || head.exitCode !== 0) return undefined
  let newest = Number(head.stdout.trim()) * 1000 || 0
  const status = await runProcess(
    ['git', '-C', cwd, 'status', '--porcelain=v1', '-z', '--no-renames'],
    GIT_TIMEOUT_MS,
    env,
  ).catch(() => undefined)
  if (status?.exitCode === 0) {
    const paths = status.stdout
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.slice(3))
      .slice(0, MAX_STATTED_FILES)
    const times = await Promise.all(
      paths.map((p) =>
        stat(join(cwd, p)).then(
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
  herdr: HerdrView
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
  /** the last of session_started / session_ended / pane_gone */
  life: string | null
}

function match(row: Row, agents: readonly AgentSeen[]): AgentSeen | undefined {
  return (
    (row.claude_session_id ? agents.find((a) => a.claudeSessionId === row.claude_session_id) : undefined) ??
    (row.pane ? agents.find((a) => a.paneId === row.pane) : undefined) ??
    agents.find((a) => a.name === row.id || a.name === agentName(row.id))
  )
}

/**
 * One pass: ask herdr what it runs, record it, and report what hooks cannot show.
 *
 * - herdr's server process changing is the event `herdr_restarted`.
 * - Each session's agent is found (by Claude session id, pane or name); its status and the worktree's last change are
 *   stored for `stuck`.
 * - A session no agent matches for two passes in a row, and whose pane was known, has a gone pane: `pane_gone`, which
 *   is `dead`. Not in the pass where herdr itself restarted, when its panes are still coming back.
 */
export async function witness(deps: WitnessDeps): Promise<WitnessResult> {
  const { sql, herdr, clock } = deps
  const agents = await herdr.agents()
  const server = await herdr.serverId()
  const now = clock.now()

  let restarted = false
  if (server) {
    const [known] = await sql`SELECT value FROM factory.witness WHERE name = 'herdr_server'`
    if (known && known.value !== server) {
      restarted = true
      await recordEvent(sql, {
        key: `herdr_restarted:${server}`,
        session: HERDR_SESSION,
        kind: 'herdr_restarted',
        at: now,
        payload: { from: known.value, to: server },
      })
    }
    await sql`
      INSERT INTO factory.witness (name, value, at) VALUES ('herdr_server', ${server}, ${now})
      ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, at = EXCLUDED.at`
  }

  const rows: Row[] = await sql`
    SELECT s.id, s.pane, s.claude_session_id, s.cwd, s.pane_misses, l.kind AS life
    FROM factory.sessions s
    LEFT JOIN LATERAL (
      SELECT kind FROM factory.events
      WHERE session = s.id AND kind IN ('session_started', 'session_ended', 'pane_gone')
      ORDER BY at DESC, id DESC LIMIT 1) l ON true`

  const gone: string[] = []
  const probes: Promise<void>[] = []
  for (const row of rows) {
    if (row.life === 'session_ended' || row.life === 'pane_gone') continue
    const agent = match(row, agents)
    if (agent) {
      await sql`
        UPDATE factory.sessions
        SET pane = ${agent.paneId}, herdr_status = ${agent.status}, herdr_seen_at = ${now}, pane_misses = 0
        WHERE id = ${row.id}`
      const dir = row.cwd ?? agent.cwd
      if (agent.status === 'working' && dir) {
        probes.push(
          deps.probe(dir).then(async (changed) => {
            if (changed) await sql`UPDATE factory.sessions SET worktree_changed_at = ${changed} WHERE id = ${row.id}`
          }),
        )
      }
      continue
    }
    if (!row.pane || restarted) continue
    const misses = row.pane_misses + 1
    await sql`UPDATE factory.sessions SET pane_misses = ${misses}, herdr_status = NULL WHERE id = ${row.id}`
    if (misses < MISSES_FOR_GONE) continue
    const [{ starts }] = await sql`
      SELECT count(*)::int AS starts FROM factory.events WHERE session = ${row.id} AND kind = 'session_started'`
    await recordEvent(sql, {
      key: `${row.id}:pane_gone:${starts}`,
      session: row.id,
      kind: 'pane_gone',
      at: now,
      payload: { pane: row.pane },
    })
    gone.push(row.id)
  }
  await Promise.all(probes)
  return { seen: agents.length, restarted, gone }
}

/** Runs the witness now and then every interval; a pass that fails is logged and the next one tries again. */
export function startWitness(deps: WitnessDeps, intervalMs: number = WITNESS_INTERVAL_MS): { stop(): Promise<void> } {
  let inFlight: Promise<void> | undefined
  let stopped = false
  const pass = () => {
    if (stopped || inFlight) return
    inFlight = witness(deps)
      .then((result) => {
        if (result.restarted || result.gone.length) console.log('witness', result)
      })
      .catch((error) => console.error('witness failed', error instanceof Error ? error.message : String(error)))
      .finally(() => {
        inFlight = undefined
      })
  }
  pass()
  const timer = setInterval(pass, intervalMs)
  return {
    stop: async () => {
      stopped = true
      clearInterval(timer)
      await inFlight
    },
  }
}
