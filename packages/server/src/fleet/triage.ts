import type { ActIntent, Fleet, FleetAsk, FleetPlan, FleetRepo, FleetSuggestion } from '@software-factory/contract'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SQL } from 'bun'
import { getSpawn, type SpawnView } from '../spawns.ts'
import { STALE_ASK_MS } from './model.ts'
import { SAFE_PATH, type Probes } from './probes.ts'
import type { QueueRequest } from './sources.ts'
import { insertLog, type LogRow, type NewLogRow, readActs, readLog } from './triage-store.ts'

/**
 * The triage (docs/design.md §11 "The fleet view", Wave 3): a tier, a suggestion with evidence and the offered actions for every ask,
 * and the bookkeeping that needs no one. By deterministic rules only. The digest's text (`short`, a reply ask's `kind`) is shown, never
 * read to decide a tier, and nothing here moves an ask into `automatic`: that tier is what `automaticSteps` provably is, logged and
 * undoable. Nothing here runs a request's command or denies an ask; the probes are read-only and bounded, and run in the fleet build
 * (off the tick, in no transaction).
 */

/** A queue request this old is stale: denied, never run with its command. */
export const OLD_REQUEST_MS = 7 * 86_400_000
/** A note that was not delivered and was not looked at for this long has expired. */
export const NOTE_EXPIRES_MS = STALE_ASK_MS
/** Probes made by one build: oldest requests first; the rest wait for the next. */
export const MAX_PROBES_PER_BUILD = 40

const DAY_MS = 86_400_000
const LABEL: Record<ActIntent, string> = {
  resolve: 'Mark done',
  deny: 'Deny',
  later: 'Later',
  archive_plan: 'Archive plan',
  hand_off: 'Hand off',
}
const action = (intent: ActIntent) => ({ label: LABEL[intent], intent })

type Model = Omit<Fleet, 'fingerprint'>

// ---------------------------------------------------------------------------------------------------------------------
// The business classes: spend, irreversible data loss, a person or a machine the owner has to be at, other people.

const CLASSES: readonly [string, RegExp][] = [
  [
    'spend',
    /\b(?:pay(?:ment|ments)?|invoices?|billing|purchase[sd]?|buy|subscri(?:be|ption|ptions)|upgrade (?:the |your )?(?:plan|tier)|credit card|refunds?|charged?|top[- ]?up|eur|usd)\b|[€$]\s?\d|\d\s?[€$]/i,
  ],
  [
    'irreversible data loss',
    /\b(?:rm\s+-\w*[rf]\w*|drop\s+(?:table|database|schema)|truncate|wipe|purge|destroy|force[- ]push|push\s+(?:--force|-f)|reset\s+--hard|irreversibl[ey]|permanently|delete (?:the |all )?(?:database|backups?|volumes?|buckets?|repos?|branch(?:es)?))\b/i,
  ],
  [
    'needs the owner at a machine',
    /\b(?:touch ?id|biometric|face ?id|passcode|password|sudo|1password|keychain|2fa|otp|captcha|in person|physical(?:ly)?|at the (?:machine|keyboard))\b/i,
  ],
  [
    'other people',
    /\b(?:e-?mail|send (?:a |the )?(?:message|mail|report|invoice)|reply to|post (?:to|on)|slack|tweet|publish|announce|notify (?:the )?(?:team|customers?|clients?)|customers?|clients?|colleagues?|share with|invite)\b/i,
  ],
]

/** The business class a text falls into, or null. Conservative on purpose: a false hit costs a click, a miss costs a wrong suggestion. */
export function businessClass(text: string): string | null {
  return CLASSES.find(([, pattern]) => pattern.test(text))?.[0] ?? null
}

// ---------------------------------------------------------------------------------------------------------------------
// What a queue request names: paths and apps, parsed from its command, never run.

export interface Target {
  machine: string
  path: string
  /** `absent`: a removal is done once the path is gone; `present`: a creation is done once it exists */
  want: 'absent' | 'present'
}

const MAX_TARGETS = 6
const HARMLESS = new Set(['cd', 'echo', 'true', 'sudo', 'test', ':'])
const REMOVES = new Set(['rm', 'rmdir', 'trash'])
const CREATES = new Set(['mkdir', 'touch'])

function machineOf(text: string, machines: readonly string[]): string | undefined {
  const lower = text.toLowerCase()
  return machines.find((m) => new RegExp(`\\b${m.replace(/[^\w]/g, '\\$&')}\\b`).test(lower))
}

