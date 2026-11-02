import { basename } from 'node:path'
import {
  type FleetReaper,
  NO_REAPER,
  type ReaperClosed,
  type ReaperKept,
  type ReaperMode,
} from '@software-factory/contract'
import type { SQL } from 'bun'
import { real } from '../runner.ts'
import { enclosingRepo } from '../projects/sync.ts'
import type { GitReader } from './git.ts'
import type { MergedSession } from './model.ts'
import type { Places } from './place.ts'
import { type HcCloser, NotClosed } from './sources.ts'
import { closingReaped, insertLog, type NewLogRow, oldClosing, settleReaped } from './triage-store.ts'

/** A session is idle for this long (no turn, no hook event, hc not working) before it is looked at. */
export const REAPER_IDLE_MS = 2 * 3_600_000
/** Closes tried per pass; the rest wait for the next build. */
export const REAPER_MAX_CLOSES = 5
/** How long git's answer for a worktree stands, kept or not: git is not asked about the same worktree on every build (the close asks again). */
const VERDICT_TTL_MS = 120_000
/** No new step of a pass starts after this long: the closes run after the snapshot is stored, and a slow hc must not hold the next build. */
export const REAPER_ACT_BUDGET_MS = 60_000
/** A close that was started and never confirmed shows in `closed` as unsettled once it is this old. */
const UNSETTLED_AFTER_MS = 3_600_000
/** `closed` shows the last day. */
const CLOSED_WINDOW_MS = 24 * 3_600_000
const EVAL_CONCURRENCY = 4
const WORKTREE = /^(.+?)\/\.claude\/worktrees\/([^/]+)(?:\/.*)?$/

export interface ReaperDeps {
  sql: SQL
  now: () => Date
  mode: ReaperMode
  git: GitReader
  /** ends a terminal; without it `on` closes nothing */
  closer?: HcCloser
  /** the time one pass of `act` may begin new steps in (the injected clock) */
  actBudgetMs?: number
}

export interface ReaperInput {
  sessions: readonly MergedSession[]
  /** the real paths of the ordinary roots (`FACTORY_REPO_ROOTS`): a repo outside them is never acted on */
  roots: readonly string[]
  places: Places
  /** hc and the database answered in this build: with a stale list nothing is closed */
  complete: boolean
}

/** What the build's part of the reaper found: the model's part, and what `act` does after the snapshot is stored. */
export interface ReaperLook {
  reaper: FleetReaper
  plan: ReaperPlan
  errors: string[]
}

export interface ReaperPlan {
  /** reconcile the unsettled rows (any mode but `off`, hc answered) */
  reconcile: boolean
  /** in the order they are closed; only in `on`, when hc and the database answered */
  close: readonly Eligible[]
}

const NO_PLAN: ReaperPlan = { reconcile: false, close: [] }

/** What the guards found for one idle worktree session. */
export interface Eligible {
  id: string
  address: string
  /** hc's own cwd, as the core reports it: the close checks the terminal is still there */
  cwd: string
  repo: string
  main: string
  worktree: string
  name: string
  idleSince: string
  proof: string
  parent: string
}

interface Found {
  m: MergedSession
  main: string
  worktree: string
  name: string
  idleSince: string
  /** hc's own cwd, the one every guard reads */
  cwd: string
}

type Judged = { keep: ReaperKept } | { eligible: Eligible }

interface GitAnswer {
  reasons: string[]
  proof: string
}

const keyOf = (c: { m: MergedSession; cwd: string }): string => `${c.m.hc?.address}\0${c.cwd}`
/** `<repo>/.claude/worktrees/<name>[/…]`: the repo's main checkout and the worktree's root. */
function worktreeOf(path: string): { main: string; worktree: string; name: string } | undefined {
  const found = WORKTREE.exec(path)
  return found?.[1] && found[2]
    ? { main: found[1], worktree: `${found[1]}/.claude/worktrees/${found[2]}`, name: found[2] }
    : undefined
}
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const inside = (path: string, roots: readonly string[]) => roots.some((root) => path.startsWith(`${root}/`))

