import type { StewardAnswer } from '@software-factory/contract'
import { scrub } from '../../kernel/scrub.ts'
import { readDecisionForm } from '../../domains/checkpoints/decision.ts'
import type { CallPolicy } from '../../domains/loops/calls.ts'
import { checkoutOwner, judgeMainCheckout, type MainCheckoutLine } from '../../domains/loops/checkout.ts'
import type { ClaimHolder, LoopReads, LoopStore, MainCheckouts, StewardWorkflow } from '../../domains/loops/ports.ts'
import {
  checkAnswer,
  type Checked,
  decideIdle,
  decideStall,
  fallbackDecision,
  IDLE_NOTE,
  IDLE_STALL,
  idleNote,
  type IdleFacts,
  MAX_ROUNDS,
  type RepeatedStall,
  SAME_STALL,
  sameWords,
  STEWARD_DETAIL,
  type StallCause,
  type StallFacts,
  stallRequest,
  type StewardRules,
} from '../../domains/loops/stall.ts'
import { leadKey } from '../../domains/leads/names.ts'
import type { LeadStore, Seats, Windows } from '../../domains/leads/ports.ts'
import { deriveSession } from '../../domains/leads/session.ts'
import { reportedSince } from '../../domains/leads/stop.ts'
import type { Issue } from '../../domains/work/issue.ts'
import { WAITS } from '../../domains/work/issue.ts'
import type { AppliedRecord } from '../../domains/work/machine.ts'
import { replay } from '../../domains/work/machine.ts'
import type { WorkStore } from '../../domains/work/ports.ts'
import { type IssueId, issueNumber } from '../../kernel/ids.ts'
import { key, type Key } from '../../kernel/keys.ts'
import { err, ok, portError, type PortError, type Result } from '../../kernel/result.ts'
import { AGW_HANG_GUARD_MS } from '../../kernel/agw.ts'
import { askDecision, type CheckpointDeps } from '../checkpoints.ts'
import { type Claimed, claimRound } from './claim.ts'
import { recordIn, type WriteDeps } from '../issues.ts'
import type { PlanningDeps } from '../planning-deps.ts'
import { settleIssue } from '../planning-chain.ts'
import type { UnitOfWork } from '../unit-of-work.ts'

export type StewardStores = { work: WorkStore; loops: LoopStore; loopReads: LoopReads; leads: LeadStore }

export interface StewardDeps extends WriteDeps {
  uow: UnitOfWork<StewardStores>
  workflow: StewardWorkflow
  /** capacity's side of the leads' ports: the account an attempt runs on, and when its window opens again */
  seats: Seats
  windows: Windows
  /** the checkpoints' use case that raises a Decision, with the Issue's machine behind it */
  checkpoints: CheckpointDeps
  /** planning's use case that settles an Issue: the edges and the event are one transaction */
  planning: PlanningDeps
  /** capacity's side: the Issues queued for lack of a claim in their repo (called outside any transaction) */
  claimQueued(): Promise<Result<{ issue: IssueId; repo: string }[], PortError>>
  /** capacity's side: of these Issues, those a claim would be granted now, in the order that serves resumed leads (called outside any transaction) */
  claimStalled(issues: readonly IssueId[]): Promise<Result<{ issue: IssueId; account: string | null }[], PortError>>
  /** a note refused for a claim this long while a claim is free for it is a stall */
  claimStallMs: number
  rules: StewardRules
  retryMs: number
  /** an Issue still settling this long after it was filed is settled with no edges */
  settleTimeoutMs: number
  /** a watch with this many blocked checks in a row is told to its lead */
  blockedChecks: number
  /** the main checkout of a repo with a live lead, read once per pass (called outside any transaction) */
  checkouts: MainCheckouts
  /** where the pass leaves the main-checkout findings, for the health lines */
  findings: { report(found: MainCheckoutLine[]): void }
  /** lets the runner know the steward changed an Issue (the loop guard keeps it from firing the steward again) */
  changed(): void
}

export interface StewardPass {
  looked: number
  /** working Issues whose lead session was quiet */
  quiet: number
  woken: number
  requeued: number
  asked: number
  decisions: number
  settled: number
  noted: number
  deferred: number
  /** notes refused for a claim too long while the repo had one free */
  claimStalls: number
  problems: string[]
}

/** Stalled Issues looked at per pass: wide, because those the rules leave waiting (a closed wall, backoff) keep their place. */
const STALL_LIMIT = 100
const PASS_LIMIT = 20
const HISTORY_LINES = 12

