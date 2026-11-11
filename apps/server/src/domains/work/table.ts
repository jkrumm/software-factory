import { type Effect, finalize, finalizeClosed, noteLead, startLead, startWatch } from './effects.ts'
import type { EventKind, IssueEvent } from './events.ts'
import {
  type Issue,
  MAX_REGRESSIONS,
  MAX_RESTARTS,
  type Outcome,
  outstandingDecisions,
  REOPEN_WINDOW_MS,
  type State,
  WAITS,
  type WaitReason,
  type WaitSpec,
} from './issue.ts'

/** What a cell reads: the Issue as its events made it, the event, and the time. */
export interface Ctx<K extends EventKind = EventKind> {
  issue: Issue
  event: IssueEvent<K>
  now: Date
}

/**
 * One `(state, event)` cell's answer: move (to the same state, too: the event is recorded), refuse (the verb's error,
 * named), or ignore (why this changes nothing). A move to `waiting` names its wait, keeps the current one when the
 * Issue already waits, or `update`s it in place (same `since`, same `told`); a move to `closed` names its outcome.
 */
export type Cell =
  | { to: 'waiting'; wait?: WaitSpec; update?: WaitSpec; effects: Effect[] }
  | { to: 'closed'; outcome: Outcome; effects: Effect[] }
  | { to: 'settling' | 'queued' | 'working' | 'watching'; effects: Effect[] }
  | { refuse: string }
  | { ignore: string }

/** The total table: every state takes every event. A missing cell fails `tsc`. */
export type Table = { [S in State]: { [E in EventKind]: (ctx: Ctx<E>) => Cell } }

const refuse = (why: string): Cell => ({ refuse: why })
const ignore = (why: string): Cell => ({ ignore: why })
const said = (why: string) => (): Cell => ({ ignore: why })
const refused = (why: string) => (): Cell => ({ refuse: why })

const next = (issue: Issue): number => issue.version + 1
/** A close finalizes the attempt there is, and cleans the Issue's branches; an Issue never admitted has none. */
const closing = (issue: Issue): Effect[] => (issue.attempt > 0 ? [finalizeClosed(issue.id, issue.attempt)] : [])
/**
 * Back to work: the lead hears what ended its wait, and every note recorded while it waited (a note to a waiting lead
 * plans nothing, since a wait may have no lead to type to, and an effect that cannot run holds back the Issue's next).
 */
const resume = (issue: Issue): Cell => ({
  to: 'working',
  effects: [noteLead(issue.id, issue.attempt, (issue.wait?.told ?? issue.version) + 1, next(issue))],
})

type LeadCtx = { issue: Issue; event: { kind: EventKind; payload: { attempt: number | null } } }

/** A lead's verb speaks for the attempt it was filed under; a later attempt's lead has not said it. */
const byLead =
  <C extends LeadCtx>(cell: (ctx: C) => Cell) =>
  (ctx: C): Cell => {
    const filedFor = ctx.event.payload.attempt
    if (filedFor !== ctx.issue.attempt) {
      return refuse(`${ctx.event.kind} was filed for attempt ${filedFor}; the Issue is on attempt ${ctx.issue.attempt}`)
    }
    return cell(ctx)
  }

/** A lead's verb as the lead types it, for the refusal that names it. */
const VERB_WORDS: Partial<Record<EventKind, string>> = {
  shipped: 'ship',
  deferred: 'defer',
  closed: 'close',
  submitted: 'artifact submit',
  asked: 'issue ask',
  errand_raised: 'errand raise',
  stalled: 'block',
}

/**
 * What a refused lead verb says about the wait that refuses it: what the Issue waits for, how that ends, and the verb
 * that does what the lead wanted. A lead that raised an Errand and shipped in the same turn is the case this exists for.
 */
