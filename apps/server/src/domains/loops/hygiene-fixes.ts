import { catalogueEntry } from '@software-factory/contract'
import type { FixEntry, Probe, ProbeFinding, SweepReport } from './hygiene-model.ts'

/**
 * The rules over a scripted fix (the I/O is `adapters/hygiene/fixes/`): which red findings have one, and what the sweep's report
 * is once the fixed probes ran again. The probe that raised a finding is the proof the fix worked; nothing here trusts the script.
 */

const fixKeys = (probe: Probe): readonly string[] => catalogueEntry(probe)?.fix?.keys ?? []

/** The red findings a fix covers: their key is one their probe's catalogue entry names under `fix.keys`. */
export const fixable = (findings: readonly ProbeFinding[]): ProbeFinding[] =>
  findings.filter((finding) => fixKeys(finding.probe).includes(finding.key))

/** The probes the fixes of these findings run for, once each, in the catalogue's order. */
export const probesOf = (findings: readonly ProbeFinding[]): Probe[] => [
  ...new Set(findings.map((finding) => finding.probe)),
]

const noteOf = (fix: FixEntry): string =>
  fix.outcome === 'failed'
    ? `The scripted fix failed, so this is yours: ${fix.detail}`
    : `A scripted fix ran and the probe is still red, so what is left is yours: ${fix.detail}`

/**
 * The report once the fixed probes ran again (`rerun`, null when they did not): a probe whose runs all ended with a verdict
 * (clean or found) takes its runs and findings from the second run; one that did not keeps the first, so a re-check that
 * could not run never heals anything. A finding still red after its fix carries the script's outcome first in its plan, so
 * the lead who gets the Issue starts from what the script did and what it printed.
 */
export function applyFixes(input: {
  report: SweepReport
  rerun: SweepReport | null
  fixes: readonly FixEntry[]
}): SweepReport {
  const { report, rerun } = input
  const taken = new Set<Probe>()
  if (rerun) {
    for (const probe of new Set(rerun.runs.map((run) => run.probe))) {
      const runs = rerun.runs.filter((run) => run.probe === probe)
      if (runs.every((run) => run.outcome === 'clean' || run.outcome === 'found')) taken.add(probe)
    }
  }
  const merged: SweepReport = rerun
    ? {
        ...report,
        runs: [
          ...report.runs.filter((run) => !taken.has(run.probe)),
          ...rerun.runs.filter((run) => taken.has(run.probe)),
        ],
        findings: [
          ...report.findings.filter((finding) => !taken.has(finding.probe)),
          ...rerun.findings.filter((finding) => taken.has(finding.probe)),
        ],
      }
    : report
  const note = new Map(
    input.fixes
      .filter((fix) => fix.outcome === 'fixed' || fix.outcome === 'failed')
      .map((fix) => [fix.key, [noteOf(fix), ...(fix.output ?? []).map((line) => `  ${line}`)]]),
  )
  return {
    ...merged,
    findings: merged.findings.map((finding) => {
      const lines = note.get(finding.key)
      return lines ? { ...finding, plan: [...lines, ...(finding.plan ?? [])] } : finding
    }),
  }
}
