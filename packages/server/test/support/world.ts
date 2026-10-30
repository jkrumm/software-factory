import type { SQL } from 'bun'
import type { Clock } from '../../src/clock.ts'
import type { Runner, StartInput } from '../../src/runner.ts'
import { type EventKind, openSession, recordEvent } from '../../src/sessions.ts'
import type { FakeClock } from './clock.ts'

/** A Runner the test drives: what it typed and started is recorded, what it answers is set. */
export class FakeRunner implements Runner {
  typed: { pane: string; text: string }[] = []
  started: StartInput[] = []
  answer: 'typed' | 'busy' = 'typed'
  failure?: Error

  async type(input: { pane: string; text: string }): Promise<'typed' | 'busy'> {
    if (this.failure) throw this.failure
    if (this.answer === 'typed') this.typed.push(input)
    return this.answer
  }

  async start(input: StartInput): Promise<{ session: string }> {
    if (this.failure) throw this.failure
    this.started.push(input)
    return { session: 'w9:p9' }
  }
}

/** Sessions, spawns and events for the rule tests: everything goes in as the hooks and the tick would have put it. */
export function world(sql: SQL, clock: FakeClock & Clock) {
  let n = 0
  const at = (minutesAgo: number) => new Date(clock.now().getTime() - minutesAgo * 60_000)

  const emit = (session: string, kind: EventKind, when: Date, payload?: Record<string, unknown>) =>
    recordEvent(sql, { key: `${session}:${kind}:${++n}`, session, kind, at: when, payload })

  /** A started spawn with its session row and a `session_started` that bound Claude's session id. */
  async function spawned(
    key: string,
    options: { role?: string; account?: string; parent?: string; repo?: string; startedMinutesAgo?: number } = {},
  ): Promise<void> {
    const when = at(options.startedMinutesAgo ?? 60)
    await sql`
      INSERT INTO factory.spawns (key, repo, prompt, role, tier, effort, status, account, assigned_at, session, created_at, parent)
      VALUES (${key}, ${options.repo ?? '/work/repo'}, 'work', ${options.role ?? 'worker'}, 'sonnet', 'high', 'started',
              ${options.account ?? 'a'}, ${when}, ${`w1:${key}`}, ${when}, ${options.parent ?? null})`
    await openSession(sql, { id: key, spawnKey: key, pane: `w1:${key}`, at: when })
    await emit(key, 'session_started', when, { claudeSessionId: `claude-${key}` })
  }

  return { emit, at, spawned }
}
