import type { SQL } from 'bun'
import type { TickAnswer } from '@software-factory/contract'
import { gitWorktrees } from './adapters/git/worktrees.ts'
import { rootedRepos } from './adapters/git/repos.ts'
import { HcTerminals, claudeProjectsDirs } from './adapters/hc/terminals.ts'
import { SpoolReplayer } from './adapters/leads/spool.ts'
import { fileRoles } from './adapters/leads/roles.ts'
import type { LeadSettings } from './adapters/leads/settings.ts'
import { fileTranscripts } from './adapters/leads/transcripts.ts'
import { listenOnSocket, type SocketListener } from './adapters/socket/listener.ts'
import type { LeadRoutes } from './api/leads.ts'
import type { LeadDeps, LeadsUow } from './app/leads.ts'
import { replayLines, recordHook, stopCheck } from './app/leads-hooks.ts'
import { leadSession } from './app/leads-session.ts'
import { leadPorts, leadTick } from './app/leads-tick.ts'
import { blockIssue, closeIssue, deferIssue } from './app/leads-verbs.ts'
import type { EffectPorts } from './domains/work/ports.ts'
import type { Clock } from './kernel/clock.ts'
import type { IdSource } from './kernel/ids.ts'
import type { PortError, Result } from './kernel/result.ts'

export interface LeadsComposition {
  routes: LeadRoutes
  /** one pass of the lead tick: spool, lost leads, outbox */
  tick(): Promise<Result<TickAnswer, PortError>>
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
  /** quality's port: opens the Watch after a ship. The one outbox runs it with the leads' ports. */
  startWatch: EffectPorts['start_watch']
}): LeadsComposition {
  const { settings: s } = input
  const deps: LeadDeps = {
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
    }),
    worktrees: gitWorktrees(),
    repos: rootedRepos(s.repoRoots),
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
  }
  const ports: EffectPorts = { ...leadPorts(deps), start_watch: input.startWatch }
  const replayer = new SpoolReplayer({
    dir: s.spoolDir,
    now: () => input.clock.now(),
    sink: async (lines) => {
      await replayLines(deps, lines)
    },
  })
  const tick = () => leadTick({ leads: deps, ports, replaySpool: async () => (await replayer.replay()).lines })

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
