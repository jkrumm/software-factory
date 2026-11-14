import type { CheckpointResult } from './checkpoints.ts'
import {
  annotateArtifact,
  deleteAnnotation,
  editAnnotation,
  replyAnnotation,
  answerDecision,
  askDecision,
  finishErrand,
  turnBackErrand,
  requestErrand,
  giveVerdict,
  ledger,
  listArtifacts,
  listErrands,
  listPages,
  markNeeded,
  markWorthAsking,
  raiseErrand,
  reviseArtifact,
  showArtifact,
  showDecision,
  submitArtifact,
} from './checkpoints.ts'
import { type PageDeps, runCheckpointPass, sendDuePages } from './checkpoints-pages.ts'
import { screenErrands } from './checkpoints-errands.ts'
import { previewSpecScreen, screenSpecs } from './checkpoints-specs.ts'
import { recheckOpen } from './checkpoints-recheck.ts'
import { recheckReviews } from './checkpoints-reviews.ts'
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
    editAnnotation: (input: Parameters<typeof editAnnotation>[1]) => editAnnotation(deps, input),
    replyAnnotation: (input: Parameters<typeof replyAnnotation>[1]) => replyAnnotation(deps, input),
    deleteAnnotation: (input: Parameters<typeof deleteAnnotation>[1]) => deleteAnnotation(deps, input),
    verdict: (input: Parameters<typeof giveVerdict>[1]) => giveVerdict(deps, input),
    needed: (input: Parameters<typeof markNeeded>[1]) => markNeeded(deps, input),
    screen: (id: Parameters<typeof previewSpecScreen>[1]) => previewSpecScreen(deps, id),
    artifact: (input: Parameters<typeof showArtifact>[1]) => showArtifact(deps, input),
    artifacts: (filter: Parameters<typeof listArtifacts>[1]) => listArtifacts(deps, filter),
    raiseErrand: (input: Parameters<typeof raiseErrand>[1]) => raiseErrand(deps, input),
    finishErrand: (input: Parameters<typeof finishErrand>[1]) => finishErrand(deps, input),
    turnBackErrand: (input: Parameters<typeof turnBackErrand>[1]) => turnBackErrand(deps, input),
    requestErrand: (input: Parameters<typeof requestErrand>[1]) => requestErrand(deps, input),
    errands: (filter: Parameters<typeof listErrands>[1]) => listErrands(deps, filter),
    pages: (limit: number) => listPages(deps, limit),
    pass: () => runCheckpointPass(deps),
    /** the two halves of a pass, for timers of their own: a slow Judge call never holds the owner's line */
    settle: async () => {
      // The second look first: it owns the reason for anything older than the threshold.
      const rechecks = await recheckOpen(deps)
      if (!rechecks.ok) return rechecks
      const reviews = await recheckReviews(deps)
      if (!reviews.ok) return reviews
      const decisions = await settleOpen(deps)
      const errands = await screenErrands(deps)
      const specs = await screenSpecs(deps)
      if (!decisions.ok) return decisions
      return errands.ok ? specs : errands
    },
    send: () => sendDuePages(deps),
  } satisfies Record<string, (input: never) => Promise<CheckpointResult<unknown>>>
}

export type CheckpointUses = ReturnType<typeof checkpointUses>