function waitHint(issue: Issue, event: { kind: EventKind; payload?: unknown }): string {
  const { wait } = issue
  if (!wait) return ''
  const verb = VERB_WORDS[event.kind] ?? event.kind
  // `ship`, `defer` and `close` are taken again once the wait ends; the others (a second ask, a second submit) are not what comes next.
  const repeats = event.kind === 'shipped' || event.kind === 'deferred' || event.kind === 'closed'
  const later = repeats ? `then \`${verb}\`` : 'then carry on with the work'
  const ends = WAITS[wait.reason].ends
  switch (wait.reason) {
    case 'errand':
      return `it waits for an Errand (${wait.holds.id}: ${ends}), so \`${verb}\` is not taken now: raise the Errand as the last step, end the turn, and ${repeats ? `\`${verb}\`` : 'carry on'} after the note that it is done; an Errand's wait is never ended by a verb of yours, so raise one only for a person's hands`
    case 'decision':
      return `it waits for the answer to a Decision (${wait.holds.id}: ${ends}), so \`${verb}\` is not taken now: end the turn; the answer comes back as a note, ${later}`
    case 'review':
      return `it waits for the verdict on an artifact (${wait.holds.id}: ${ends}), so \`${verb}\` is not taken now: end the turn; the verdict comes back as a note, ${later}`
    case 'dependency': {
      const after = wait.after.join(', ')
      if (event.kind === 'deferred') {
        return `it is already waiting for ${after}: it resumes by itself when they close, so end the turn`
      }
      return `it waits for ${after} to close, so \`${verb}\` is not taken now: end the turn; it resumes by itself`
    }
    case 'timer':
      return ''
    default:
      return `it waits (${wait.reason}: ${ends}); \`${verb}\` is taken only from a timed wait or while working: a stall is the steward's to end, so end the turn`
  }
}

/** A timed wait takes the lead's verbs as working does; every other wait keeps its own exit, and the refusal names it. */
const fromTimer =
  <C extends { issue: Issue; event: { kind: EventKind; payload?: unknown } }>(cell: (ctx: C) => Cell) =>
  (ctx: C): Cell =>
    ctx.issue.wait?.reason === 'timer' ? cell(ctx) : refuse(waitHint(ctx.issue, ctx.event))

const noLeadYet = refused('no lead works it yet')
const watchIsOn = refused('it shipped: the watch is on, and verify ends it')
const isClosed = refused('it is closed: reopen it first')
const factoryNews = (state: string) => said(`${state}: no attempt is running for this to concern`)

const admit = (ctx: Ctx<'admitted'>): Cell => ({
  to: 'working',
  effects: [startLead(ctx.issue.id, ctx.issue.attempt + 1)],
})

const leadStarted = (ctx: Ctx<'lead_started'>): Cell =>
  ctx.event.payload.attempt === ctx.issue.attempt
    ? { to: 'working', effects: [] }
    : ignore(`a lead of attempt ${ctx.event.payload.attempt}; the Issue is on attempt ${ctx.issue.attempt}`)

const leadGone = (ctx: Ctx<'lead_gone'>): Cell => {
  const { issue } = ctx
  if (ctx.event.payload.attempt !== issue.attempt) {
    return ignore(`lead_gone is for attempt ${ctx.event.payload.attempt}; the Issue is on attempt ${issue.attempt}`)
  }
  if (issue.restarts < MAX_RESTARTS) return { to: 'queued', effects: [finalize(issue.id, issue.attempt)] }
  const detail = `the lead was gone ${issue.restarts + 1} times: ${ctx.event.payload.detail}`
  return { to: 'waiting', wait: { reason: 'lead_gone', detail }, effects: [] }
}

/** The seat is set only while no lead works: a lead that started keeps the seat it started on. */
const seatTaken = (ctx: Ctx<'seated'>): Cell =>
  refuse(`it is ${ctx.issue.state} (attempt ${ctx.issue.attempt}): the seat is set only while it is settling or queued`)

const noteWorking = (ctx: Ctx<'noted'>): Cell => ({
  to: 'working',
  effects: [noteLead(ctx.issue.id, ctx.issue.attempt, next(ctx.issue), next(ctx.issue))],
})
const noteWatching = (ctx: Ctx<'noted'>): Cell => ({
  to: 'watching',
  effects: [noteLead(ctx.issue.id, ctx.issue.attempt, next(ctx.issue), next(ctx.issue))],
})