/**
 * The reaper (FV Wave 5, docs/design.md §11 "The reaper"): closes a finished worker session, `hc kill` then `hc rm`, when everything
 * says it is done: Claude Code in a worktree of an ordinary repo, idle two hours, the worktree clean, the branch merged into the
 * default branch, nobody waiting on it. The worktree stays (`rd fan --clean` owns worktrees). It runs in the fleet build (off the tick, in no
 * transaction, git bounded) and acts through `HcCloser`. One row per close in `fleet_triage_log` (kind `reaped`, not undoable).
 * `dry` lists what it would close and closes nothing; `off` reads nothing.
 */
export class Reaper {
  /** git's answer for a worktree, by terminal and directory, for a while */
  private readonly answers = new Map<string, { at: number; answer: GitAnswer }>()
  /** closes that failed, by terminal: a failing one goes behind the others, so it cannot starve them */
  private readonly failures = new Map<string, number>()
  /** what the last `act` had to say: it runs after the snapshot is stored, so the next build carries it */
  private carried: string[] = []

  constructor(private readonly deps: ReaperDeps) {}

  /**
   * The build's part: judges the idle worktree sessions (reads git and the database, calls no port) and answers the model's `reaper` and
   * the plan `act` carries out once the snapshot is stored. `off` reads nothing but the closes left unsettled for over an hour.
   */
  async look(input: ReaperInput): Promise<ReaperLook> {
    const { mode, now } = this.deps
    const errors = this.carried
    this.carried = []
    const at = now()
    if (mode === 'off') {
      const unsettled = await this.unsettled(at).catch((error: unknown) => {
        errors.push(`reaper: unsettled closes could not be read: ${message(error)}`)
        return []
      })
      return { reaper: { ...NO_REAPER, closed: unsettled }, plan: NO_PLAN, errors }
    }

    const closer = this.deps.closer
    const canAct = input.complete && closer !== undefined
    if (mode === 'on' && !canAct) {
      errors.push(
        closer
          ? 'reaper: hc or the database did not answer in this build; nothing is closed'
          : 'reaper: no way to close a terminal; nothing is closed',
      )
    }

    let judged: Judged[] = []
    try {
      judged = await this.judge(input, await this.openIssues(), at)
    } catch (error) {
      // Without knowing which sessions an Issue holds nothing is judged, and nothing is closed.
      errors.push(`reaper: open Issues could not be read: ${message(error)}`)
    }
    const eligible = judged.flatMap((j) => ('eligible' in j ? [j.eligible] : []))
    const present = new Set(eligible.map((e) => e.address))
    for (const address of this.failures.keys()) if (!present.has(address)) this.failures.delete(address)
    eligible.sort(
      (a, b) =>
        (this.failures.get(a.address) ?? 0) - (this.failures.get(b.address) ?? 0) ||
        a.idleSince.localeCompare(b.idleSince) ||
        a.id.localeCompare(b.id),
    )

    const history = await this.recent(at).catch((error: unknown) => {
      errors.push(`reaper: the closed sessions could not be read: ${message(error)}`)
      return []
    })
    const unsettled = await this.unsettled(at).catch((error: unknown) => {
      errors.push(`reaper: unsettled closes could not be read: ${message(error)}`)
      return []
    })
    const dry: ReaperClosed[] =
      mode === 'dry'
        ? eligible.map((e) => ({
            session: e.id,
            repo: e.repo,
            what: whatOf(e, true),
            why: whyOf(true),
            evidence: evidenceOf(e),
            at: null,
            dry: true,
            unsettled: false,
            logId: null,
          }))
        : []
    return {
      reaper: {
        mode,
        closed: [...history, ...unsettled, ...dry],
        kept: judged.flatMap((j) => ('keep' in j ? [j.keep] : [])),
      },
      plan: { reconcile: canAct, close: mode === 'on' && canAct ? eligible.slice(0, REAPER_MAX_CLOSES) : [] },
      errors,
    }
  }

