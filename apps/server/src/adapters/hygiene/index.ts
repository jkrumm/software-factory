import {
  type Checkout,
  type HygieneChecker,
  PROBES,
  type Probe,
  type ProbeRun,
  type SweepOptions,
  type SweepReport,
} from '../../domains/loops/hygiene-model.ts'
import { type RepoLocator, withCheckout } from './checkout.ts'
import { livingDocs, trackedMarkdown } from './docs.ts'
import { type Tools } from './git.ts'
import { candidates } from './history.ts'
import { checkProbe } from './probes/check.ts'
import { cochangeProbe } from './probes/cochange.ts'
import { depsProbe } from './probes/deps.ts'
import { type Outcome, failed, skipped } from './probes/finding.ts'
import { linksProbe } from './probes/links.ts'
import { retiredProbe } from './probes/retired.ts'

export interface HygieneCheckerOptions {
  repos: RepoLocator
  /** the factory's data directory: the throwaway worktrees live under `<workDir>/hygiene/` */
  workDir: string
  git?: string
  make?: string
  bun?: string
}

/** A probe that throws did not run: it is `failed`, never an error out of the sweep. */
async function guarded(run: () => Promise<Outcome>): Promise<Outcome> {
  try {
    return await run()
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }
}

/**
 * The I/O of the hygiene pass (`domains/loops/hygiene-model.ts`): a throwaway checkout of the default branch and the
 * deterministic probes over it. Nothing is edited, nothing leaves the machine except what `git fetch` and `bun outdated` ask.
 */
export function createHygieneChecker(options: HygieneCheckerOptions): HygieneChecker {
  const tools: Tools = { git: options.git ?? 'git', make: options.make ?? 'make', bun: options.bun ?? 'bun' }

  async function sweep(checkout: Checkout, options: SweepOptions = {}): Promise<SweepReport> {
    const { path } = checkout
    const markdown = trackedMarkdown(tools, path)
    markdown.catch(() => {})
    const docs = markdown.then(livingDocs)
    docs.catch(() => {})
    const quick: Record<Exclude<Probe, 'check'>, () => Promise<Outcome>> = {
      links: async () => linksProbe(path, await docs),
      retired: async () => retiredProbe(tools, path, await markdown),
      deps: () => depsProbe(tools, path),
      cochange: () => cochangeProbe(tools, path),
    }
    const [history, ...results] = await Promise.all([
      docs
        .then((list) => candidates(tools, path, list))
        .catch((error: unknown) => ({
          stale: [],
          slop: [],
          candidatesError: (error instanceof Error ? error.message : String(error)).slice(0, 200),
        })),
      ...(Object.keys(quick) as (keyof typeof quick)[]).map(
        async (probe) => [probe, await guarded(quick[probe])] as const,
      ),
    ])
    const outcomes = new Map<Probe, Outcome>(results)
    // A gate that cannot run for want of its dependencies says nothing about the branch: it is not a red check.
    const deps = outcomes.get('deps')
    outcomes.set(
      'check',
      options.skipCheck !== undefined
        ? skipped(`make check not run, the project says its check needs a lab this host lacks: ${options.skipCheck}`)
        : deps?.outcome === 'failed' && deps.detail.startsWith('bun install')
          ? failed(`not run: ${deps.detail}`)
          : await guarded(() => checkProbe(tools, checkout)),
    )

    const runs: ProbeRun[] = []
    const findings = []
    for (const probe of PROBES) {
      const outcome = outcomes.get(probe) ?? failed('did not run')
      runs.push({ probe, outcome: outcome.outcome, detail: outcome.detail })
      findings.push(...outcome.findings)
    }
    return { ref: checkout.ref, runs, findings, ...history }
  }

  return {
    withCheckout: (repo, ref, use) => withCheckout(tools, options.repos, options.workDir, repo, ref, use),
    sweep,
  }
}