const stallCause = (issue: Issue): StallCause | null => {
  const reason = issue.wait?.reason
  return issue.state === 'waiting' && reason && WAITS[reason].stall ? (reason as StallCause) : null
}

const field = (payload: unknown, name: string): string => {
  const value = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[name] : undefined
  return typeof value === 'string' ? value : ''
}

/** One line of the Issue's history: its version, the kind, and what it says of itself. Notes are marked, not quoted. */
function lineOf(record: AppliedRecord): string {
  const said = record.kind === 'noted' ? 'a note' : field(record.payload, 'detail') || field(record.payload, 'reason')
  return `v${record.version} ${record.kind}${said ? `: ${said.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`
}

/**
 * The stall the steward's last Decision on this attempt answered, when this one is the same: same cause, a detail that
 * reads alike, and no word from a person (the owner or the orchestrator) and no reopening since the answer. A re-ship of the
 * same change against the same failing check, or the lead blocking again on the same reason, is one question, not a new one.
 */
export function repeatedStall(
  id: IssueId,
  history: readonly AppliedRecord[],
  cause: StallCause,
  detail: string,
): RepeatedStall | null {
  const lastAdmitted = history.findLast((record) => record.kind === 'admitted')?.version ?? 0
  const asked = history.findLast(
    (record) => record.kind === 'asked' && record.actor === 'steward' && record.version > lastAdmitted,
  )
  if (!asked) return null
  const answered = history.find((record) => record.kind === 'answered' && record.version > asked.version)
  if (!answered) return null
  const news = history.some(
    (record) =>
      record.version > answered.version &&
      (record.kind === 'reopened' ||
        (record.kind === 'noted' && (record.actor === 'owner' || record.actor === 'orchestrator'))),
  )
  if (news) return null
  const before = replay(
    id,
    history.filter((record) => record.version < asked.version),
  ).wait
  if (before?.reason !== cause || !('detail' in before)) return null
  return sameWords(before.detail, detail) >= SAME_STALL ? { answeredAt: answered.version } : null
}

/** What the steward knows of a stalled Issue, from its events alone; `windowOpen` comes from capacity afterwards. */
export function factsOf(issue: Issue, history: readonly AppliedRecord[]): StallFacts | null {
  const cause = stallCause(issue)
  const wait = issue.wait
  if (!cause || !wait || !('detail' in wait)) return null
  const began = history.find((record) => record.version === wait.since)
  const lastAdmitted = history.findLast((record) => record.kind === 'admitted')?.version ?? 0
  return {
    issue: issue.id,
    repo: issue.repo,
    title: issue.title,
    kind: issue.kind,
    cause,
    detail: wait.detail,
    since: wait.since,
    stalledAt: began?.at ?? new Date(0),
    attempt: issue.attempt,
    restarts: issue.restarts,
    regressions: issue.regressions,
    stewardWakes: history.filter(
      (record) =>
        record.kind === 'woken' &&
        record.version > lastAdmitted &&
        field(record.payload, 'detail').startsWith(STEWARD_DETAIL),
    ).length,
    episode: 0,
    repeatOf: repeatedStall(issue.id, history, cause, wait.detail),
    notes: history
      .filter((record) => record.kind === 'noted' && record.version > wait.told)
      .map((record) => field(record.payload, 'text')),
    history: history.slice(-HISTORY_LINES).map(lineOf),
    windowOpen: null,
  }
}

const policyOf = (deps: StewardDeps): CallPolicy => ({
  maxRounds: MAX_ROUNDS,
  retryMs: deps.retryMs,
  // The lease outlives the hang guard, so a second pass takes over only when the first call can no longer be running.
  leaseMs: AGW_HANG_GUARD_MS + 5 * 60_000,
})

type Out<T> = Promise<Result<T, PortError>>

async function load(deps: StewardDeps, id: IssueId): Out<StallFacts | null> {
  const loaded = await deps.uow.run(async ({ work }) => {
    const history = await work.history(id)
    return ok(history ? { issue: replay(id, history), history } : null)
  })
  if (!loaded.ok) return loaded
  if (!loaded.value) return ok(null)
  const facts = factsOf(loaded.value.issue, loaded.value.history)
  if (!facts) return ok(null)
  if (facts.cause === 'wall') {
    // Capacity answers outside the transaction: the account the attempt runs on, and when its window opens again.
    const seat = await deps.seats.seat({ issue: id, attempt: facts.attempt })
    const wall = seat.ok ? await deps.windows.wall(seat.value.account) : seat
    if (wall.ok) facts.windowOpen = wall.value.resetAt === null || wall.value.resetAt <= deps.clock.now()
  }
  return ok(facts)
}

/** Ends the stall: the note (if any) is recorded first so the wake's `note_lead` carries it, then `woken`. */
async function wake(deps: StewardDeps, facts: StallFacts, detail: string, note: string | null): Out<boolean> {
  const done = await deps.uow.run(async ({ work }) => {
    if (note) {
      const noted = await recordIn(work, deps, {
        issueId: facts.issue,
        key: key('noted', 'steward', facts.issue, facts.since),
        event: { kind: 'noted', payload: { text: note.slice(0, 4_000) }, actor: 'steward' },
      })
      if (!noted.ok) return err(portError('refused', JSON.stringify(noted.error)))
    }
    const woken = await recordIn(work, deps, {
      issueId: facts.issue,
      key: key('woken', 'steward', facts.issue, facts.since),
      event: { kind: 'woken', payload: { since: facts.since, detail: detail.slice(0, 500) }, actor: 'steward' },
    })
    if (!woken.ok) return err(portError('refused', JSON.stringify(woken.error)))
    return ok(woken.value.result === 'applied')
  })
  return done
}

/** The Decision goes the whole way: the checkpoints' own use case, so policy, the Judge, the default and the owner follow. */
async function raise(deps: StewardDeps, facts: StallFacts, form: unknown): Out<boolean> {
  const asked = await askDecision(deps.checkpoints, {
    issueId: facts.issue,
    attempt: facts.attempt,
    form,
    by: 'steward',
    // The wait it answers is part of the Decision's key: the same question about a later stall is a new Decision.
    salt: `wait:${facts.since}`,
  })
  if (asked.ok) return ok(asked.value.result === 'applied')
  const detail = 'detail' in asked.error ? asked.error.detail : asked.error.kind
  return err(portError('refused', `the Decision was refused: ${detail}`))
}

type Acted = 'woken' | 'requeued' | 'decision' | 'nothing'

async function act(deps: StewardDeps, facts: StallFacts, checked: Checked): Out<Acted> {
  switch (checked.kind) {
    case 'none':
      return ok('nothing')
    case 'wake':
    case 'requeue': {
      const detail = `${STEWARD_DETAIL}${checked.reason}`
      const woken = await wake(deps, facts, detail, checked.note)
      if (!woken.ok) return woken
      return ok(woken.value ? (checked.kind === 'wake' ? 'woken' : 'requeued') : 'nothing')
    }
    case 'decision': {
      const raised = await raise(deps, facts, checked.form)
      return raised.ok ? ok(raised.value ? 'decision' : 'nothing') : raised
    }
  }
}

/** What the workflow said, held to the stall and to the checkpoints' own form reader. A refusal is a round spent. */
function judgeAnswer(facts: StallFacts, answer: StewardAnswer): { checked: Checked; rejected: string | null } {
  const checked = checkAnswer(facts, answer)
  if (checked.kind === 'none') return { checked, rejected: checked.why }
  if (checked.kind !== 'decision') return { checked, rejected: null }
  const form = readDecisionForm(checked.form)
  if (!form.ok) {
    return { checked: { kind: 'none', why: form.error.detail }, rejected: form.error.detail }
  }
  return { checked: { ...checked, form: form.value }, rejected: null }
}

type Asking = { kind: 'act'; checked: Checked } | { kind: 'wait'; why: string } | { kind: 'fallback' }

/** Asks `factory-steward` once per stall and round: claim and commit, call with no transaction open, record. */
async function ask(deps: StewardDeps, facts: StallFacts): Out<Asking> {
  // A quiet lead's episode also moves with its turn: one that resumed and went quiet again is a new subject, not the old answer.
  const subject = facts.episode ? `wait:${facts.since}:turn${facts.episode}` : `wait:${facts.since}`
  const now = deps.clock.now()
  const policy = policyOf(deps)
  const claimed = await deps.uow.run<Claimed, never>(async (stores) =>
    ok(
      await claimRound(stores, {
        loop: 'steward',
        issue: facts.issue,
        subject,
        now,
        policy,
        keyFor: (round) =>
          facts.episode
            ? key('steward', facts.issue, facts.since, facts.episode, round)
            : key('steward', facts.issue, facts.since, round),
      }),
    ),
  )
  if (!claimed.ok) return claimed
  const plan = claimed.value
  switch (plan.kind) {
    case 'answered': {
      // A replayed pass acts on the stored answer, never on a second call.
      const stored = plan.row.answer as StewardAnswer
      return ok({ kind: 'act', checked: judgeAnswer(facts, stored).checked })
    }
    case 'in_flight':
      return ok({ kind: 'wait', why: 'a call is in flight' })
    case 'backoff':
      return ok({ kind: 'wait', why: `the last ask came to nothing; the next waits until ${plan.until.toISOString()}` })
    case 'exhausted':
      return ok({ kind: 'fallback' })
    case 'claimed':
      break
  }

  const answered = await deps.workflow.ask(stallRequest(facts, now, scrub), plan.key)
  const verdict = answered.ok ? judgeAnswer(facts, answered.value) : null
  const recorded = await deps.uow.run(async ({ loops }) => {
    const at = deps.clock.now()
    if (!answered.ok) {
      await loops.finishCall(plan.key, {
        outcome: 'failed',
        answer: null,
        detail: `${answered.error.kind}: ${answered.error.detail}`.slice(0, 500),
        at,
      })
    } else if (verdict?.rejected) {
      await loops.finishCall(plan.key, {
        outcome: 'rejected',
        answer: answered.value,
        detail: verdict.rejected.slice(0, 500),
        at,
      })
    } else {
      await loops.finishCall(plan.key, {
        outcome: 'answered',
        answer: answered.value,
        detail: answered.value.reason,
        at,
      })
    }
    return ok(undefined)
  })
  if (!recorded.ok) return recorded
  if (verdict && !verdict.rejected) return ok({ kind: 'act', checked: verdict.checked })
  return ok({ kind: 'wait', why: answered.ok ? 'the answer was refused' : 'the ask failed' })
}

/** One stalled Issue: the rules first, the workflow only when they do not say. */
async function steward(deps: StewardDeps, id: IssueId, pass: StewardPass): Promise<void> {
  const loaded = await load(deps, id)
  if (!loaded.ok) {
    pass.problems.push(`${id}: ${loaded.error.detail}`)
    return
  }
  const facts = loaded.value
  if (!facts) return
  pass.looked++
  const action = decideStall(facts, deps.clock.now(), deps.rules)
  let acted: Result<Acted, PortError>
  switch (action.kind) {
    case 'wait':
      return
    case 'wake':
      acted = await act(deps, facts, { kind: 'wake', note: null, reason: action.detail.slice(STEWARD_DETAIL.length) })
      break
    case 'requeue':
      acted = await act(deps, facts, {
        kind: 'requeue',
        note: null,
        reason: action.detail.slice(STEWARD_DETAIL.length),
      })
      break
    case 'ask': {
      const asking = await ask(deps, facts)
      if (!asking.ok) {
        pass.problems.push(`${id}: ${asking.error.detail}`)
        return
      }
      if (asking.value.kind === 'wait') return
      if (asking.value.kind === 'fallback' && facts.cause === 'lead_gone') {
        // Its exit is a new attempt, which no Decision starts: it stays a stall the owner sees, and the problem says so.
        pass.problems.push(`${id}: lead_gone: ${MAX_ROUNDS} asks gave no usable answer; left stalled`)
        return
      }
      pass.asked++
      acted =
        asking.value.kind === 'act'
          ? await act(deps, facts, asking.value.checked)
          : await act(deps, facts, { kind: 'decision', form: fallbackDecision(facts), reason: 'no usable answer' })
      break
    }
  }
  if (!acted.ok) {
    pass.problems.push(`${id}: ${acted.error.detail}`)
    return
  }
  if (acted.value === 'woken') pass.woken++
  else if (acted.value === 'requeued') pass.requeued++
  else if (acted.value === 'decision') pass.decisions++
}

export interface Idle {
  /** the facts as the workflow takes them: a working Issue with a quiet lead reads as an `unreported` stall */
  facts: StallFacts
  idle: IdleFacts
}

const isIdleNote = (record: AppliedRecord): boolean =>
  record.kind === 'noted' && field(record.payload, 'text').startsWith(IDLE_NOTE)

/**
 * A working Issue whose lead session went quiet: its turn ended, no tool runs, nothing was reported since the turn began
 * (`working` and mid-turn sessions are never read here). Null for every other Issue.
 */
export async function loadIdle(deps: Pick<StewardDeps, 'uow'>, id: IssueId): Out<Idle | null> {
  return deps.uow.run<Idle | null, never>(async ({ work, leads }) => {
    const history = await work.history(id)
    if (!history) return ok(null)
    const issue = replay(id, history)
    if (issue.state !== 'working') return ok(null)
    const attempt = await leads.attempt(id, issue.attempt)
    // A lead that never started or is gone is the leads loop's: it requeues, the steward only nudges a live terminal.
    if (!attempt?.terminal || attempt.goneAt) return ok(null)
    const view = deriveSession(await leads.hookFacts(leadKey(id, issue.attempt)))
    if (!view.idleSince) return ok(null)
    if (view.lastTurnAt && reportedSince(history, issue.attempt, view.lastTurnAt)) return ok(null)

    const lastAdmitted = history.findLast((record) => record.kind === 'admitted')?.version ?? 0
    const wakes = history.filter((record) => record.version > lastAdmitted && isIdleNote(record))
    const lastWake = wakes.at(-1)
    const last = history.findLast((record) => !isIdleNote(record))
    const lastEvent = last ? `${lineOf(last)} (${last.at.toISOString()})` : 'none'
    const quietSince = lastWake && lastWake.at > view.idleSince ? lastWake.at : view.idleSince
    return ok({
      idle: { idleSince: view.idleSince, quietSince, wakes: wakes.length, lastEvent, background: view.backgroundTasks },
      facts: {
        issue: id,
        repo: issue.repo,
        title: issue.title,
        kind: issue.kind,
        cause: 'unreported',
        detail: `${IDLE_STALL} since ${view.idleSince.toISOString()} on a working Issue, with nothing reported and no tool running; the Issue's last event: ${lastEvent}`,
        // the idle episode: the version of the last wake, so a later episode is a new subject of the workflow
        since: lastWake?.version || issue.version,
        stalledAt: view.idleSince,
        attempt: issue.attempt,
        restarts: issue.restarts,
        regressions: issue.regressions,
        stewardWakes: wakes.length,
        episode: view.turns,
        repeatOf: null,
        notes: [],
        history: history.slice(-HISTORY_LINES).map(lineOf),
        windowOpen: null,
      },
    })
  })
}