  /**
   * The closes, after the snapshot is stored: first the rows an earlier pass left unsettled, then the plan, one at a time. No new step
   * starts once the budget is spent (the rest waits for the next pass). Returns the terminals that are gone.
   */
  async act(plan: ReaperPlan): Promise<ReadonlySet<string>> {
    const closed = new Set<string>()
    const closer = this.deps.closer
    if (!closer || (!plan.reconcile && plan.close.length === 0)) return closed
    const { now } = this.deps
    const deadline = now().getTime() + (this.deps.actBudgetMs ?? REAPER_ACT_BUDGET_MS)
    const spent = () => now().getTime() >= deadline
    const errors: string[] = []
    try {
      if (plan.reconcile) await this.reconcile(closer, errors, spent)
      for (const e of plan.close) {
        if (spent()) {
          errors.push(`reaper: the time of this pass is spent; ${e.id} and the sessions behind it wait for the next`)
          break
        }
        if (await this.closeOne(closer, e, now(), errors)) closed.add(e.address)
      }
    } finally {
      this.carried.push(...errors)
    }
    return closed
  }

  /** Every session the guards look at, judged: cheap guards first, git only for what is left. */
  private async judge(
    input: ReaperInput,
    holds: { sessions: Set<string>; paths: string[] },
    at: Date,
  ): Promise<Judged[]> {
    const byId = new Map(input.sessions.map((m) => [m.session.id, m]))
    const nowMs = at.getTime()
    const out: Judged[] = []
    const found: Found[] = []
    for (const m of input.sessions) {
      const c = this.candidate(m, input, holds, nowMs)
      if (!c) continue
      if ('keep' in c) {
        out.push(c)
        continue
      }
      const parent = m.session.parent ? byId.get(m.session.parent) : undefined
      // A parent that waits on workers may still send this one fixes.
      if (parent?.session.wait === 'workers') continue
      found.push(c.found)
    }

    const alive = new Set(found.map(keyOf))
    for (const key of this.answers.keys()) if (!alive.has(key)) this.answers.delete(key)

    for (let i = 0; i < found.length; i += EVAL_CONCURRENCY) {
      const part = await Promise.all(found.slice(i, i + EVAL_CONCURRENCY).map((c) => this.look1(c, byId, nowMs)))
      out.push(...part)
    }
    return out
  }

  /**
   * The session if the cheap guards let it be looked at: Claude Code in an ordinary repo's worktree, idle, no Issue's. Every guard reads hc's
   * own directory; the factory's record of it must be in the same worktree, else the session is kept ("cwd moved").
   */
  private candidate(
    m: MergedSession,
    input: ReaperInput,
    holds: { sessions: Set<string>; paths: string[] },
    nowMs: number,
  ): { found: Found } | { keep: ReaperKept } | undefined {
    const term = m.hc
    if (!term?.claude || !term.cwd) return undefined
    const hcCwd = real(term.cwd)
    const here = worktreeOf(hcCwd)
    const recorded = m.cwd ? worktreeOf(m.cwd) : undefined
    const mine = here ?? recorded
    if (!mine) return undefined
    // A repo directly under an ordinary root and not IuRoot's, for every directory the two sources name.
    for (const path of [hcCwd, m.cwd]) {
      if (!path || input.places.isVisible(path)) return undefined
      const w = worktreeOf(path)
      if (
        w &&
        (!inside(w.main, input.roots) ||
          enclosingRepo(w.main, input.roots) !== w.main ||
          input.places.isVisible(w.main))
      ) {
        return undefined
      }
    }
    // The session's state and hc's agree it is not working; hc's word must be there. Fails closed: an age that is not a number keeps it.
    if (m.session.state !== 'idle' || (term.status !== 'idle' && term.status !== 'done')) return undefined
    const idleSince = m.session.lastActivityAt
    if (!idleSince || !(nowMs - Date.parse(idleSince) >= REAPER_IDLE_MS)) return undefined
    // A session of an open Issue (its lead, or anything in the lead's worktree) is never closed.
    if (holds.sessions.has(m.session.id)) return undefined
    const worktreeReal = real(mine.worktree)
    if (holds.paths.some((p) => worktreeReal === p || worktreeReal.startsWith(`${p}/`))) return undefined
    if (!here || !recorded || here.worktree !== recorded.worktree) {
      return {
        keep: {
          session: m.session.id,
          repo: basename(mine.main),
          why: `cwd moved: hc has it in ${hcCwd}, the factory has ${m.cwd ?? 'none'}`,
        },
      }
    }
    return { found: { m, main: here.main, worktree: here.worktree, name: here.name, idleSince, cwd: term.cwd } }
  }

