import { basename } from 'node:path'
import { defaultManifest, type IssueState, type RoleTable, type Tier, type Effort } from '@software-factory/contract'
import type { SQL } from 'bun'
import type { Clock } from '../clock.ts'
import { lockCapacity } from '../capacity.ts'
import { projectOfPath, releaseClaim } from '../projects/claims.ts'
import { getProject } from '../projects/store.ts'
import { recordPrompt } from '../prompts.ts'
import { RepoRefused, resolveRepo } from '../repos.ts'
import { MAX_PROMPT_CHARS } from '../schemas.ts'
import { RUNNER_SESSION } from '../sessions.ts'
import { createSpawn, getSpawn, IssueClosed } from '../spawns.ts'
import { type BriefInput, buildBrief } from './brief.ts'
import { leadLevel } from './classify.ts'
import { type Effect, type EffectPorts, Waiting } from './effects.ts'
import { enqueue } from './inbox.ts'
import { worktreeFor } from './leadtree.ts'
import { briefPromptId, leadBranch, leadKey, notePromptId, regressionPromptId } from './names.ts'

export interface LeadDeps {
  sql: SQL
  clock: Clock
  roles: RoleTable
  repoRoots: readonly string[]
}

interface LeadIssue {
  id: number
  state: IssueState
  repo: string
  title: string
  source: string
  facts: unknown
  kind: string | null
  class: string | null
  lead_tier: Tier | null
  lead_effort: Effort | null
}

const attemptOf = (effect: Effect): number => {
  const attempt = Number(effect.payload?.attempt)
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`${effect.key} names no attempt`)
  return attempt
}

/**
 * `start_lead`: a worktree of the Issue's repo (made off the tick, see `leadtree.ts`), the brief, and a spawn for
 * role `lead` keyed `lead-<issue>-<attempt>`. The spawn is the lead's first and only prompt (the brief is its argument, never
 * typed a second time) and waits on the Issue's claim like any hold. A spawn that exists already is the attach: nothing more is
 * done, so a replay or a second admission finds the first.
 */
