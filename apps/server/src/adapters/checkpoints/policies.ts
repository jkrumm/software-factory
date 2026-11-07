import { readFile } from 'node:fs/promises'
import * as z from 'zod'
import type { PolicyRule } from '../../domains/checkpoints/decision.ts'
import type { StandingPolicies } from '../../domains/checkpoints/ports.ts'
import { err, ok, portError } from '../../kernel/result.ts'

const Rules = z.record(
  z.string(),
  z.array(z.object({ when: z.string().min(1), answer: z.string().min(1), reason: z.string().min(1) })),
)

/**
 * A stand-in for `project.yaml`'s standing policy until package 3: a JSON file of `{ "<repo>": [{ when, answer, reason }] }`,
 * read on every call so an edit takes at the next pass. Package 3's adapter replaces it; the port does not change.
 */
export function fileStandingPolicies(path: string): StandingPolicies {
  return {
    async rulesFor(repo) {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT'
        return missing ? ok([]) : err(portError('unreadable', `the standing policy file: ${String(error)}`))
      }
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        return err(portError('unreadable', 'the standing policy file is not JSON'))
      }
      const parsed = Rules.safeParse(json)
      if (!parsed.success) return err(portError('unreadable', 'the standing policy file does not match its shape'))
      const rules: PolicyRule[] = parsed.data[repo] ?? []
      return ok(rules)
    },
  }
}