/**
 * The paths a request names, with what would make each one done, for a command made only of `rm`/`rmdir`/`trash`, `mkdir`/`touch` and
 * harmless words. Anything else in it (an install, a pull, a pipe, a glob, a variable, a relative path) means the request does more than
 * a probe can see: no targets. A request with no command is read for `/Applications/<name>.app` or `<Name>.app` and a removal or
 * install word. The machine is the one the text names, else the queue's own (`queueMachine`, the machine its commands run on).
 */
export function targetsOf(
  request: { text: string; cmd?: string | null },
  machines: readonly string[],
  queueMachine: string | undefined,
): Target[] {
  const machine = machineOf(`${request.text}\n${request.cmd ?? ''}`, machines) ?? queueMachine
  if (!machine) return []
  const targets = new Map<string, Target>()
  const add = (path: string, want: Target['want']): boolean => {
    if (!SAFE_PATH.test(path) || path.includes('..')) return false
    targets.set(`${want}\0${path}`, { machine, path, want })
    return true
  }

  if (request.cmd) {
    for (const segment of request.cmd.split(/&&|\|\||;|\n/)) {
      const words = segment.trim().split(/\s+/).filter(Boolean)
      let at = 0
      while (words[at] === 'sudo') at++
      const verb = words[at]
      if (!verb) continue
      if (REMOVES.has(verb) || CREATES.has(verb)) {
        const args = words.slice(at + 1).filter((w) => !w.startsWith('-'))
        if (args.length === 0) return []
        for (const arg of args) if (!add(arg, REMOVES.has(verb) ? 'absent' : 'present')) return []
      } else if (!HARMLESS.has(verb)) return []
    }
    return targets.size > 0 && targets.size <= MAX_TARGETS ? [...targets.values()] : []
  }

  const removal = /\b(?:remove|uninstall|delete|trash)\b/i.test(request.text)
  const creation = !removal && /\binstall\b/i.test(request.text)
  if (!removal && !creation) return []
  const apps = new Set<string>()
  for (const m of request.text.matchAll(/\/Applications\/([\w .-]+?)\.app\b/g)) if (m[1]) apps.add(m[1])
  for (const m of request.text.matchAll(/(?<![\w/.-])([A-Za-z][\w-]*)\.app\b/g)) if (m[1]) apps.add(m[1])
  for (const name of apps) if (!add(`/Applications/${name}.app`, removal ? 'absent' : 'present')) return []
  return targets.size > 0 && targets.size <= MAX_TARGETS ? [...targets.values()] : []
}

/** `Deploy gate [<repo>] deploy of origin/main <sha> FAILED`: the repo and the commit the gate was about. */
export function deployGateOf(text: string): { repo: string; sha: string } | undefined {
  const found = /^Deploy gate \[([\w.-]+)\].*?\b([0-9a-f]{7,40})\b.*\bFAILED\b/is.exec(text)
  return found?.[1] && found[2] ? { repo: found[1], sha: found[2] } : undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// Automatic: bookkeeping, logged and undoable.

const days = (ms: number) => Math.floor(ms / DAY_MS)

/** `factory:<subject>:<hash>` → the subject part; a line with no subject of its own (`line`) supersedes nothing. */
function supersessionKey(ask: FleetAsk): string | undefined {
  if (ask.source === 'factory') {
    const subject = ask.id.slice(0, ask.id.lastIndexOf(':'))
    return subject === 'factory:line' ? undefined : subject
  }
  if (ask.source === 'queue') return `queue\0${ask.text.toLowerCase().replace(/\s+/g, ' ').trim()}`
  return undefined
}

/**
 * What the triage may do without asking: a stale plan marked, an ask folded under the newer one about the same subject, an expired
 * note dismissed. Each is a row (what, why, evidence) the owner can undo; none runs a command or denies anything.
 */
export function automaticSteps(model: Model, now: Date): NewLogRow[] {
  const rows: NewLogRow[] = []
  for (const repo of model.repos) {
    for (const plan of [repo.plan, ...repo.morePlans]) {
      if (plan?.state !== 'stale') continue
      const wave = plan.waves.find((w) => w.status === 'active')
      rows.push({
        kind: 'plan_stale',
        subject: plan.path,
        fingerprint: plan.sha,
        what: `Marked the plan "${plan.title}" stale`,
        why: 'an active wave in a plan nobody has touched for 3 days',
        evidence: `${wave ? `Wave ${wave.n} is active; ` : ''}the plan file's last commit is ${plan.lastTouched ?? 'unknown'}`,
        payload: { repo: repo.name },
      })
    }
  }

  const groups = new Map<string, FleetAsk[]>()
  for (const ask of model.asks) {
    const key = supersessionKey(ask)
    if (key) groups.set(key, [...(groups.get(key) ?? []), ask])
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const newest = [...group].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id))[0]
    if (!newest) continue
    for (const older of group) {
      if (older.id === newest.id) continue
      rows.push({
        kind: 'fold',
        subject: older.id,
        fingerprint: newest.id,
        what: `Folded ${older.id} under ${newest.id}`,
        why: 'a newer ask about the same subject supersedes it',
        evidence: `${older.id} was raised ${older.at}, ${newest.id} ${newest.at}; same subject`,
        payload: { askAt: older.at },
      })
    }
  }

  for (const ask of model.asks) {
    if (ask.source !== 'factory' || !ask.id.startsWith('factory:note:')) continue
    const age = now.getTime() - Date.parse(ask.at)
    if (age < NOTE_EXPIRES_MS) continue
    rows.push({
      kind: 'dismiss_note',
      subject: ask.id,
      fingerprint: ask.id,
      what: `Dismissed the expired note ${ask.id}`,
      why: 'a note that was not delivered and was not looked at for 24 hours has expired',
      evidence: `raised ${ask.at}, ${days(age)} days ago`,
      payload: { askAt: ask.at },
    })
  }
  return rows
}