/** One note by the steward on the working Issue, once per key; true when it was recorded. */
async function noteIdle(deps: StewardDeps, facts: StallFacts, text: string, noteKey: Key): Out<boolean> {
  return deps.uow.run(async ({ work }) => {
    const noted = await recordIn(work, deps, {
      issueId: facts.issue,
      key: noteKey,
      event: { kind: 'noted', payload: { text: scrub(text).slice(0, 4_000) }, actor: 'steward' },
    })
    if (!noted.ok) return err(portError('refused', JSON.stringify(noted.error)))
    return ok(noted.value.result === 'applied')
  })
}

/**
 * What the workflow's answer comes to for a quiet lead: a note typed to it, or nothing. Never a Decision: a quiet lead is a
 * session still working on its Issue, and the options of a Decision about it (pause, drop, start a fresh lead) are ones no
 * part of the factory applies. The self-watch loop files a quiet lead for the owner's side.
 */
async function answerIdle(deps: StewardDeps, idle: Idle, checked: Checked, minutes: number): Out<Acted> {
  if (checked.kind !== 'wake') return ok('nothing')
  const { facts } = idle
  const text = idleNote(minutes, idle.idle.lastEvent, checked.note ?? checked.reason, idle.idle.background)
  const noted = await noteIdle(
    deps,
    facts,
    text,
    key('noted', 'steward', 'idle-ask', facts.issue, facts.since, facts.episode),
  )
  return noted.ok ? ok(noted.value ? 'woken' : 'nothing') : noted
}

