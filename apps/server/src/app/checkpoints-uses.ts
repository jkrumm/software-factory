import type { CheckpointResult } from './checkpoints.ts'
import {
  annotateArtifact,
  answerDecision,
  askDecision,
  finishErrand,
  giveVerdict,
  ledger,
  listArtifacts,
  listErrands,
  listPages,
  markWorthAsking,
  raiseErrand,
  reviseArtifact,
  showArtifact,
  showDecision,
  submitArtifact,
} from './checkpoints.ts'
import { type PageDeps, runCheckpointPass, sendDuePages } from './checkpoints-pages.ts'
import { type SettleDeps, settleOpen } from './checkpoints-settle.ts'

/** The checkpoints use cases bound to their dependencies: what the routes call. `main.ts` builds it once. */
export function checkpointUses(deps: SettleDeps & PageDeps) {
  return {
    ask: (input: Parameters<typeof askDecision>[1]) => askDecision(deps, input),
    answer: (input: Parameters<typeof answerDecision>[1]) => answerDecision(deps, input),
    worthAsking: (input: Parameters<typeof markWorthAsking>[1]) => markWorthAsking(deps, input),
    decision: (id: Parameters<typeof showDecision>[1]) => showDecision(deps, id),
    decisions: (filter: Parameters<typeof ledger>[1]) => ledger(deps, filter),
    submit: (input: Parameters<typeof submitArtifact>[1]) => submitArtifact(deps, input),
    revise: (input: Parameters<typeof reviseArtifact>[1]) => reviseArtifact(deps, input),
    annotate: (input: Parameters<typeof annotateArtifact>[1]) => annotateArtifact(deps, input),
    verdict: (input: Parameters<typeof giveVerdict>[1]) => giveVerdict(deps, input),
    artifact: (input: Parameters<typeof showArtifact>[1]) => showArtifact(deps, input),
    artifacts: (filter: Parameters<typeof listArtifacts>[1]) => listArtifacts(deps, filter),
    raiseErrand: (input: Parameters<typeof raiseErrand>[1]) => raiseErrand(deps, input),
    finishErrand: (input: Parameters<typeof finishErrand>[1]) => finishErrand(deps, input),
    errands: (filter: Parameters<typeof listErrands>[1]) => listErrands(deps, filter),
    pages: (limit: number) => listPages(deps, limit),
    pass: () => runCheckpointPass(deps),
    /** the two halves of a pass, for timers of their own: a slow Judge call never holds the owner's line */
    settle: () => settleOpen(deps),
    send: () => sendDuePages(deps),
  } satisfies Record<string, (input: never) => Promise<CheckpointResult<unknown>>>
}

export type CheckpointUses = ReturnType<typeof checkpointUses>