async function startLead(deps: LeadDeps, effect: Effect): Promise<void> {
  const { sql, clock, roles } = deps
  const attempt = attemptOf(effect)
  const key = leadKey(effect.issueId, attempt)
  const existing = await getSpawn(sql, key, clock.now())
  if (existing) {
    // The attach is to the lead of this Issue; a spawn of that name made by anyone else is not it.
    const [owner] = await sql`SELECT issue_id FROM factory.spawns WHERE key = ${key}`
    if (owner?.issue_id !== effect.issueId) throw new Error(`spawn ${key} exists and is not this Issue's lead`)
    return
  }

  const [issue]: LeadIssue[] = await sql`
    SELECT id, state, repo, title, source, facts, kind, class, lead_tier, lead_effort FROM factory.issues WHERE id = ${effect.issueId}`
  // An Issue that closed meanwhile has no use for a lead.
  if (!issue || issue.state === 'closed') return
  const role = roles.get('lead')
  if (!role) throw new Error('the role table has no `lead`')

  // Against the role table as it is now, not as it was at Classify: a table lowered since is the ceiling, and the floor holds.
  const level = leadLevel(
    { tier: issue.lead_tier ?? role.tier, effort: issue.lead_effort ?? role.effort },
    roles,
    issue,
  )
  const branch = leadBranch(issue.id, attempt)
  // The worktree is made off the tick, by `WorktreeMaker`: this asks for it, and waits until it is there.
  const tree = await worktreeFor(sql, issue.id, attempt, clock.now())
  if (tree.status === 'failed') {
    await enqueue(sql, {
      issueId: issue.id,
      key: `lead_gone:${effect.key}`,
      kind: 'lead_gone',
      at: clock.now(),
      payload: {
        attempt,
        detail: `the worktree could not be made after ${tree.tries} tries: ${tree.error ?? 'unknown'}`,
      },
    })
    // No spawn will ever exist for the failed-spawn sweep to release the claim by: an abandoned attempt gives its place back.
    await sql.begin(async (tx) => {
      await lockCapacity(tx)
      await releaseClaim(tx, issue.id)
    })
    return
  }
  if (tree.status !== 'made' || !tree.path) throw new Waiting(`the worktree of ${key} is being made`)
  // The worktree took its time: what the Issue was when this began says nothing now. A stop not handled yet is waited for, not assumed:
  // one filed for an earlier attempt is refused, and this lead still starts.
  const [now_]: { state: IssueState; stopping: boolean }[] = await sql`
    SELECT i.state, EXISTS (
      SELECT 1 FROM factory.issue_inbox b WHERE b.issue_id = i.id AND b.handled_at IS NULL AND b.kind IN ('drop', 'stop')
    ) AS stopping
    FROM factory.issues i WHERE i.id = ${issue.id}`
  if (!now_ || now_.state === 'closed') return
  if (now_.stopping) throw new Waiting(`a stop of Issue ${issue.id} is not handled yet`)
  // The worktree is a spawn's repo, so it is inside the allowed roots like any other.
  const path = await resolveRepo(tree.path, deps.repoRoots).catch((error: unknown) => {
    throw error instanceof RepoRefused
      ? new Error(`the worktree is outside the allowed roots: ${error.message}`)
      : error
  })

  const owner = await projectOfPath(sql, issue.repo)
  const project = owner ? await getProject(sql, owner.name) : undefined
  const name = owner?.name ?? basename(issue.repo)
  const notes = await unsentNotes(sql, issue.id)
  const prompt = buildBrief({
    issue,
    attempt,
    previous: await previousAttempt(sql, issue.id, attempt),
    news: await newsOfPreviousAttempt(sql, issue.id, attempt),
    worktree: { path, branch },
    project: {
      name,
      manifest: project?.manifest ?? defaultManifest(basename(issue.repo)),
      makeTargets: project?.makeTargets ?? null,
    },
    notes: notes.shown.map((note) => note.text),
    notesMore: notes.more,
  })
  const now = clock.now()
  try {
    await createSpawn(
      sql,
      {
        key,
        repo: path,
        space: issue.repo,
        prompt,
        role: 'lead',
        tier: level.tier,
        effort: level.effort,
        issueId: issue.id,
        // Recorded with the spawn, before it can type the brief: a create that fails leaves no prompt behind, and a retry records
        // its own text. The brief is the spawn's argument, so it is `delivered` from the start: the prompt loop never types it
        // again, and the send-back reads it to tell the lead's own first turn from one the owner typed.
        withSpawn: async (tx) => {
          await tx`
            INSERT INTO factory.prompts (id, session, source, via, text, status, created_at, next_at, sent_count)
            VALUES (${briefPromptId(issue.id, attempt)}, ${key}, 'brief', 'type', ${prompt}, 'delivered', ${now}, ${now}, 1)
            ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text`
          // What the brief carries is delivered with it: a later `note_lead` for the same call finds its prompt and types nothing.
          for (const note of notes.shown) {
            await tx`
              INSERT INTO factory.prompts (id, session, source, via, text, status, created_at, next_at, sent_count)
              VALUES (${notePromptId(issue.id, note.call)}, ${key}, 'note', 'type', ${note.text}, 'delivered', ${now}, ${now}, 1)
              ON CONFLICT (id) DO UPDATE
                SET session = EXCLUDED.session, text = EXCLUDED.text, status = 'delivered', sent_count = 1, error = NULL,
                    failed_at = NULL, claimed_at = NULL, created_at = EXCLUDED.created_at, sent_at = EXCLUDED.created_at,
                    delivered_at = EXCLUDED.created_at
                WHERE factory.prompts.status NOT IN ('sent', 'delivered', 'typing')
                  OR NOT EXISTS (SELECT 1 FROM factory.sessions s WHERE s.id = factory.prompts.session)`
          }
        },
      },
      now,
    )
  } catch (error) {
    if (error instanceof IssueClosed) return
    throw error
  }
}

/**
 * The owner's notes (`factory issue note`) that no lead was typed: applied, and without a prompt under their call id that reached a
 * session that exists (typed or delivered). A note a brief or a lead took is therefore never carried twice, and one that reached nobody
 * (a lead that never started, a prompt still pending for a dead one, the notes a brief had no room for) comes again. Oldest first, a few;
 * the rest are counted.
 */
async function unsentNotes(
  sql: SQL,
  issueId: number,
): Promise<{ shown: { call: string; text: string }[]; more: number }> {
  const rows: { call: string; text: string; total: string }[] = await sql`
    SELECT b.payload->>'call' AS call, b.payload->>'text' AS text, count(*) OVER () AS total FROM factory.issue_inbox b
    WHERE b.issue_id = ${issueId} AND b.kind = 'note' AND b.result = 'applied'
      AND b.payload->>'call' IS NOT NULL AND b.payload->>'text' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM factory.prompts p JOIN factory.sessions s ON s.id = p.session
        WHERE p.id = 'issue:' || b.issue_id || ':note:' || (b.payload->>'call') AND p.status IN ('sent', 'delivered'))
    ORDER BY b.at, b.id LIMIT ${MAX_BRIEF_NOTES}`
  // The brief is one argument of one process: what does not fit the budget stays unsent and comes again.
  let bytes = 0
  const shown: { call: string; text: string }[] = []
  for (const { call, text } of rows) {
    bytes += Buffer.byteLength(text)
    if (shown.length > 0 && bytes > MAX_BRIEF_NOTE_BYTES) break
    shown.push({ call, text })
  }
  return { shown, more: Math.max(0, Number(rows[0]?.total ?? 0) - shown.length) }
}