function tally(pass: StewardPass, id: IssueId, acted: Result<Acted, PortError>): void {
  if (!acted.ok) pass.problems.push(`${id}: ${acted.error.detail}`)
  else if (acted.value === 'woken') pass.woken++
  else if (acted.value === 'decision') pass.decisions++
}

/** The workflow is asked about a lead that stays quiet after its wakes; the answer is held to the same checks as a stall's. */
async function askIdle(deps: StewardDeps, idle: Idle, minutes: number, pass: StewardPass): Promise<void> {
  const asking = await ask(deps, idle.facts)
  if (!asking.ok) return tally(pass, idle.facts.issue, asking)
  // Asked out without a usable answer: the lead is left to its own turn, and self-watch has filed it.
  if (asking.value.kind !== 'act') return
  pass.asked++
  tally(pass, idle.facts.issue, await answerIdle(deps, idle, asking.value.checked, minutes))
}

/** One working Issue: the lead gets a nudge naming the Issue's last event, `maxWakes` times; after that the workflow is asked. */
async function nudgeIdle(deps: StewardDeps, id: IssueId, pass: StewardPass): Promise<void> {
  const loaded = await loadIdle(deps, id)
  if (!loaded.ok) return tally(pass, id, loaded)
  const idle = loaded.value
  if (!idle) return
  pass.quiet++
  const now = deps.clock.now()
  const action = decideIdle(idle.idle, now, deps.rules)
  if (action.kind === 'wake') {
    const wakeKey = key('noted', 'steward', 'idle', id, idle.facts.attempt, idle.idle.wakes + 1)
    const noted = await noteIdle(deps, idle.facts, action.detail, wakeKey)
    return tally(pass, id, noted.ok ? ok(noted.value ? 'woken' : 'nothing') : noted)
  }
  if (action.kind === 'ask') {
    const minutes = Math.max(0, Math.floor((now.getTime() - idle.idle.idleSince.getTime()) / 60_000))
    await askIdle(deps, idle, minutes, pass)
  }
}

