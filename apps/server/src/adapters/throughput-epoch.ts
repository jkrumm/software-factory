import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as z from 'zod'

/** The tracked file of this checkout or release: `config/throughput.json`. */
export const DEFAULT_EPOCH_FILE = fileURLToPath(new URL('../../../../config/throughput.json', import.meta.url))

const File = z.strictObject({ epoch: z.iso.datetime() })

/** The counting epoch of the file; a missing or bad file is a startup error, never a fallback to counting everything. */
export function loadEpoch(file = DEFAULT_EPOCH_FILE): Date {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = File.safeParse(raw)
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
  return new Date(parsed.data.epoch)
}