/** The attempt before this one, if its finalize kept its branch (work not on the base, or uncommitted changes) and said where. */
async function previousAttempt(sql: SQL, issueId: number, attempt: number): Promise<BriefInput['previous']> {
  if (attempt < 2) return undefined
  const [kept]: { path: string | null; why: string | null }[] = await sql`
    SELECT payload->>'path' AS path, payload->>'kept' AS why FROM factory.issue_events
    WHERE key = ${`worktree_kept:${issueId}:${attempt - 1}`}`
  if (!kept?.why) return undefined
  return { attempt: attempt - 1, branch: leadBranch(issueId, attempt - 1), worktree: kept.path, why: kept.why }
}

/** The news a note carried to a lead that was gone, as the next attempt's brief shows it. */
const MAX_NEWS_CHARS = 4_000

/** What a note brought to the attempt before this one, which had no lead left to hear it (the `news` of its `lead_gone`). */
async function newsOfPreviousAttempt(sql: SQL, issueId: number, attempt: number): Promise<string | undefined> {
  if (attempt < 2) return undefined
  const [row]: { news: string }[] = await sql`
    SELECT payload->>'news' AS news FROM factory.issue_events
    WHERE issue_id = ${issueId} AND kind = 'lead_gone' AND payload->>'attempt' = ${String(attempt - 1)}
      AND payload->>'news' IS NOT NULL
    ORDER BY id DESC LIMIT 1`
  return row?.news
}

const MAX_BRIEF_NOTES = 20
/** A note is up to 4,000 characters, which can be 12 KB: twenty would crowd a process argument. */
const MAX_BRIEF_NOTE_BYTES = 24_000

const clip = (text: string): string => (text.length > MAX_PROMPT_CHARS ? text.slice(0, MAX_PROMPT_CHARS) : text)

/** What the lead is told for the event that woke or reached it. Never starts with `-`. */
export function noteText(issueId: number, payload: Effect['payload']): string {
  const field = (name: string): string | null => {
    const value = payload?.[name]
    return typeof value === 'string' && value ? value : null
  }
  const head = `Factory, Issue ${issueId}:`
  switch (payload?.cause) {
    case 'answer': {
      const who = field('who')
      return clip(
        `${head} your question was answered${who && who !== 'owner' ? ` (${who})` : ''}: ${field('answer') ?? 'see the owner'}`,
      )
    }
    case 'wake':
      return `${head} your wait is over. Carry on from where you stopped.`
    case 'regression': {
      // One line: what the checks printed is data, and JSON escapes whatever it holds.
      const checks = payload?.checks
      const data = checks === undefined ? '' : ` The checks, as data: ${JSON.stringify(checks)}.`
      return clip(
        `${head} a regression was reported after your ship${field('summary') ? `: ${field('summary')}` : ''}.${data} Fix forward, then report again.`,
      )
    }
    case 'note':
      return clip(`${head} ${field('text') ?? 'a note from the owner'}`)
    default:
      return `${head} there is news; look at \`factory issue show ${issueId}\`.`
  }
}

/**
 * `note_lead`: the news typed into the lead's session through the prompt loop, under the effect's key. A lead that has not become a
 * session yet is tried again next pass; one whose spawn failed or ended parks the Issue (`lead_gone`).
 */
async function noteLead(deps: LeadDeps, effect: Effect): Promise<void> {
  const { sql, clock } = deps
  const key = leadKey(effect.issueId, attemptOf(effect))
  const spawn = await getSpawn(sql, key, clock.now())
  if (spawn?.status === 'failed' || spawn?.status === 'ended') {
    // Nobody is left to tell. The Issue would sit `working` with its claim held and no lead, unseen: it parks, with a line for the owner.
    // Only an Issue that is working parks: one that waits or watches keeps its wait or hold, and the wake that ends it asks again.
    const [issue] = await sql`SELECT state FROM factory.issues WHERE id = ${effect.issueId}`
    if (issue?.state !== 'working') return
    const detail = `spawn ${key} ${spawn.status}${spawn.error ? `: ${spawn.error}` : ''}`
    await enqueue(sql, {
      issueId: effect.issueId,
      // One per effect, not per attempt: a lead_gone Issue woken with its spawn still gone parks again.
      key: `lead_gone:${effect.key}`,
      kind: 'lead_gone',
      at: clock.now(),
      // The news the note carried is not lost with the lead: the next attempt's brief shows it. An owner's note is not news here:
      // the brief's notes section (`unsentNotes`) carries it already.
      payload: {
        attempt: attemptOf(effect),
        detail,
        ...(effect.payload?.cause === 'note'
          ? {}
          : { news: noteText(effect.issueId, effect.payload).slice(0, MAX_NEWS_CHARS) }),
      },
    })
    return
  }
  const [session] = await sql`SELECT 1 FROM factory.sessions WHERE id = ${key}`
  if (!spawn || !session) {
    // No spawn at all on an Issue that is not working: its lead never started (the worktree failed and parked it) and nothing will. The
    // news waits in the timeline, and a note comes again in the next brief. Thrown for ever, it would hold every later effect of the Issue.
    if (!spawn) {
      const [issue] = await sql`SELECT state FROM factory.issues WHERE id = ${effect.issueId}`
      if (issue?.state !== 'working') return
    }
    throw new Error(`the lead ${key} is not running yet`)
  }
  // A regression is one note per hold, under the Issue's own prompt id; the rest go by the effect's key.
  const hold = effect.payload?.cause === 'regression' ? Number(effect.payload.hold) : Number.NaN
  const call = effect.payload?.cause === 'note' ? effect.payload.call : undefined
  const id = Number.isInteger(hold)
    ? regressionPromptId(effect.issueId, hold)
    : typeof call === 'string' && call
      ? notePromptId(effect.issueId, call)
      : effect.key
  await recordPrompt(
    sql,
    { id, session: key, source: 'note', text: noteText(effect.issueId, effect.payload) },
    clock.now(),
  )
}