  private async look1(c: Found, byId: ReadonlyMap<string, MergedSession>, nowMs: number): Promise<Judged> {
    const { m, main, worktree } = c
    const key = keyOf(c)
    const cached = this.answers.get(key)
    let answer: GitAnswer
    if (cached && nowMs - cached.at < VERDICT_TTL_MS) answer = cached.answer
    else {
      answer = await this.gitVerdict(worktree)
      this.answers.set(key, { at: nowMs, answer })
    }
    if (answer.reasons.length > 0) {
      return { keep: { session: m.session.id, repo: basename(main), why: answer.reasons.join('; ') } }
    }
    const parentId = m.session.parent
    const parent = parentId ? byId.get(parentId) : undefined
    return {
      eligible: {
        id: m.session.id,
        address: m.hc?.address ?? '',
        cwd: c.cwd,
        repo: basename(main),
        main,
        worktree,
        name: c.name,
        idleSince: c.idleSince,
        proof: answer.proof,
        parent: !parentId
          ? 'no parent'
          : parent
            ? `parent ${parentId} is ${parent.session.state}, not waiting on workers`
            : `parent ${parentId} is gone`,
      },
    }
  }

  /** Sessions of an Issue that is not closed, and the lead worktrees of such Issues (real paths). */
  private async openIssues(): Promise<{ sessions: Set<string>; paths: string[] }> {
    const { sql } = this.deps
    const sessions: { id: string }[] = await sql`
      SELECT s.id FROM factory.sessions s JOIN factory.issues i ON i.id = s.issue_id WHERE i.state <> 'closed'`
    const paths: { path: string }[] = await sql`
      SELECT w.path FROM factory.lead_worktrees w JOIN factory.issues i ON i.id = w.issue_id
      WHERE i.state <> 'closed' AND w.path IS NOT NULL`
    return { sessions: new Set(sessions.map((r) => r.id)), paths: paths.map((r) => real(r.path)) }
  }

  /** The reaper's rows of the last 24 h, newest first. */
  private async recent(at: Date): Promise<ReaperClosed[]> {
    const rows: {
      id: string
      what: string
      why: string
      evidence: string
      payload: { session?: string; repo?: string }
      at: Date
    }[] = await this.deps.sql`
      SELECT id, what, why, evidence, payload, at FROM factory.fleet_triage_log
      WHERE kind = 'reaped' AND payload->>'state' IS DISTINCT FROM 'closing' AND at >= ${new Date(at.getTime() - CLOSED_WINDOW_MS)} ORDER BY id DESC LIMIT 100`
    return rows.map((r) => ({
      session: r.payload.session ?? '',
      repo: r.payload.repo ? basename(r.payload.repo) : '',
      what: r.what,
      why: r.why,
      evidence: r.evidence,
      at: r.at.toISOString(),
      dry: false,
      unsettled: false,
      logId: Number(r.id),
    }))
  }

  /** Closes started and never confirmed for over an hour: shown, never hidden (the terminal may or may not be gone). */
  private async unsettled(at: Date): Promise<ReaperClosed[]> {
    const rows = await oldClosing(this.deps.sql, new Date(at.getTime() - UNSETTLED_AFTER_MS))
    return rows.map((r) => ({
      session: r.session,
      repo: r.repo ? basename(r.repo) : '',
      what: r.what,
      why: 'Unsettled: the close was started and has not been confirmed for over an hour; the terminal may or may not be gone.',
      evidence: r.evidence,
      at: r.at,
      dry: false,
      unsettled: true,
      logId: r.id,
    }))
  }

  /** Why a worktree is not closable now (an empty list: nothing holds it), and the merge proof. Git is asked fresh, never from the cache. */
  private async gitVerdict(worktree: string): Promise<GitAnswer> {
    const reasons: string[] = []
    let proof = ''
    try {
      const dirty = await this.deps.git.dirtyEntries(worktree)
      if (dirty > 0) reasons.push(`the worktree has ${dirty} uncommitted or untracked entr${dirty === 1 ? 'y' : 'ies'}`)
      const merge = await this.deps.git.mergeProof(worktree)
      if (merge.merged) proof = merge.proof
      else
        reasons.push(
          `branch ${(await this.deps.git.branchOf(worktree)) ?? 'detached head'} is not merged: ${merge.proof}`,
        )
    } catch (error) {
      reasons.push(`cannot tell: ${message(error)}`)
    }
    return { reasons, proof }
  }