/**
 * The checkout a watch needs could not be moved for `blockedChecks` checks in a row (package 5 reads and waits, it does
 * not tell): the lead hears it once per watch, as a note. The machine has no stall for a watching Issue, so a note is the
 * one action the steward has here.
 */
async function noteBlockedCheckouts(deps: StewardDeps, pass: StewardPass): Promise<void> {
  const blocked = await deps.uow.run(async ({ loopReads }) =>
    ok(await loopReads.blockedCheckouts(deps.blockedChecks, PASS_LIMIT)),
  )
  if (!blocked.ok) {
    pass.problems.push(`blocked checkouts: ${blocked.error.detail}`)
    return
  }
  for (const watch of blocked.value) {
    const text = `The checkout that verify needs could not be moved to the shipped commit for ${watch.checks} checks in a row since ${watch.since.toISOString()}: ${watch.detail.replace(/\s+/g, ' ').slice(0, 300)}. Verify cannot pass until it can; fix the checkout, then the watch goes on.`
    await noteOnce(deps, pass, watch.issue, key('noted', 'steward', 'blocked-checkout', watch.issue, watch.watch), text)
  }
}

/** One steward note on an Issue, recorded under its key (a replay or a repeat is `ignored`); counted when it was new. */
async function noteOnce(
  deps: StewardDeps,
  pass: StewardPass,
  issueId: IssueId,
  noteKey: Key,
  text: string,
): Promise<void> {
  const noted = await deps.uow.run(async ({ work }) => {
    const recorded = await recordIn(work, deps, {
      issueId,
      key: noteKey,
      event: { kind: 'noted', payload: { text: scrub(text) }, actor: 'steward' },
    })
    if (!recorded.ok) return err(portError('refused', JSON.stringify(recorded.error)))
    return ok(recorded.value.result === 'applied')
  })
  if (!noted.ok) pass.problems.push(`${issueId}: ${noted.error.detail}`)
  else if (noted.value) pass.noted++
}