/** How long a lead's session must have been dead, and the runner not restarted, before the sweep calls its spawn gone. */
export const LEAD_GONE_GRACE_MS = 10 * 60_000

/**
 * A working Issue whose lead is gone is found here, without waiting for a note to find it: `lead_gone`. Two kinds:
 * the lead's spawn failed, or it is `started` but reads as `ended` (`withEnded`: its session is dead, or its pane is no terminal
 * of the current core). An ended one counts only once it has been dead for `LEAD_GONE_GRACE_MS` (its last `session_ended` or
 * `pane_gone`, else the spawn's start) and never within that long after a `runner_restarted`: a core restart brings terminals back
 * through hc-resume, and a restart of the Issue would put a second lead beside a resumed one. One event per Issue revision, so a woken
 * Issue whose spawn is still gone files again. No `news`: no note is involved.
 */
export async function parkGoneLeads(sql: SQL, now: Date): Promise<void> {
  await sql`
    INSERT INTO factory.issue_inbox (issue_id, key, kind, at, payload)
    SELECT i.id, 'lead_gone:sweep:' || i.id || ':' || i.revision, 'lead_gone', ${now},
           jsonb_build_object('attempt', i.attempt, 'detail', 'spawn ' || s.key || ' failed' || COALESCE(': ' || s.error, ''))
    FROM factory.issues i JOIN factory.spawns s ON s.key = 'lead-' || i.id || '-' || i.attempt
    WHERE i.state = 'working' AND s.status = 'failed'
    ON CONFLICT (key) DO NOTHING`
  await parkEndedLeads(sql, now)
}

async function parkEndedLeads(sql: SQL, now: Date): Promise<void> {
  const cut = new Date(now.getTime() - LEAD_GONE_GRACE_MS)
  const [restart] = await sql`
    SELECT 1 FROM factory.events WHERE session = ${RUNNER_SESSION} AND kind = 'runner_restarted' AND at > ${cut} LIMIT 1`
  if (restart) return
  const candidates: { id: number; attempt: number; revision: number; since: Date }[] = await sql`
    SELECT i.id, i.attempt, i.revision,
           COALESCE((SELECT max(e.at) FROM factory.events e WHERE e.session = s.key AND e.kind IN ('session_ended', 'pane_gone')),
                    s.assigned_at, s.created_at) AS since
    FROM factory.issues i JOIN factory.spawns s ON s.key = 'lead-' || i.id || '-' || i.attempt
    WHERE i.state = 'working' AND s.status = 'started'`
  const old = candidates.filter((c) => c.since <= cut)
  if (old.length === 0) return
  const views = await Promise.all(old.map((c) => getSpawn(sql, leadKey(c.id, c.attempt), now)))
  for (const [i, c] of old.entries()) {
    if (views[i]?.status !== 'ended') continue
    await enqueue(sql, {
      issueId: c.id,
      key: `lead_gone:ended:${c.id}:${c.revision}`,
      kind: 'lead_gone',
      at: now,
      payload: { attempt: c.attempt, detail: `spawn ${leadKey(c.id, c.attempt)} ended` },
    })
  }
}

/** The lead's ports: it starts, and it hears. */
export function leadPorts(deps: LeadDeps): Pick<EffectPorts, 'start_lead' | 'note_lead'> {
  return {
    start_lead: (effect) => startLead(deps, effect),
    note_lead: (effect) => noteLead(deps, effect),
  }
}