/** The model with the active steps applied: folded and dismissed asks leave the list, an undone stale mark reads `planned`. */
export function applyAutomatic(model: Model, log: readonly LogRow[]): Model {
  const hidden = new Set<string>()
  const foldedUnder = new Map<string, string[]>()
  const present = new Set(model.asks.map((a) => a.id))
  const unmarked = new Set<string>()
  for (const row of log) {
    if (row.kind === 'plan_stale') {
      if (row.undoneAt) unmarked.add(`${row.subject}\0${row.fingerprint}`)
      continue
    }
    if (row.undoneAt) continue
    if (row.kind === 'fold') {
      // A fold holds while the ask that supersedes it is listed; with that gone (resolved, snoozed) the older one is back.
      if (!present.has(row.subject) || !present.has(row.fingerprint)) continue
      hidden.add(row.subject)
      foldedUnder.set(row.fingerprint, [...(foldedUnder.get(row.fingerprint) ?? []), row.subject])
    } else if (present.has(row.subject)) hidden.add(row.subject)
  }
  const plan = (p: FleetPlan): FleetPlan =>
    p.state === 'stale' && unmarked.has(`${p.path}\0${p.sha}`) ? { ...p, state: 'planned' } : p
  return {
    ...model,
    repos: model.repos.map((r) => ({
      ...r,
      plan: r.plan ? plan(r.plan) : null,
      morePlans: r.morePlans.map(plan),
    })),
    asks: model.asks
      .filter((a) => !hidden.has(a.id))
      .map((a) =>
        foldedUnder.has(a.id) ? { ...a, folded: [...a.folded, ...(foldedUnder.get(a.id) ?? [])].sort() } : a,
      ),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Findings: what the probes saw. Gathered first (async, bounded), decided after (pure).

export interface Finding {
  /** the request is already satisfied: every named path is as the command would leave it */
  satisfied?: string
  /** the repo's default branch has moved past the commit a failed deploy gate was about */
  newerDeploy?: string
}

interface FindingsInput {
  asks: readonly FleetAsk[]
  queue: ReadonlyMap<string, QueueRequest>
  repos: readonly FleetRepo[]
  now: Date
  probes: Probes
  machines: readonly string[]
  queueMachine: string | undefined
  /** real paths of the repo roots: a gate names a repo that may have no plan and no session, so it is not in the model */
  roots: readonly string[]
}

/** The repo a deploy gate names: one of the model's by name, else a git directory of that name directly under a root. */
async function repoNamed(name: string, input: Pick<FindingsInput, 'repos' | 'roots'>): Promise<string | undefined> {
  const known = input.repos.find((r) => r.name === name)
  if (known) return known.space
  for (const root of input.roots) {
    const path = join(root, name)
    if (
      await stat(join(path, '.git')).then(
        () => true,
        () => false,
      )
    )
      return path
  }
  return undefined
}

export async function gatherFindings(input: FindingsInput): Promise<Map<string, Finding>> {
  const { now, probes } = input
  const out = new Map<string, Finding>()
  let budget = MAX_PROBES_PER_BUILD
  for (const ask of input.asks) {
    if (ask.source !== 'queue' || budget <= 0) continue
    const request = input.queue.get(ask.id.slice('queue:'.length))
    if (!request) continue
    const found: Finding = {}

    const gate = deployGateOf(request.text)
    if (gate) {
      const repo = await repoNamed(gate.repo, input)
      if (repo) {
        budget--
        const newer = await probes.newerDeploy(repo, gate.sha)
        if (newer)
          found.newerDeploy = `${gate.repo}'s default branch is at ${newer.head.slice(0, 12)}, past the failed ${gate.sha.slice(0, 12)}`
      }
    }

    if (now.getTime() - Date.parse(ask.at) >= OLD_REQUEST_MS) {
      const targets = targetsOf(request, input.machines, input.queueMachine)
      if (targets.length > 0 && targets.length <= budget) {
        const seen: string[] = []
        let all = true
        for (const t of targets) {
          budget--
          const exists = await probes.exists(t.machine, t.path)
          if (exists === undefined || exists !== (t.want === 'present')) {
            all = false
            break
          }
          seen.push(`${t.path} is ${exists ? 'present' : 'absent'} on ${t.machine}`)
        }
        if (all) found.satisfied = `${seen.join('; ')} (probed ${now.toISOString()})`
      }
    }
    if (found.satisfied || found.newerDeploy) out.set(ask.id, found)
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// Decide: tier, suggestion, actions. Pure.

export interface Triaged {
  tier: FleetAsk['tier']
  suggestion: FleetSuggestion | null
  actions: FleetAsk['actions']
}

interface DecideInput {
  ask: FleetAsk
  request: QueueRequest | undefined
  finding: Finding | undefined
  repos: readonly FleetRepo[]
  now: Date
}

const suggest = (verb: ActIntent, why: string, evidence: string, confidence: number): FleetSuggestion => ({
  verb,
  why,
  evidence,
  confidence,
})

export function decide({ ask, request, finding, repos, now }: DecideInput): Triaged {
  const later = action('later')
  const yours = (...extra: ActIntent[]): Triaged => ({
    tier: 'yours',
    suggestion: null,
    actions: [...extra, 'later' as const].map(action),
  })
  const repo = repos.find((r) => r.space === ask.repo)
  const text = `${ask.text}\n${request?.cmd ?? ''}`
  const age = now.getTime() - Date.parse(ask.at)

  switch (ask.source) {
    case 'queue': {
      const deny = action('deny')
      if (finding?.satisfied) {
        return {
          tier: 'one_click',
          suggestion: suggest(
            'resolve',
            'what the request asks for is already done; marking it done records that and runs nothing',
            finding.satisfied,
            0.9,
          ),
          actions: [action('resolve'), deny, later],
        }
      }
      if (finding?.newerDeploy) {
        return {
          tier: 'one_click',
          suggestion: suggest(
            'deny',
            'a newer deploy of the same repo exists; a failed gate for an older commit is moot, and a request is denied, never run late',
            finding.newerDeploy,
            0.85,
          ),
          actions: [deny, later],
        }
      }
      if (businessClass(text)) return yours('deny')
      if (age >= OLD_REQUEST_MS) {
        return {
          tier: 'one_click',
          suggestion: suggest(
            'deny',
            'an old request is denied, never run with its stale command',
            `asked ${ask.at}, ${days(age)} days ago (the queue denies a request older than ${days(OLD_REQUEST_MS)} days)`,
            0.7,
          ),
          actions: [deny, later],
        }
      }
      return yours('deny')
    }
    case 'decision':
      return yours('deny')
    case 'handoff':
      return {
        tier: 'one_click',
        suggestion: suggest(
          'resolve',
          'the worker a hand-off started has ended; looking at its result is the only thing left',
          ask.text,
          0.6,
        ),
        actions: [action('resolve'), later],
      }
    case 'factory': {
      if (ask.kind === 'blocker' && repo && !repo.visible && !businessClass(text)) {
        return { tier: 'hand_off', suggestion: null, actions: [action('hand_off'), later] }
      }
      return yours()
    }
    case 'reply':
    case 'wait': {
      // Only a session that has finished its plan and asks what is next: the plan is the evidence, and the model's text is not read for it.
      const plan = [repo?.plan, ...(repo?.morePlans ?? [])].find((p) => p && p.path === ask.plan)
      if (plan?.state === 'done' && repo && !repo.visible && !businessClass(ask.text) && ask.kind !== 'blocker') {
        return {
          tier: 'one_click',
          suggestion: suggest(
            'archive_plan',
            'every wave of the session’s plan is done; a finished plan is archived with one commit',
            `${plan.waves.length} of ${plan.waves.length} waves done in ${plan.path.slice(repo.space.length + 1)}, last touched ${plan.lastTouched ?? 'unknown'}`,
            0.9,
          ),
          actions: [action('archive_plan'), later],
        }
      }
      return yours()
    }
    default:
      return yours()
  }
}

// ---------------------------------------------------------------------------------------------------------------------

/** The asks of hand-offs whose worker has ended: the result of work an ask started, back as a new ask. */
function handoffAsks(
  handoffs: readonly { ask: string; spawn: SpawnView }[],
  firstSeen: ReadonlyMap<string, string>,
  now: Date,
): FleetAsk[] {
  const asks: FleetAsk[] = []
  for (const h of handoffs) {
    const { spawn } = h
    if (spawn.status !== 'ended') continue
    const id = `handoff:${spawn.key}`
    asks.push({
      id,
      kind: 'note',
      repo: spawn.repo,
      session: null,
      plan: null,
      short: null,
      text: `The worker of the hand-off for ${h.ask} (spawn ${spawn.key}) has ended; its result is in ${spawn.repo}: its last message, or its commit or pull request.`,
      source: 'handoff',
      at: firstSeen.get(id) ?? now.toISOString(),
      tier: 'one_click',
      suggestion: null,
      actions: [],
      folded: [],
    })
  }
  return asks
}

export interface TriageDeps {
  sql: SQL
  probes: Probes
  /** the machines a probe may look at, as configured (`FACTORY_PROBE_HOSTS` names) */
  machines: readonly string[]
  /** the machine a queue request's command runs on (the owner's laptop): paths in it are probed there, or not at all */
  queueMachine?: string
}

export class Triage {
  constructor(private readonly deps: TriageDeps) {}

  /**
   * The model with the triage on it. Reads the owner's acts and the log, writes the new automatic decisions (short statements, no
   * port inside), probes the stale queue requests, then decides every ask. `timed` is every ask before anything was hidden: the
   * builder keeps the first-seen times of those, so an ask that comes back has the time it always had.
   */
  async apply(input: {
    model: Model
    now: Date
    queue: readonly QueueRequest[]
    firstSeen: ReadonlyMap<string, string>
    roots: readonly string[]
  }): Promise<{ model: Model; timed: FleetAsk[] }> {
    const { sql, probes } = this.deps
    const { now } = input
    const acts = await readActs(sql, now)
    // A hand-off's worker is no longer in `factory status` once it has started: the spawn is read itself, the ended ones become asks.
    const handoffs: { ask: string; spawn: SpawnView }[] = []
    for (const h of acts.handoffs) {
      if (acts.closed.has(`handoff:${h.spawn}`)) continue
      const spawn = await getSpawn(sql, h.spawn, now)
      if (spawn) handoffs.push({ ask: h.ask, spawn })
    }
    const withHandoffs: Model = {
      ...input.model,
      asks: [...input.model.asks, ...handoffAsks(handoffs, input.firstSeen, now)],
    }
    const timed = withHandoffs.asks
    // What the owner closed or snoozed is not listed; the automatic steps are decided on what is.
    const open: Model = {
      ...withHandoffs,
      asks: withHandoffs.asks.filter((a) => !acts.closed.has(a.id) && !acts.later.has(a.id)),
    }

    await insertLog(sql, automaticSteps(open, now), now)
    const stepped = applyAutomatic(open, await readLog(sql))

    const requests = new Map(input.queue.map((r) => [r.id, r]))
    const findings = await gatherFindings({
      asks: stepped.asks,
      queue: requests,
      repos: stepped.repos,
      now,
      probes,
      machines: this.deps.machines,
      queueMachine: this.deps.queueMachine,
      roots: input.roots,
    })
    const asks = stepped.asks.map((ask): FleetAsk => {
      const decided = decide({
        ask,
        request: ask.source === 'queue' ? requests.get(ask.id.slice('queue:'.length)) : undefined,
        finding: findings.get(ask.id),
        repos: stepped.repos,
        now,
      })
      // An action the owner already took on this ask is not offered again (archiving a plan once).
      const taken = acts.acted.get(ask.id)
      const actions = decided.actions.filter((a) => !(taken?.has(a.intent) && a.intent !== 'later'))
      const verb = decided.suggestion?.verb
      const suggestion = verb && actions.some((a) => a.intent === verb) ? decided.suggestion : null
      // One click means a suggestion with evidence; without one the ask is the owner's.
      const tier = decided.tier === 'one_click' && !suggestion ? 'yours' : decided.tier
      return { ...ask, tier, suggestion, actions }
    })
    return {
      model: {
        ...stepped,
        asks,
        summary: {
          ...stepped.summary,
          asks: asks.length,
          staleAsks: asks.filter((a) => now.getTime() - Date.parse(a.at) >= STALE_ASK_MS).length,
        },
      },
      timed,
    }
  }
}