/**
 * The main checkout of a repo with a live lead (`working` or `watching`), read once per pass from local refs: off its
 * default branch, or with tracked uncommitted changes, it is a health line, and one note (once per branch state and
 * clean/dirty, not per changed path) to the lead whose branch it is, when its branch is a live lead's. No other lead can act
 * on it, so no other lead hears it. A repo that cannot be read is a problem and leaves no line.
 */
async function noteMainCheckouts(deps: StewardDeps, pass: StewardPass): Promise<void> {
  const live = await deps.uow.run(async ({ loopReads }) => ok(await loopReads.liveRepos(PASS_LIMIT)))
  if (!live.ok) {
    pass.problems.push(`main checkouts: ${live.error.detail}`)
    return
  }
  const lines: MainCheckoutLine[] = []
  for (const { repo, issues } of live.value) {
    const finding = await findMainCheckout(deps, pass, repo)
    if (!finding) continue
    // One note per checkout state, to the lead whose branch it is; no other lead can act on it. Every other state (the
    // default branch with dirty files, a branch of the owner's or of the plan-owning session) is the health line alone.
    const owner = checkoutOwner(finding, issues)
    lines.push({ repo, issues, since: deps.clock.now(), noted: owner, ...finding })
    if (owner) {
      await noteOnce(
        deps,
        pass,
        owner,
        key('noted', 'steward', 'main-checkout', owner, finding.fingerprint),
        finding.text,
      )
    }
  }
  deps.findings.report(lines)
}

