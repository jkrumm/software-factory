import type { SQL } from 'bun'
import type { TickAnswer } from '@software-factory/contract'
import { reviewerTakesAll } from './read/kpis-reviewers.ts'
import { gitBranches } from './adapters/git/branches.ts'
import { gitWorktrees } from './adapters/git/worktrees.ts'
import { makefileMergeGuard } from './adapters/git/merge-guard.ts'
import { rootedRepos } from './adapters/git/repos.ts'
import { HcTerminals, claudeProjectsDirs } from './adapters/hc/terminals.ts'
import { SpoolReplayer } from './adapters/leads/spool.ts'
import { fileRoles } from './adapters/leads/roles.ts'
import type { LeadSettings } from './adapters/leads/settings.ts'
import { fileTranscripts, fileTranscriptTails } from './adapters/leads/transcripts.ts'
import { listenOnSocket, type SocketListener } from './adapters/socket/listener.ts'
import type { LeadRoutes } from './api/leads.ts'
import type { LeadDeps, LeadsUow } from './app/leads.ts'
import { replayLines, recordHook, stopCheck } from './app/leads-hooks.ts'
import { leadSession } from './app/leads-session.ts'
import { apiErrorMemory, apiErrorPorts } from './app/leads-api-errors.ts'
import { leadPorts, leadTick } from './app/leads-tick.ts'
import { blockIssue, closeIssue, deferIssue } from './app/leads-verbs.ts'
import type { EffectPorts } from './domains/work/ports.ts'
import { typePacer } from './app/type-pace.ts'
import type { Clock } from './kernel/clock.ts'
import { freshFor } from './kernel/fresh-for.ts'
import { costOfIssues } from './read/kpis.ts'
import { readLightGate } from './read/kpis-seats.ts'
import type { IdSource } from './kernel/ids.ts'
import type { PortError, Result } from './kernel/result.ts'

/** How long one reading of the light seat's tripwire serves the starts. */
const LIGHT_GATE_FRESH_MS = 10 * 60_000

export interface LeadsComposition {
  routes: LeadRoutes
  /** one pass of the lead tick: spool, lost leads, outbox; with `signal` a drain ends it before its next step */
  tick(signal?: AbortSignal): Promise<Result<TickAnswer, PortError>>
  /** the hook socket, bound; stopping it removes the file */
  listen(): Promise<SocketListener>
}

/**
 * Wires the leads: adapters behind the domain's ports, the use cases, the routes, the socket and the tick. The ports
 * capacity owns (the account, the repo claim, the window) come in from `compose-planning.ts`.
 */
export function composeLeads(input: {
  sql: SQL
  uow: LeadsUow
  clock: Clock
  ids: IdSource
  settings: LeadSettings
  capacity: Pick<LeadDeps, 'seats' | 'claims' | 'windows'>
  /** the project's check tiers (`project.yaml` `checks:`), read from the stored project */
  checks: LeadDeps['checks']
  /** quality's port: opens the Watch after a ship. The one outbox runs it with the leads' ports. */
  startWatch: EffectPorts['start_watch']
  /** `FACTORY_GITHUB_TOKEN` and API base: with no token a merged pull request is not asked about */
  github: { token: string | null; apiUrl: string }
  /** the checkpoints' side of the Errand "log in account X" */
  loginErrands: NonNullable<LeadDeps['apiErrors']>['errands']
  /** the host's processes and the slots granted now: what quiescing looks at before it ends a lead */
  host: Pick<NonNullable<LeadDeps['quiesce']>, 'processes' | 'slotCwds'>
}): LeadsComposition {
  const { settings: s } = input
  if (!s.agentToken)
    console.error(
      'leads: FACTORY_AGENT_TOKEN is not set; a lead starts without a token and its factory calls answer 401',
    )
  const deps: LeadDeps = {
    reviewerTakesAll: () => reviewerTakesAll(input.sql, input.clock.now()).catch(() => false),
    uow: input.uow,
    clock: input.clock,
    ids: input.ids,
    terminals: new HcTerminals({
      bin: s.hcBin,
      ...(s.hcSession ? { session: s.hcSession } : {}),
      ...(s.claudeBin ? { claudeBin: s.claudeBin } : {}),
      ...(s.pretrustBin ? { pretrustBin: s.pretrustBin } : {}),
      accountsFile: s.accountsFile,
      home: s.home,
      ...(s.agentToken ? { agentToken: s.agentToken } : {}),
      ...(s.apiUrl ? { apiUrl: s.apiUrl } : {}),
    }),
    worktrees: gitWorktrees(),
    branches: gitBranches(input.github),
    repos: rootedRepos(s.repoRoots, s.repoAllow),
    checks: input.checks,
    mergeGuard: makefileMergeGuard(),
    roles: fileRoles(s.rolesFile),
    seats: input.capacity.seats,
    claims: input.capacity.claims,
    windows: input.capacity.windows,
    transcripts: fileTranscripts({
      archiveDir: s.archiveDir,
      projectsDirs: () => claudeProjectsDirs({ accountsFile: s.accountsFile, home: s.home }),
    }),
    startBudgetMs: s.startBudgetMs,
    forceNoteAfterMs: s.forceNoteAfterMs,
    graceMs: s.graceMs,
    typePace: typePacer({ clock: input.clock, gapMs: s.typeGapMs }),
    // The tripwire over the last days is a heavy read (it prices attempts): one answer serves every start of the next minutes.
    lightGate: freshFor(LIGHT_GATE_FRESH_MS, () =>
      readLightGate(input.sql, {
        now: input.clock.now(),
        cost: (issues) => costOfIssues(input.sql, issues),
      }),
    ),
    ...(s.quiesceAfterMs === null
      ? {}
      : {
          quiesce: {
            afterMs: s.quiesceAfterMs,
            maxReviveTries: s.maxReviveTries,
            processes: input.host.processes,
            slotCwds: input.host.slotCwds,
          },
        }),
    apiErrors: apiErrorPorts({
      tails: fileTranscriptTails({
        projectsDirs: () => claudeProjectsDirs({ accountsFile: s.accountsFile, home: s.home }),
      }),
      errands: input.loginErrands,
      delaysMs: s.resumeDelaysMs,
      staggerMs: s.resumeStaggerMs,
      detectAfterMs: s.apiErrorDetectMs,
      probeEveryMs: s.apiErrorProbeMs,
    }),
  }
  const ports: EffectPorts = { ...leadPorts(deps), start_watch: input.startWatch }
  const replayer = new SpoolReplayer({
    dir: s.spoolDir,
    now: () => input.clock.now(),
    sink: async (lines) => {
      await replayLines(deps, lines)
    },
  })
  const memory = apiErrorMemory()
  const tick = (signal?: AbortSignal) =>
    leadTick({
      leads: deps,
      ports,
      replaySpool: async () => (await replayer.replay()).lines,
      apiErrorMemory: memory,
      ...(signal ? { signal } : {}),
    })

  return {
    routes: {
      close: (issue, body) => closeIssue(deps, issue, body),
      defer: (issue, body) => deferIssue(deps, issue, body),
      block: (issue, body) => blockIssue(deps, issue, body),
      session: (issue) => leadSession(deps, issue),
    },
    tick,
    listen: () =>
      listenOnSocket(s.socket, {
        event: (body) => recordHook(deps, body),
        stopCheck: (session, body) => stopCheck(deps, session, body),
      }),
  }
}
