import { EXIT_TIMEOUT } from '../../hc/process.ts'
import { exec, type Tools, withStderr } from '../git.ts'
import { type Outcome, clean, failed, finding, found, skipped } from './finding.ts'
import { MAX_EVIDENCE_LINES } from '../../../domains/loops/hygiene-model.ts'

/** A CLI helper's limit, not an agent's: the repo's whole gate can be slow. */
const CHECK_TIMEOUT_MS = 45 * 60_000

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')

/** `make check` on the default branch: green or one finding with the tail of its output. */
export async function checkProbe(tools: Tools, path: string): Promise<Outcome> {
  const makefile = await Bun.file(`${path}/Makefile`)
    .text()
    .catch(() => '')
  if (!/^check:/m.test(makefile)) return skipped('no check target in the Makefile')
  const started = Date.now()
  const result = await exec(withStderr([tools.make, 'check']), CHECK_TIMEOUT_MS, path)
  const seconds = Math.round((Date.now() - started) / 1000)
  if (result.exitCode === EXIT_TIMEOUT) return failed(`make check did not finish in ${CHECK_TIMEOUT_MS / 60_000} min`)
  const detail = `make check, ${seconds}s, exit ${result.exitCode}`
  if (result.exitCode === 0) return clean(detail)
  if (result.exitCode === 126 || result.exitCode === 127) return failed(`${detail}: ${tools.make} cannot run`)
  const tail = result.stdout
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-MAX_EVIDENCE_LINES)
  return found(detail, [finding('check', 'check', 'Hygiene: make check is red on the default branch', tail, 1)])
}
