import { claudeAccountSource } from './adapters/planning/claude-accounts.ts'
import { gitProjectSource } from './adapters/planning/git-projects.ts'
import { hostReader } from './adapters/planning/host.ts'
import type { CapacityApi } from './api/capacity.ts'
import type { PlanningApi } from './api/planning.ts'
import { admissionPass, queueView } from './app/capacity-admit.ts'
import { capacityForLeads } from './app/capacity-leads.ts'
import { getQueueStates, setQueueState } from './app/capacity-queue.ts'
import { giveSlotBack, touchSlot } from './app/capacity-slots.ts'
import { capacityState, refreshState } from './app/capacity-view.ts'
import { addAfter, settleIssue, setPrio } from './app/planning-chain.ts'
import type { PlanningDeps } from './app/planning-deps.ts'
import { planningPass } from './app/planning-pass.ts'
import { standingPolicies } from './app/planning-policies.ts'
import type { PlanningSettings } from './app/planning-settings.ts'
import { projectSignals } from './app/planning-signals.ts'
import { syncProjects } from './app/planning-sync.ts'
import { projectStates } from './app/planning-views.ts'
import { key } from './kernel/keys.ts'

/** The remote is asked for new commits this often; every other pass reads the default branch as last fetched. */
const FETCH_EVERY_MS = 10 * 60_000

export interface PlanningComposition {
  planning: PlanningApi
  capacity: CapacityApi
  /** capacity's side of the leads' ports: the account, the repo claim, the window */
  leads: ReturnType<typeof capacityForLeads>
  /** planning's side of intake's `ProjectSignals` */
  signals: ReturnType<typeof projectSignals>
  /** the checkpoints' `StandingPolicies`, read from each project's `project.yaml` */
  policies: ReturnType<typeof standingPolicies>
  /** One pass of the planning loop: the planning pass, then admission. The loop runner schedules it. Answers what stands in the way. */
  pass(): Promise<string[]>
}

/**
 * Wires planning and capacity: the real adapters behind their ports, the use cases the routes call, the ports the other
 * packages take, and the loop that runs the planning pass and then the admission pass.
 */
export function composePlanning(input: { writes: PlanningDeps; settings: PlanningSettings }): PlanningComposition {
  const { writes, settings } = input
  const sync = { ...writes, source: gitProjectSource({ roots: settings.repoRoots, timeoutMs: settings.gitTimeoutMs }) }
  const limits = {
    leadsPerAccount: settings.leadsPerAccount,
    loadCeiling: settings.loadCeiling,
    memoryCeilings: settings.memoryCeilings,
  }
  const capacity = {
    ...writes,
    limits,
    host: hostReader({ sysctlBin: settings.sysctlBin, minSampleMs: settings.memorySampleMs }),
    accounts: claudeAccountSource({ bin: settings.claudeAccountBin }),
  }
  const slots = { ...writes, slots: settings.slots }

  let fetchedAt = Number.NEGATIVE_INFINITY
  /** One pass: the planning pass, then admission, which decides again at every claim. */
  async function pass(): Promise<string[]> {
    const problems: string[] = []
    const fetch = writes.clock.now().getTime() - fetchedAt >= FETCH_EVERY_MS
    const planned = await planningPass(sync, { fetch })
    if (!planned.ok) problems.push(`planning pass: ${planned.error.detail}`)
    else {
      if (fetch) fetchedAt = writes.clock.now().getTime()
      problems.push(...planned.value.errors.map((e) => `planning pass: ${e}`))
    }
    const admitted = await admissionPass(capacity)
    if (!admitted.ok) problems.push(`admission pass: ${admitted.error.detail}`)
    else problems.push(...admitted.value.notes.map((n) => `admission pass: ${n}`))
    return problems
  }

  return {
    planning: {
      projects: () => projectStates(writes),
      sync: (options) => syncProjects(sync, options),
      pass: (options) => planningPass(sync, options),
      settle: (request) => settleIssue(writes, request),
      after: (request) => addAfter(writes, request),
      prio: (request) =>
        setPrio(writes, {
          issue: request.issue,
          value: request.value,
          key: key('prio', request.key ?? writes.ids.next('prio')),
        }),
    },
    capacity: {
      limits: { ...limits, slots: settings.slots },
      state: () => capacityState(capacity),
      refresh: () => refreshState(capacity),
      admit: () => admissionPass(capacity),
      queue: () => queueView(capacity),
      queueStates: () => getQueueStates(writes),
      setQueueState: (request) => setQueueState(writes, request),
      touchSlot: (request) => touchSlot(slots, request),
      giveSlotBack: (id) => giveSlotBack(writes, id),
    },
    leads: capacityForLeads(writes),
    signals: projectSignals(writes),
    policies: standingPolicies(writes),
    pass,
  }
}
