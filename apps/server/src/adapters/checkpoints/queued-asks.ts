import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import * as z from 'zod'
import type { QueuedAsk } from '../../domains/checkpoints/errand.ts'

const Req = z.object({
  id: z.string(),
  text: z.string().default(''),
  cmd: z.string().nullable().default(null),
  session: z.string().nullable().default(null),
})

/** `ask-human.sh`'s queue root: `${XDG_STATE_HOME:-$HOME/.local/state}/human-queue` (the script owns the layout). */
export function askQueueDir(env: Record<string, string | undefined>): string {
  return join(env.XDG_STATE_HOME || join(env.HOME ?? '/tmp', '.local', 'state'), 'human-queue')
}

/**
 * The requests a lead of an Issue queued with `ask-human.sh` that nobody answered: a `<id>.req` written under its
 * `FACTORY_SESSION` (`lead-<issue>-<attempt>`) with no `<id>.res` beside it. A queue that cannot be read has none: the
 * Errand is raised rather than refused for a file the factory cannot see.
 */
export function queuedAsksIn(dir: string): (issue: number) => Promise<QueuedAsk[]> {
  return async (issue) => {
    const names = await readdir(dir).catch(() => [] as string[])
    const answered = new Set(names.filter((name) => name.endsWith('.res')).map((name) => name.slice(0, -4)))
    const session = new RegExp(`^lead-${issue}-[1-9][0-9]*$`)
    const found: QueuedAsk[] = []
    for (const name of names.filter((n) => n.endsWith('.req') && !answered.has(n.slice(0, -4)))) {
      const text = await Bun.file(join(dir, name))
        .text()
        .catch(() => '')
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        continue
      }
      const parsed = Req.safeParse(json)
      if (parsed.success && parsed.data.session !== null && session.test(parsed.data.session)) {
        found.push({ id: parsed.data.id, text: parsed.data.text, cmd: parsed.data.cmd })
      }
    }
    return found
  }
}
