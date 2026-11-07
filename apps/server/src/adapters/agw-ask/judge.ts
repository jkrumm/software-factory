import * as z from 'zod'
import type { JudgeInput } from '../../domains/checkpoints/decision.ts'
import type { JudgePort } from '../../domains/checkpoints/ports.ts'
import { err, ok, portError } from '../../kernel/result.ts'

/**
 * The thin call to the `factory-ask` agw workflow that the scenarios need: one `agw factory-ask --format json` run with
 * the input on stdin and the Decision's key as the idempotency key. Package 7 (loops and agw) brings the real agw port
 * (the pending loop, `agw run wait`, the shared failure mapping) and replaces this file.
 *
 * A judge run is an agent run: no short timeout. The hang guard is 30 minutes, never a budget.
 */
export const JUDGE_HANG_GUARD_MS = 30 * 60_000

const Verdict = z.object({
  verdict: z.enum(['answer', 'owner']),
  answer: z.string().default(''),
  reason: z.string().default(''),
  source: z.string().default(''),
})

export function agwJudge(options: { bin: string; hangGuardMs?: number }): JudgePort {
  return {
    async judge(input: JudgeInput, key) {
      const proc = Bun.spawn([options.bin, 'factory-ask', '--format', 'json', '--idempotency-key', key], {
        stdin: new Blob([JSON.stringify(input)]),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const guard = setTimeout(() => proc.kill('SIGKILL'), options.hangGuardMs ?? JUDGE_HANG_GUARD_MS)
      try {
        const [out, errText, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
        if (code === 10)
          return err(portError('timeout', 'the factory-ask run is still going (agw run wait resumes it)'))
        if (code !== 0) return err(portError('gone', `agw factory-ask exited ${code}: ${errText.trim().slice(0, 300)}`))
        let json: unknown
        try {
          json = JSON.parse(out)
        } catch {
          return err(portError('unreadable', 'agw factory-ask did not print JSON'))
        }
        const parsed = Verdict.safeParse(json)
        if (!parsed.success) {
          return err(
            portError('unreadable', `the verdict does not parse: ${parsed.error.issues[0]?.message ?? 'unknown'}`),
          )
        }
        return ok(parsed.data)
      } catch (error) {
        return err(portError('gone', `agw could not run: ${error instanceof Error ? error.message : String(error)}`))
      } finally {
        clearTimeout(guard)
      }
    },
  }
}
