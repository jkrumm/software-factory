import { applyFixes, fixable, probesOf } from '../../../domains/loops/hygiene-fixes.ts'
import type {
  Checkout,
  FixedReport,
  FixEntry,
  FixOptions,
  Probe,
  SweepReport,
} from '../../../domains/loops/hygiene-model.ts'
import type { Tools } from '../git.ts'
import type { Released } from '../probes/deps.ts'
import { fixDeps } from './deps.ts'
import { fixStale } from './stale.ts'

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200)

/** A script that throws did not finish: it is a failed fix of its keys, never an error out of the pass. */
async function guarded(keys: readonly string[], run: () => Promise<FixEntry[]>): Promise<FixEntry[]> {
  try {
    return await run()
  } catch (error) {
    return keys.map((key) => ({ key, outcome: 'failed' as const, detail: `the script threw: ${messageOf(error)}` }))
  }
}

/**
 * The scripted fixes of a sweep's red findings (`HYGIENE_CATALOGUE` `fix`), run in the throwaway checkout, one script per
 * probe. Afterwards the probes a script acted on run again (`sweepAgain`) and `applyFixes` takes the report from that second
 * run: the probe is the proof, never the script's own word. A script that failed leaves its finding as it was, with its output.
 */
export async function runFixes(input: {
  tools: Tools
  checkout: Checkout
  report: SweepReport
  options: FixOptions
  released: Released
  now: Date
  sweepAgain: (only: readonly Probe[]) => Promise<SweepReport>
}): Promise<FixedReport> {
  const { tools, checkout, report, options } = input
  const todo = fixable(report.findings)
  if (!todo.length) return { report, fixes: [] }
  const keysOf = (probe: Probe): string[] =>
    todo.filter((finding) => finding.probe === probe).map((finding) => finding.key)
  const fixes: FixEntry[] = []
  const acted = new Set<Probe>()
  if (probesOf(todo).includes('stale')) {
    const keys = keysOf('stale')
    const entries = await guarded(keys, () => fixStale(tools, checkout, new Set(keys)))
    fixes.push(...entries)
    if (entries.length) acted.add('stale')
  }
  if (probesOf(todo).includes('deps')) {
    const entries = await guarded(keysOf('deps'), () =>
      fixDeps(tools, checkout, { landing: options.landing, released: input.released, now: input.now }),
    )
    fixes.push(...entries)
    // Only a push changed what the probe reads: a fix that did not get that far leaves the checkout's findings as they were.
    // The one `deps` finding folds the dependency rows and the advisories (`foldDependencies`): both run again, or an advisory would vanish from it.
    if (entries.some((entry) => entry.outcome === 'fixed'))
      for (const probe of ['deps', 'advisories'] as const) acted.add(probe)
  }
  const rerun = acted.size ? await input.sweepAgain([...acted]).catch(() => null) : null
  return { report: applyFixes({ report, rerun, fixes }), fixes }
}