/** What is wrong with a repo's main checkout, if anything; a checkout that cannot be read is a problem of the pass. */
async function findMainCheckout(deps: StewardDeps, pass: StewardPass, repo: string) {
  const looked = await deps.checkouts.look(repo)
  if (!looked.ok) {
    pass.problems.push(`main checkout ${repo}: ${looked.error.detail}`)
    return null
  }
  return looked.value && judgeMainCheckout(looked.value)
}

/**
 * The claim deadlock: a working or watching Issue is after an Issue of its own repo that stays queued for lack of a
 * claim, and holds the only one. It is deferred behind that Issue (a dependency wait frees the claim; the woken Issue is
 * counted as owed and served before new leads), with the reason in the event itself. The edge is the owner's `after`. Only open planning edges are read, never what a lead or a
 * subagent wrote: an Issue that merely mentions another is not detected.
 */
async function breakClaimDeadlocks(deps: StewardDeps, pass: StewardPass): Promise<void> {
  const queued = await deps.claimQueued()
  if (!queued.ok) {
    pass.problems.push(`claim queue: ${queued.error.detail}`)
    return
  }
  const holders = await deps.uow.run(async ({ loopReads }) =>
    ok(
      await loopReads.claimHolders(
        queued.value.map((q) => q.issue),
        PASS_LIMIT,
      ),
    ),
  )
  if (!holders.ok) {
    pass.problems.push(`claim holders: ${holders.error.detail}`)
    return
  }
  for (const holder of holders.value) {
    const deferred = await deferHolder(deps, holder)
    if (!deferred.ok) pass.problems.push(`${holder.issue}: ${deferred.error.detail}`)
    else if (deferred.value) pass.deferred++
  }
}

async function deferHolder(deps: StewardDeps, holder: ClaimHolder): Out<boolean> {
  return deps.uow.run(async ({ work }) => {
    const history = await work.history(holder.issue)
    if (!history) return ok(false)
    const issue = replay(holder.issue, history)
    if (issue.state !== 'working' && issue.state !== 'watching') return ok(false)
    const names = holder.blockers.map((id) => `Issue ${issueNumber(id)}`).join(', ')
    const why = `${names} stays queued for lack of a claim in ${issue.repo}, and this Issue holds it while it is after ${holder.blockers.length === 1 ? 'that Issue' : 'them'}`
    const wakes = holder.blockers.length === 1 ? 'it closes' : 'they close'
    const resumes = issue.state === 'watching' ? 'the watch runs again' : 'work resumes'
    const noted = await recordIn(work, deps, {
      issueId: issue.id,
      key: key('noted', 'steward', 'claim-deadlock', issue.id, issue.version),
      event: {
        kind: 'noted',
        payload: {
          text: `${why}: a deadlock. It is deferred behind ${names} and wakes when ${wakes}; then ${resumes}.`,
        },
        actor: 'steward',
      },
    })
    if (!noted.ok) return err(portError('refused', JSON.stringify(noted.error)))
    const deferred = await recordIn(work, deps, {
      issueId: issue.id,
      key: key('deferred', 'steward', 'claim-deadlock', issue.id, issue.version),
      event: {
        kind: 'deferred',
        payload: { attempt: issue.attempt, after: holder.blockers, why },
        actor: 'steward',
      },
    })
    if (!deferred.ok) return err(portError('refused', JSON.stringify(deferred.error)))
    // A refusal rolls the note back too: the deferral is one change.
    if (deferred.value.result === 'refused' || deferred.value.result === 'ignored') {
      return err(portError('refused', `the deferral was ${deferred.value.result}`))
    }
    return ok(deferred.value.result === 'applied')
  })
}

/**
 * The claim livelock: a lead's note has been refused for a claim for longer than `claimStallMs` while a claim would be
 * granted to it now. A full repo, or free places that go to resumed leads ahead of it (a herd woken at once), is a
 * rightful wait; a free place nobody takes is a stall of the order that serves resumed leads, so it is a problem line
 * on the pass and one note on the Issue (once per run of refusals). The account is named and is never the reason: a
 * resume is not held by the account cap.
 */