const ask = byLead((ctx: Ctx<'asked'>): Cell => ({
  to: 'waiting',
  wait: { reason: 'decision', holds: ctx.event.payload.decision },
  effects: [],
}))
/** The steward raises a Decision for a stall it cannot end by itself: only from a stall, only for the attempt there is. */
const stewardAsk = (ctx: Ctx<'asked'>): Cell =>
  ctx.issue.wait && WAITS[ctx.issue.wait.reason].stall
    ? ask(ctx)
    : refuse('the steward asks only of a stall: the lead asks for itself')
const askedBy =
  (lead: (ctx: Ctx<'asked'>) => Cell) =>
  (ctx: Ctx<'asked'>): Cell =>
    ctx.event.actor === 'steward' ? stewardAsk(ctx) : lead(ctx)
const submit = byLead((ctx: Ctx<'submitted'>): Cell => ({
  to: 'waiting',
  wait: { reason: 'review', holds: ctx.event.payload.artifact },
  effects: [],
}))
const raiseErrand = byLead((ctx: Ctx<'errand_raised'>): Cell => ({
  to: 'waiting',
  wait: { reason: 'errand', holds: ctx.event.payload.errand },
  effects: [],
}))

const defer = byLead((ctx: Ctx<'deferred'>): Cell => {
  const { payload } = ctx.event
  if ('until' in payload) {
    if (Date.parse(payload.until) <= ctx.now.getTime()) return refuse('deferred needs a time ahead of now')
    return { to: 'waiting', wait: { reason: 'timer', until: payload.until }, effects: [] }
  }
  if (payload.after.includes(ctx.issue.id)) return refuse('an Issue is not after itself')
  return { to: 'waiting', wait: { reason: 'dependency', after: [...new Set(payload.after)] }, effects: [] }
})

/** The steward defers a holder behind an Issue that waits for the claim it keeps: only `after`, only for the attempt there is. */
const stewardDefer = (ctx: Ctx<'deferred'>): Cell => {
  const { payload } = ctx.event
  if ('until' in payload) return refuse('the steward defers only behind other Issues, never until a time')
  return defer(ctx)
}
const deferredBy =
  (lead: (ctx: Ctx<'deferred'>) => Cell) =>
  (ctx: Ctx<'deferred'>): Cell =>
    ctx.event.actor === 'steward' ? stewardDefer(ctx) : lead(ctx)

/** A shipped Issue deferred by the steward waits like any dependency, and goes back to its watch. */
const deferWatching = (ctx: Ctx<'deferred'>): Cell => {
  if (ctx.event.actor !== 'steward') return refuse('it shipped: the watch is on')
  const deferred = stewardDefer(ctx)
  if (!('to' in deferred) || deferred.to !== 'waiting' || deferred.wait?.reason !== 'dependency') return deferred
  return { ...deferred, wait: { ...deferred.wait, watching: true } }
}

/** A lead reports its own block; a wall and an unreported stop are the factory's to see. */
const stall = (ctx: Ctx<'stalled'>): Cell => {
  const { cause, attempt, detail } = ctx.event.payload
  const reporter = cause === 'blocked' ? 'lead' : 'factory'
  if (ctx.event.actor !== reporter) return refuse(`a ${cause} stall is the ${reporter}'s to report`)
  if (attempt !== ctx.issue.attempt) {
    const why = `${cause} was filed for attempt ${attempt}; the Issue is on attempt ${ctx.issue.attempt}`
    return reporter === 'lead' ? refuse(why) : ignore(why)
  }
  return { to: 'waiting', wait: { reason: cause, detail }, effects: [] }
}

const ship = byLead((ctx: Ctx<'shipped'>): Cell => ({
  to: 'watching',
  effects: [startWatch(ctx.issue.id, ctx.issue.attempt, ctx.issue.watch + 1)],
}))

