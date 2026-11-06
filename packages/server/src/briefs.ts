import type { SQL } from 'bun'
import type { Clock } from './clock.ts'
import type { Runner } from './runner.ts'

/**
 * A spawn's brief is the last argv of `claude`, so it is no row in `factory.prompts` and the prompt retry never sees it. When
 * Claude Code starts with the brief sitting unsent in its input box, nothing else would press Enter: this pass does, for a
 * started spawn whose first `turn_started` has not come.
 */

/** A spawn younger than this is still starting: its first turn is on its way. */
export const BRIEF_MIN_AGE_MS = 10_000
/** A spawn older than this without a turn is for a person; the pass gives up. */
export const BRIEF_MAX_AGE_MS = 30 * 60_000
/** The wait after the n-th press before the next one; the last gap repeats. */
export const PRESS_GAPS_MS = [10_000, 20_000, 40_000, 60_000]
/** Most spawns one pass looks at. */
export const BRIEF_BATCH = 10

/** What the pass did for one spawn: how often it pressed Enter and when it last did. In memory; a restart starts the backoff over. */
export type BriefWatch = Map<string, { presses: number; lastAt: number }>

const RULE = /^\s*─{3,}/

/**
 * The text in Claude Code's input box: what sits between the last two horizontal rule lines, without the `❯` prompt. Empty when
 * the box is empty or the screen shows no box (a dialog, a start in progress).
 */
export function inputBoxText(screen: string): string {
  const lines = screen.split('\n')
  const rules = lines.flatMap((line, i) => (RULE.test(line) ? [i] : []))
  const [top, bottom] = rules.slice(-2)
  if (top === undefined || bottom === undefined) return ''
  return lines
    .slice(top + 1, bottom)
    .join('\n')
    .replace(/^\s*❯/, '')
    .trim()
}

const due = (watch: BriefWatch, key: string, now: number): boolean => {
  const seen = watch.get(key)
  if (!seen) return true
  const gap = PRESS_GAPS_MS[Math.min(seen.presses, PRESS_GAPS_MS.length) - 1] ?? 0
  return now - seen.lastAt >= gap
}

/** One pass; returns the errors it met, never throws for a spawn. */
export async function nudgeBriefs(deps: {
  sql: SQL
  runner: Pick<Runner, 'screen' | 'type'>
  clock: Clock
  watch: BriefWatch
}): Promise<string[]> {
  const { sql, runner, watch } = deps
  const now = deps.clock.now()
  const rows: { key: string; session: string }[] = await sql`
    SELECT s.key, s.session FROM factory.spawns s
    WHERE s.status = 'started' AND s.session IS NOT NULL
      AND s.assigned_at <= ${new Date(now.getTime() - BRIEF_MIN_AGE_MS)}
      AND s.assigned_at >= ${new Date(now.getTime() - BRIEF_MAX_AGE_MS)}
      AND NOT EXISTS (SELECT 1 FROM factory.events e WHERE e.session = s.key AND e.kind = 'turn_started' AND e.at >= s.assigned_at)
    ORDER BY s.assigned_at DESC, s.key
    LIMIT ${BRIEF_BATCH}`
  const keys = new Set(rows.map((r) => r.key))
  for (const key of watch.keys()) if (!keys.has(key)) watch.delete(key)

  const errors: string[] = []
  for (const { key, session: pane } of rows) {
    if (!due(watch, key, now.getTime())) continue
    try {
      if (inputBoxText(await runner.screen(pane)) === '') continue
      if ((await runner.type({ pane, text: '', enterOnly: true })) === 'busy') continue
      watch.set(key, { presses: (watch.get(key)?.presses ?? 0) + 1, lastAt: now.getTime() })
    } catch (error) {
      errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return errors
}
