import {
  type Checkout,
  type HygieneChecker,
  PROBES,
  type Probe,
  type ProbeRun,
  runsIn,
  type SweepOptions,
  type SweepReport,
} from '../../domains/loops/hygiene-model.ts'
import { type RepoLocator, withCheckout } from './checkout.ts'
import { livingDocs, trackedMarkdown } from './docs.ts'
import { defaultTools, gitTry, type Tools } from './git.ts'
import { candidates } from './history.ts'
import { advisoriesProbe } from './probes/advisories.ts'
import { agentsmdProbe } from './probes/agentsmd.ts'
import { browserProbe } from './probes/browser.ts'
import { checkProbe } from './probes/check.ts'
import { ciProbe } from './probes/ci.ts'
import { cochangeProbe } from './probes/cochange.ts'
import { contextProbe } from './probes/context.ts'
import { deadcodeProbe } from './probes/deadcode.ts'
import { declaredProbe } from './probes/declared.ts'
import { depsProbe } from './probes/deps.ts'
import { type Outcome, failed, skipped } from './probes/finding.ts'
import { linksProbe } from './probes/links.ts'
import { projectProbe } from './probes/project.ts'
import { readmeProbe } from './probes/readme.ts'
import { retiredProbe } from './probes/retired.ts'
import { runrulesProbe } from './probes/runrules.ts'
import { staleProbe } from './probes/stale.ts'

export interface HygieneCheckerOptions {
  repos: RepoLocator
  /** the factory's data directory: the throwaway worktrees live under `<workDir>/hygiene/` */
  workDir: string
  git?: string
  make?: string
  bun?: string
  fallow?: string
  osv?: string
  gh?: string
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
 * deterministic probes over it. Nothing is edited, nothing leaves the machine except what `git fetch`, `bun outdated`,
 * `bun audit` and the version look-ups of the `deps` probe ask.
 */
export function createHygieneChecker(options: HygieneCheckerOptions): HygieneChecker {
  const tools: Tools = {
    ...defaultTools(options.git),
    ...(options.make ? { make: options.make } : {}),
    ...(options.bun ? { bun: options.bun } : {}),
    ...(options.fallow ? { fallow: options.fallow } : {}),
    ...(options.osv ? { osv: options.osv } : {}),
    ...(options.gh ? { gh: options.gh } : {}),
  }

  async function sweep(checkout: Checkout, options: SweepOptions = {}): Promise<SweepReport> {
    const { path } = checkout
    const scope = options.scope ?? 'full'
    const markdown = trackedMarkdown(tools, path)
    markdown.catch(() => {})
    const docs = markdown.then(livingDocs)
    docs.catch(() => {})
    const quick: Record<Exclude<Probe, 'check' | 'probe' | 'deadcode'>, () => Promise<Outcome>> = {
      advisories: () => advisoriesProbe(tools, path),
      links: async () => linksProbe(path, await docs),
      retired: async () => retiredProbe(tools, path, await markdown),
      project: () => projectProbe(tools, path),
      deps: () => depsProbe(tools, path),
      ci: () => ciProbe(tools, path),
      agentsmd: () => agentsmdProbe(tools, path),
      readme: () => readmeProbe(tools, path),
      stale: () => staleProbe(tools, path),
      cochange: () => cochangeProbe(tools, path),
      runrules: () => runrulesProbe(tools, path),
      browser: () => browserProbe(tools, path),
      context: () => contextProbe(tools, path),
    }
    const optOut = new Map((options.skip ?? []).map((entry) => [entry.probe, entry.reason]))
    const names = (Object.keys(quick) as (keyof typeof quick)[]).filter((probe) => runsIn(probe, scope))
    // The documents the agent judges are read in the weekly pass only: the daily one files no judgment.
    const history =
      scope === 'full'
        ? docs
            .then((list) => candidates(tools, path, list))
            .catch((error: unknown) => ({
              stale: [],
              slop: [],
              candidatesError: (error instanceof Error ? error.message : String(error)).slice(0, 200),
            }))
        : Promise.resolve({ stale: [], slop: [] })
    const [read, ...results] = await Promise.all([
      history,
      ...names.map(async (probe) => {
        const reason = optOut.get(probe)
        return [
          probe,
          reason === undefined ? await guarded(quick[probe]) : skipped(`the project opts out: ${reason}`),
        ] as const
      }),
    ])
    const outcomes = new Map<Probe, Outcome>(results)
    // After `deps`, never beside it: both install the checkout's packages, and two installs in one tree break each other.
    if (runsIn('deadcode', scope)) {
      const reason = optOut.get('deadcode')
      outcomes.set(
        'deadcode',
        reason === undefined
          ? await guarded(() => deadcodeProbe(tools, path))
          : skipped(`the project opts out: ${reason}`),
      )
    }
    if (runsIn('check', scope)) {
      // A gate that cannot run for want of its dependencies says nothing about the branch: it is not a red check.
      const deps = outcomes.get('deps')
      outcomes.set(
        'check',
        options.skipCheck !== undefined
          ? skipped(`make check not run, this host cannot run the project's check: ${options.skipCheck}`)
          : deps?.outcome === 'failed' && deps.detail.startsWith('bun install')
            ? failed(`not run: ${deps.detail}`)
            : await guarded(() => checkProbe(tools, checkout)),
      )
    }

    // The project's own probes run one after another, after the built-in ones: each is a make target of its own.
    const declared: { name: string; outcome: Outcome }[] = []
    if (runsIn('probe', scope)) {
      for (const probe of options.probes ?? []) {
        declared.push({ name: probe.name, outcome: await guarded(() => declaredProbe(tools, checkout, probe)) })
      }
    }

    const runs: ProbeRun[] = []
    const findings = []
    for (const probe of PROBES) {
      const list =
        probe === 'probe'
          ? declared.map((entry) => ({ covers: `probe:${entry.name}`, outcome: entry.outcome }))
          : outcomes.has(probe)
            ? [{ covers: probe, outcome: outcomes.get(probe) ?? failed('did not run') }]
            : []
      for (const { covers, outcome } of list) {
        runs.push({ probe, outcome: outcome.outcome, detail: outcome.detail, covers })
        findings.push(...outcome.findings)
      }
    }
    return { ref: checkout.ref, scope, runs, findings, ...read }
  }

  async function commitsSince(checkout: Checkout, ref: string): Promise<number | null> {
    const out = await gitTry(tools, checkout.path, ['rev-list', '--count', `${ref}..${checkout.ref}`])
    const count = Number.parseInt(out?.trim() ?? '', 10)
    return Number.isNaN(count) ? null : count
  }

  return {
    withCheckout: (repo, ref, use) => withCheckout(tools, options.repos, options.workDir, repo, ref, use),
    sweep,
    commitsSince,
  }
}