/** The lead ends its work without a watch: done (nothing to deploy) or dropped. */
const closeByLead = (ctx: Ctx<'closed'>): Cell => {
  const { outcome, attempt } = ctx.event.payload
  if (outcome === 'healed') return refuse('a lead works it: healed is for an Issue no lead has started')
  if (ctx.event.actor !== 'lead') return refuse(`${outcome} is the lead's to report`)
  if (attempt !== ctx.issue.attempt) {
    return refuse(`closed was filed for attempt ${attempt}; the Issue is on attempt ${ctx.issue.attempt}`)
  }
  return { to: 'closed', outcome, effects: closing(ctx.issue) }
}

/** Before a lead starts, only the factory closes it, and only as healed. */
const heal = (ctx: Ctx<'closed'>): Cell => {
  if (ctx.event.payload.outcome !== 'healed') return refuse('no lead works it yet: only healed closes it')
  if (ctx.event.actor !== 'factory') return refuse("healed is the factory's to report")
  return { to: 'closed', outcome: 'healed', effects: closing(ctx.issue) }
}

const cancel = (ctx: Ctx<'cancelled'>): Cell => ({ to: 'closed', outcome: 'cancelled', effects: closing(ctx.issue) })

/** Ends a person's wait when it answers the checkpoint this wait holds. */
function endsCheckpoint(ctx: { issue: Issue }, reason: WaitReason, id: string): Cell {
  const { wait } = ctx.issue
  if (wait?.reason !== reason || !('holds' in wait)) return ignore(`it waits for ${wait?.reason}, not a ${reason}`)
  if (wait.holds.id !== id) return ignore(`it waits for ${reason} ${wait.holds.id}, not ${id}`)
  return resume(ctx.issue)
}

/** A review wait takes the lead's `asked` for a Decision about the artifact; the steward's ask is for a stall only. */
const askDuringReview = byLead((ctx: Ctx<'asked'>): Cell => {
  const { wait } = ctx.issue
  if (wait?.reason !== 'review') return refuse('it does not wait for a review')
  const { decision } = ctx.event.payload
  const decisions = [...(wait.decisions ?? []).filter((open) => open.id !== decision.id), decision]
  return { to: 'waiting', update: { ...wait, decisions }, effects: [] }
})
const askedWhileWaiting = (ctx: Ctx<'asked'>): Cell =>
  ctx.issue.wait?.reason === 'review' && ctx.event.actor !== 'steward'
    ? askDuringReview(ctx)
    : askedBy(fromTimer(ask))(ctx)

/** An answer ends a Decision wait, or settles one of the Decisions a review wait holds: the wait ends with the last item. */
const answerWhileWaiting = (ctx: Ctx<'answered'>): Cell => {
  const { wait } = ctx.issue
  const id = ctx.event.payload.decision
  if (wait?.reason !== 'review' || !wait.decisions?.some((open) => open.id === id)) {
    return endsCheckpoint(ctx, 'decision', id)
  }
  const decisions = wait.decisions.filter((open) => open.id !== id)
  if (wait.verdictGiven && decisions.length === 0) return resume(ctx.issue)
  return { to: 'waiting', update: { ...wait, decisions }, effects: [] }
}

/** A verdict ends a review wait, unless Decisions raised about the artifact are still open: then it waits for them. */
const verdictWhileWaiting = (ctx: Ctx<'verdict_given'>): Cell => {
  const { wait } = ctx.issue
  const artifact = ctx.event.payload.artifact
  if (wait?.reason !== 'review' || wait.holds.id !== artifact || !outstandingDecisions(wait)) {
    return endsCheckpoint(ctx, 'review', artifact)
  }
  if (wait.verdictGiven) return ignore(`the verdict on ${artifact} is given; its Decisions are still open`)
  return { to: 'waiting', update: { ...wait, verdictGiven: true }, effects: [] }
}

