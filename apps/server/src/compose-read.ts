import { deriveSession } from './domains/leads/session.ts'
import { createReader, type ReadApi, type ReadDeps } from './read/reader.ts'
import { loadStreamSettings } from './read/stream-settings.ts'

/**
 * The read API's composition, kept out of `main.ts`: `read/` may not import domain code, so the leads' session derivation is
 * handed in here, and the stream's poll comes from `FACTORY_STREAM_POLL_MS`.
 */
export function composeRead(
  input: Omit<ReadDeps, 'deriveSession' | 'streamPollMs'> & { env: Record<string, string | undefined> },
): ReadApi {
  const { env, ...deps } = input
  return createReader({ ...deps, deriveSession, streamPollMs: loadStreamSettings(env).pollMs })
}