  /**
   * One close: the worktree is looked at again, the row is written first (`closing`; its key is the terminal and its idle time), the
   * terminal is closed, the row is settled. True when the terminal is gone. A close that did nothing takes its row back; one that may have
   * half happened (a timeout, a rm that failed after the kill) keeps it `closing` for `reconcile`.
   */
  private async closeOne(closer: HcCloser, e: Eligible, at: Date, errors: string[]): Promise<boolean> {
    const again = await this.gitVerdict(e.worktree)
    if (again.reasons.length > 0) {
      this.failures.set(e.address, (this.failures.get(e.address) ?? 0) + 1)
      errors.push(`reaper: ${e.id} is kept after all: ${again.reasons.join('; ')}`)
      return false
    }
    const row = rowOf({ ...e, proof: again.proof })
    try {
      await insertLog(this.deps.sql, [{ ...row, payload: { ...row.payload, state: 'closing' } }], at)
    } catch (error) {
      this.failures.set(e.address, (this.failures.get(e.address) ?? 0) + 1)
      errors.push(`reaper: ${e.id} was not closed, its log row could not be written: ${message(error)}`)
      return false
    }
    try {
      await closer.close({ address: e.address, cwd: e.cwd })
    } catch (error) {
      this.failures.set(e.address, (this.failures.get(e.address) ?? 0) + 1)
      errors.push(`reaper: ${e.id} was not closed: ${message(error)}`)
      if (error instanceof NotClosed) await this.settle(row, 'untouched', errors)
      return false
    }
    this.failures.delete(e.address)
    await this.settle(row, 'closed', errors)
    return true
  }

  /** Rows left `closing` by a crash or an uncertain failure: a terminal that is gone is closed, one that still runs was never touched. */
  private async reconcile(closer: HcCloser, errors: string[], spent: () => boolean): Promise<void> {
    let pending: Awaited<ReturnType<typeof closingReaped>>
    try {
      pending = await closingReaped(this.deps.sql)
    } catch (error) {
      errors.push(`reaper: unsettled closes could not be read: ${message(error)}`)
      return
    }
    for (const row of pending) {
      if (spent()) return
      try {
        const state = await closer.finish(row.address)
        await this.settle(row, state === 'gone' ? 'closed' : 'untouched', errors)
      } catch (error) {
        errors.push(`reaper: the close of ${row.address} is still unsettled: ${message(error)}`)
      }
    }
  }

  private async settle(
    key: { subject: string; fingerprint: string },
    outcome: 'closed' | 'untouched',
    errors: string[],
  ): Promise<void> {
    try {
      await settleReaped(this.deps.sql, key, outcome)
    } catch (error) {
      errors.push(`reaper: the log row of ${key.subject} could not be settled: ${message(error)}`)
    }
  }
}

const whatOf = (e: Eligible, dry = false): string =>
  `${dry ? 'Would close' : 'Closed'} ${e.id}, a finished worker session in ${e.repo}/${e.name}`
const whyOf = (dry = false): string =>
  `Idle for ${REAPER_IDLE_MS / 3_600_000} h or more, its worktree clean, its branch merged, and its parent waits on nothing of it. ${dry ? 'FACTORY_REAPER=dry: nothing was closed.' : 'Not undoable: the terminal is gone (the worktree stays).'}`
const evidenceOf = (e: Eligible): string => `idle since ${e.idleSince}; ${e.proof}; ${e.parent}`

/** The deterministic key: the worktree, and this incarnation of the terminal (its address and the idle time it was closed for). */
const rowOf = (e: Eligible): NewLogRow => ({
  kind: 'reaped',
  subject: e.worktree,
  fingerprint: `${e.address}:${e.idleSince}`,
  what: whatOf(e),
  why: whyOf(),
  evidence: evidenceOf(e),
  payload: {
    session: e.id,
    repo: e.main,
    worktree: e.worktree,
    address: e.address,
    idleSince: e.idleSince,
    proof: e.proof,
    parent: e.parent,
  },
})