async function noteClaimStalls(deps: StewardDeps, pass: StewardPass): Promise<void> {
  const refused = await deps.uow.run(async ({ loopReads }) => ok(await loopReads.claimRefusals(PASS_LIMIT)))
  if (!refused.ok) {
    pass.problems.push(`claim refusals: ${refused.error.detail}`)
    return
  }
  const now = deps.clock.now().getTime()
  const overdue = refused.value.filter((r) => now - r.since.getTime() >= deps.claimStallMs)
  if (overdue.length === 0) return
  const stalled = await deps.claimStalled(overdue.map((r) => r.issue))
  if (!stalled.ok) {
    pass.problems.push(`claim stalled: ${stalled.error.detail}`)
    return
  }
  const accountOf = new Map(stalled.value.map((s) => [s.issue, s.account]))
  for (const stall of overdue) {
    if (!accountOf.has(stall.issue)) continue
    const on = accountOf.get(stall.issue) ?? 'no account on file'
    pass.claimStalls++
    pass.problems.push(
      `Issue ${issueNumber(stall.issue)}: refused for a claim ${stall.refusals} times since ${stall.since.toISOString()} while a claim in ${stall.repo} is free for it (resumes on ${on})`,
    )
    const text = `A note to this lead has been refused for a claim ${stall.refusals} times since ${stall.since.toISOString()}, and a claim in ${stall.repo} is free for it: a stall of the resume order, not a full repo and not the account cap (it resumes on ${on}, and the cap never holds a resume back).`
    await noteOnce(
      deps,
      pass,
      stall.issue,
      key('noted', 'steward', 'claim-stall', stall.issue, stall.since.toISOString()),
      text,
    )
  }
}

/** An Issue that stays `settling` after the timeout is settled with no edges: nothing waits forever for an answer. */
async function settleOverdue(deps: StewardDeps, pass: StewardPass): Promise<void> {
  const overdue = await deps.uow.run(async ({ loopReads }) => ok(await loopReads.settling(PASS_LIMIT)))
  if (!overdue.ok) {
    pass.problems.push(`settling: ${overdue.error.detail}`)
    return
  }
  const now = deps.clock.now().getTime()
  for (const row of overdue.value) {
    if (now - row.filedAt.getTime() < deps.settleTimeoutMs) continue
    const settled = await settleIssue(deps.planning, { issue: row.issue, after: [] })
    if (!settled.ok) pass.problems.push(`${row.issue}: settle: ${JSON.stringify(settled.error)}`.slice(0, 300))
    else if (settled.value.result === 'settled') pass.settled++
  }
}

/**
 * One pass of the steward over the stalled Issues, the Issues settling too long, the checkouts blocked too long and the
 * main checkouts of repos with a live lead.
 */
export async function stewardPass(deps: StewardDeps): Out<StewardPass> {
  const pass: StewardPass = {
    looked: 0,
    quiet: 0,
    woken: 0,
    requeued: 0,
    asked: 0,
    decisions: 0,
    settled: 0,
    noted: 0,
    deferred: 0,
    claimStalls: 0,
    problems: [],
  }
  const stalled = await deps.uow.run(async ({ loopReads }) => ok(await loopReads.stalled(STALL_LIMIT)))
  if (!stalled.ok) return stalled
  for (const id of stalled.value) await steward(deps, id, pass)
  const working = await deps.uow.run(async ({ loopReads }) => ok(await loopReads.working(STALL_LIMIT)))
  if (working.ok) for (const id of working.value) await nudgeIdle(deps, id, pass)
  else pass.problems.push(`working: ${working.error.detail}`)
  await settleOverdue(deps, pass)
  await noteBlockedCheckouts(deps, pass)
  await noteMainCheckouts(deps, pass)
  await breakClaimDeadlocks(deps, pass)
  await noteClaimStalls(deps, pass)
  if (pass.woken + pass.requeued + pass.decisions + pass.settled + pass.noted + pass.deferred > 0) deps.changed()
  return ok(pass)
}

export const stewardSummary = (pass: StewardPass): string =>
  `looked at ${pass.looked} stalled and ${pass.quiet} quiet; woken ${pass.woken}, requeued ${pass.requeued}, asked ${pass.asked}, Decisions ${pass.decisions}, settled ${pass.settled}, noted ${pass.noted}, deferred ${pass.deferred}, claim stalls ${pass.claimStalls}${pass.problems.length ? `; ${pass.problems.length} problem(s): ${pass.problems.slice(0, 3).join(' | ')}` : ''}`
