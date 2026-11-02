import { basename } from 'node:path'
import { defaultManifest, type IssueState, type RoleTable, type Tier, type Effort } from '@software-factory/contract'
import type { SQL } from 'bun'
import type { Clock } from '../clock.ts'
import { projectOfPath } from '../projects/claims.ts'
import { getProject } from '../projects/store.ts'
import { recordPrompt } from '../prompts.ts'
import { RepoRefused, resolveRepo } from '../repos.ts'
import { MAX_PROMPT_CHARS } from '../schemas.ts'
import { createSpawn, getSpawn, IssueClosed } from '../spawns.ts'
import { buildBrief } from './brief.ts'
import { leadLevel } from './classify.ts'
import type { Effect, EffectPorts } from './effects.ts'
import type { Worktrees } from './worktree.ts'

/** A lead's spawn, pane and session: one per attempt. */
export const leadKey = (issueId: number, attempt: number): string => `lead-${issueId}-${attempt}`
export const leadBranch = (issueId: number, attempt: number): string => `factory/${issueId}-${attempt}`
/** The first prompt of a lead, recorded under the id every prompt of the Issue's lead has. */
export const briefPromptId = (issueId: number, attempt: number): string => `issue:${issueId}:brief:${attempt}`

export interface LeadDeps {
  sql: SQL
  clock: Clock
  roles: RoleTable
  repoRoots: readonly string[]
  worktrees: Worktrees
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
 * `start_lead`: a worktree of the Issue's repo (outside any transaction, a port with its own timeouts), the brief, and a spawn for
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
  const made = await deps.worktrees.create({ repo: issue.repo, branch })
  // The worktree is a spawn's repo, so it is inside the allowed roots like any other.
  const path = await resolveRepo(made.path, deps.repoRoots).catch((error: unknown) => {
    throw error instanceof RepoRefused
      ? new Error(`the worktree is outside the allowed roots: ${error.message}`)
      : error
  })

  const owner = await projectOfPath(sql, issue.repo)
  const project = owner ? await getProject(sql, owner.name) : undefined
  const name = owner?.name ?? basename(issue.repo)
  const prompt = buildBrief({
    issue,
    attempt,
    worktree: { path, branch },
    project: {
      name,
      manifest: project?.manifest ?? defaultManifest(basename(issue.repo)),
      makeTargets: project?.makeTargets ?? null,
    },
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
        },
      },
      now,
    )
  } catch (error) {
    if (error instanceof IssueClosed) return
    throw error
  }
}

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
    case 'regression':
      return clip(
        `${head} a regression was reported after your ship${field('summary') ? `: ${field('summary')}` : ''}. Fix forward, then report again.`,
      )
    case 'note':
      return clip(`${head} ${field('text') ?? 'a note from the owner'}`)
    default:
      return `${head} there is news; look at \`factory issue show ${issueId}\`.`
  }
}

/**
 * `note_lead`: the news typed into the lead's session through the prompt loop, under the effect's key. A lead that has not become a
 * session yet is tried again next pass; one whose spawn is gone has nobody to tell.
 */
async function noteLead(deps: LeadDeps, effect: Effect): Promise<void> {
  const { sql, clock } = deps
  const key = leadKey(effect.issueId, attemptOf(effect))
  const spawn = await getSpawn(sql, key, clock.now())
  if (spawn?.status === 'failed' || spawn?.status === 'ended') return
  const [session] = await sql`SELECT 1 FROM factory.sessions WHERE id = ${key}`
  if (!spawn || !session) throw new Error(`the lead ${key} is not running yet`)
  await recordPrompt(
    sql,
    { id: effect.key, session: key, source: 'note', text: noteText(effect.issueId, effect.payload) },
    clock.now(),
  )
}

/** The lead's ports: it starts, and it hears. */
export function leadPorts(deps: LeadDeps): Pick<EffectPorts, 'start_lead' | 'note_lead'> {
  return {
    start_lead: (effect) => startLead(deps, effect),
    note_lead: (effect) => noteLead(deps, effect),
  }
}