const wake = (ctx: Ctx<'woken'>): Cell => {
  const { issue } = ctx
  const { wait } = issue
  if (!wait) return refuse('waiting without a wait') // unreachable: replay keeps the two together
  if (ctx.event.payload.since !== wait.since) {
    return ignore(`wakes the wait that began at version ${ctx.event.payload.since}; this one began at ${wait.since}`)
  }
  if (WAITS[wait.reason].exit === 'person') return refuse(`a ${wait.reason} wait ends with its answer, not a wake`)
  if (wait.reason === 'lead_gone') return { to: 'queued', effects: [finalize(issue.id, issue.attempt)] }
  if (wait.reason === 'dependency' && wait.watching) {
    // The lead hears the note first; the new watch is the next one, and the old one ends with the wake.
    return {
      to: 'watching',
      effects: [
        noteLead(issue.id, issue.attempt, wait.told + 1, next(issue)),
        startWatch(issue.id, issue.attempt, issue.watch + 1),
      ],
    }
  }
  return resume(issue)
}

const watchPassed = (ctx: Ctx<'watch_passed'>): Cell =>
  ctx.event.payload.watch === ctx.issue.watch
    ? { to: 'closed', outcome: 'done', effects: closing(ctx.issue) }
    : ignore(`for watch ${ctx.event.payload.watch}; the current watch is ${ctx.issue.watch}`)

const regress = (ctx: Ctx<'regressed'>): Cell => {
  const { issue } = ctx
  const { watch, detail } = ctx.event.payload
  if (watch !== null && watch !== issue.watch) return ignore(`for watch ${watch}; the current watch is ${issue.watch}`)
  if (issue.regressions < MAX_REGRESSIONS) return resume(issue)
  const why = `regressed ${issue.regressions + 1} times: ${detail}`
  return { to: 'waiting', wait: { reason: 'regressed', detail: why }, effects: [] }
}

const reopen = (ctx: Ctx<'reopened'>): Cell => {
  const closedAt = ctx.issue.closedAt
  if (closedAt && ctx.now.getTime() - closedAt.getTime() > REOPEN_WINDOW_MS) {
    return refuse('closed more than 30 days ago: file a new Issue')
  }
  return { to: 'queued', effects: [] }
}

/**
 * `docs/architecture.md` §The Issue state machine: every state, every event. The diagram in `docs/language.md` is
 * generated from this table (`apps/server/scripts/issue-diagram.ts`).
 */
export const TABLE: Table = {
  settling: {
    filed: said('it is filed already'),
    settled: () => ({ to: 'queued', effects: [] }),
    admitted: refused('triage is not done: it is not queued'),
    lead_started: factoryNews('settling'),
    lead_gone: factoryNews('settling'),
    seated: () => ({ to: 'settling', effects: [] }),
    noted: () => ({ to: 'settling', effects: [] }),
    asked: noLeadYet,
    answered: said('nothing waits for an answer'),
    submitted: noLeadYet,
    verdict_given: said('nothing waits for a verdict'),
    errand_raised: noLeadYet,
    errand_done: said('nothing waits for an errand'),
    deferred: noLeadYet,
    stalled: said('settling: no lead is working'),
    woken: said('it is not waiting'),
    shipped: noLeadYet,
    watch_passed: said('it is not watching'),
    regressed: said('it is not watching'),
    reopened: refused('it is not closed'),
    cancelled: cancel,
    closed: heal,
  },
  queued: {
    filed: said('it is filed already'),
    settled: said('it is settled already'),
    admitted: admit,
    lead_started: factoryNews('queued'),
    lead_gone: factoryNews('queued'),
    seated: () => ({ to: 'queued', effects: [] }),
    noted: () => ({ to: 'queued', effects: [] }),
    asked: noLeadYet,
    answered: said('nothing waits for an answer'),
    submitted: noLeadYet,
    verdict_given: said('nothing waits for a verdict'),
    errand_raised: noLeadYet,
    errand_done: said('nothing waits for an errand'),
    deferred: noLeadYet,
    stalled: said('queued: no lead is working'),
    woken: said('it is not waiting'),
    shipped: noLeadYet,
    watch_passed: said('it is not watching'),
    regressed: said('it is not watching'),
    reopened: refused('it is not closed'),
    cancelled: cancel,
    closed: heal,
  },
  working: {
    filed: said('it is filed already'),
    settled: said('it is settled already'),
    admitted: said('it is admitted already'),
    lead_started: leadStarted,
    lead_gone: leadGone,
    seated: seatTaken,
    noted: noteWorking,
    asked: askedBy(ask),
    answered: said('nothing waits for an answer'),
    submitted: submit,
    verdict_given: said('nothing waits for a verdict'),
    errand_raised: raiseErrand,
    errand_done: said('nothing waits for an errand'),
    deferred: deferredBy(defer),
    stalled: stall,
    woken: said('it is not waiting'),
    shipped: ship,
    watch_passed: said('it is not watching'),
    regressed: said('it is working already: the lead hears it as a note'),
    reopened: refused('it is not closed'),
    cancelled: cancel,
    closed: closeByLead,
  },
  waiting: {
    filed: said('it is filed already'),
    settled: said('it is settled already'),
    admitted: said('it is admitted already'),
    lead_started: said('waiting: a lead starts only from queued'),
    lead_gone: said('waiting: the wait ends first, and its note finds the lead gone'),
    // Recorded: the note_lead of whatever ends the wait carries it (resume); a new attempt's brief reads it otherwise.
    seated: seatTaken,
    noted: () => ({ to: 'waiting', effects: [] }),
    asked: askedWhileWaiting,
    answered: answerWhileWaiting,
    submitted: fromTimer(submit),
    verdict_given: verdictWhileWaiting,
    errand_raised: fromTimer(raiseErrand),
    errand_done: (ctx) => endsCheckpoint(ctx, 'errand', ctx.event.payload.errand),
    deferred: fromTimer(deferredBy(defer)),
    stalled: (ctx) =>
      ctx.event.payload.cause === 'blocked' ? fromTimer(stall)(ctx) : ignore('waiting: no lead turn is running'),
    woken: wake,
    shipped: fromTimer(ship),
    watch_passed: said('it is not watching'),
    regressed: said('it is not watching'),
    reopened: refused('it is not closed'),
    cancelled: cancel,
    closed: fromTimer(closeByLead),
  },
  watching: {
    filed: said('it is filed already'),
    settled: said('it is settled already'),
    admitted: said('it is admitted already'),
    lead_started: said('watching: the attempt shipped'),
    lead_gone: said('watching: a regression finds a gone lead when it needs one'),
    seated: seatTaken,
    noted: noteWatching,
    asked: watchIsOn,
    answered: said('nothing waits for an answer'),
    submitted: watchIsOn,
    verdict_given: said('nothing waits for a verdict'),
    errand_raised: watchIsOn,
    errand_done: said('nothing waits for an errand'),
    deferred: deferWatching,
    stalled: (ctx) => (ctx.event.actor === 'lead' ? refuse('it shipped: the watch is on') : ignore('watching')),
    woken: said('it is not waiting'),
    shipped: watchIsOn,
    watch_passed: watchPassed,
    regressed: regress,
    reopened: refused('it is not closed'),
    cancelled: cancel,
    closed: watchIsOn,
  },
  closed: {
    filed: said('it is filed already'),
    settled: said('it is closed'),
    admitted: said('it is closed'),
    lead_started: said('it is closed: finalize ends that lead'),
    lead_gone: said('it is closed'),
    seated: isClosed,
    noted: isClosed,
    asked: isClosed,
    answered: said('it is closed: nothing waits for an answer'),
    submitted: isClosed,
    verdict_given: said('it is closed: nothing waits for a verdict'),
    errand_raised: isClosed,
    errand_done: said('it is closed: nothing waits for an errand'),
    deferred: isClosed,
    stalled: said('it is closed'),
    woken: said('it is closed'),
    shipped: isClosed,
    watch_passed: said('it is closed'),
    regressed: said('it is closed: a new fault reopens it or files a new Issue'),
    reopened: reopen,
    cancelled: refused('it is closed already'),
    closed: refused('it is closed already'),
  },
}
