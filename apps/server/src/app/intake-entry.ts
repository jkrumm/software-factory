import {
  type AlertRequest,
  cleanText,
  type DoorReport,
  FEEDBACK_ROUTE_SOURCE,
  type FeedbackRequest,
  feedbackSource,
  feedbackTokenKey,
  MAX_TITLE_CHARS,
  type SignalRequest,
  storable,
} from '@software-factory/contract'
import { type LoopFinding, type Received, type Triaged } from '../domains/intake/model.ts'
import { findingKeyOf, fingerprintOf, originOf } from '../domains/intake/rules.ts'
import { repoNameOf } from '../domains/planning/sync.ts'
import { idOf, type IssueId } from '../kernel/ids.ts'
import { ok } from '../kernel/result.ts'
import { dropped, loadIssue, type Out, type RequestCaller, type IntakeDeps } from './intake-kit.ts'
import { type Receive } from './intake-receive.ts'
import { envelopeOfRequest } from './intake-envelope.ts'

/** The facts of an alert as the text a lead reads: compact JSON, clipped. */
function factsText(facts: unknown): string {
  const text = JSON.stringify(facts ?? {})
  return text === '{}' ? '' : text.slice(0, 6000)
}

const GROUP_MESSAGE = /child monitors? (down|up)/i

/** A group monitor's alert (Kuma: 'Child monitors down') names no thing of its own: the children are the alerts. */
function isGroupAlert(input: AlertRequest): boolean {
  const facts = input.facts as { msg?: unknown; heartbeat?: { msg?: unknown } } | null
  return [input.title, facts?.msg, facts?.heartbeat?.msg].some(
    (text) => typeof text === 'string' && GROUP_MESSAGE.test(text),
  )
}

/** An Issue id read from a request. */
const issueIdOf = (text: string): IssueId | null => idOf('issue', text)

/** The doors a signal comes in by: a person's or agent's request, the door's alert and feedback, the door's reports. */
export function createEntry(d: { deps: IntakeDeps; receive: Receive }) {
  const { deps } = d
  const { uow, clock } = d.deps
  const { receive } = d.receive

  /**
   * The project name a repo text stands for: a name, a path inside a source root or a linked worktree below one. A
   * project the factory knows answers with its own text; any other path falls back to its main checkout's directory
   * name. The one place a repo is normalized, so nothing downstream stores or counts a path.
   */
  async function repoNameFor(text: string): Out<string> {
    const found = await deps.projects.find(text)
    if (!found.ok) return found
    return ok(found.value?.repo ?? repoNameOf(text))
  }

  /**
   * An agent names itself `agent:<who>`; a lead types the name of its worktree (`factory-<issue>-<attempt>`), which is
   * the Issue's, so it files as the Issue's project, and a path or a worktree of a project files as the project.
   */
  async function sourceFor(from: string): Out<string> {
    const who = from.startsWith('agent:') ? from.slice('agent:'.length) : null
    if (!who) return ok(from)
    const lead = /^factory-([1-9][0-9]*)-[1-9][0-9]*$/.exec(who)
    if (lead) {
      const issue = await uow.run(async (s) => ok(await loadIssue(s.work, `issue_${lead[1]}` as IssueId)))
      if (!issue.ok) return issue
      // a second directory of a taken name is stored by its path, which is no source name: the filer keeps what it typed
      if (issue.value && !issue.value.repo.startsWith('/')) return ok(`agent:${issue.value.repo}`)
    }
    const named = await repoNameFor(who)
    if (!named.ok) return named
    return ok(named.value.startsWith('/') ? from : `agent:${named.value}`)
  }

  /** `finding`: a loop's signal, matched by its key alone (`findingIn`); no request over the API carries one. */
  async function file(body: SignalRequest, caller: RequestCaller, finding?: LoopFinding): Out<Triaged> {
    const from = await sourceFor(body.from)
    if (!from.ok) return from
    const repo = body.repo ? await repoNameFor(body.repo) : null
    if (repo && !repo.ok) return repo
    const signal = envelopeOfRequest({ ...body, from: from.value, repo: repo?.value ?? body.repo }, caller)
    if (!signal.ok) return signal
    return receive(
      { signal: signal.value, alert: null },
      body.filer ? issueIdOf(body.filer.replace(/^(\d)/, 'issue_$1')) : null,
      finding ? findingKeyOf(finding, signal.value.repo) : null,
      finding?.repeatWindowMs,
    )
  }

  /** The door's alert: the route says which repo, the payload never does. */
  async function alert(raw: AlertRequest): Out<Triaged> {
    // Someone else's text, as the factory keeps it: control characters out, what Postgres cannot store replaced.
    const input: AlertRequest = {
      ...raw,
      monitor: cleanText(raw.monitor) || raw.source,
      event: cleanText(raw.event) || 'event',
      title: cleanText(raw.title).slice(0, MAX_TITLE_CHARS) || raw.source,
      facts: storable(raw.facts),
    }
    const routed = await uow.run(async (s) => {
      const route = await s.intake.routeFor(input.source, input.monitor)
      if (!route) {
        await s.intake.noteUnrouted({
          source: input.source,
          monitor: input.monitor,
          title: input.title,
          event: input.event,
          status: input.status,
          group: isGroupAlert(input),
          now: clock.now(),
        })
      }
      return ok(route)
    })
    if (!routed.ok) return routed
    if (!routed.value) return ok(dropped('unrouted', `no route for ${input.source} ${input.monitor}: counted`))
    const link = (input.facts as { link?: unknown } | null)?.link
    const received: Received = {
      signal: {
        source: input.source,
        kind: 'alert',
        origin: originOf(input.source),
        trust: 'machine',
        repo: routed.value.repo,
        fingerprint: `${input.source}:${input.monitor}`,
        title: input.title,
        text: factsText(input.facts),
        link: typeof link === 'string' ? link : null,
        madeBy: null,
        probe: false,
      },
      alert: { subject: input.monitor, event: input.event, status: input.status, facts: input.facts },
    }
    const out = await receive(received)
    if (!out.ok) return out
    // Bookkeeping for the health lines: the alert is dealt with, so a failure here is never the sender's.
    await uow.run(async (s) => {
      if (out.value.outcome === 'dropped' && out.value.detail === 'quiet') {
        const counted = await s.intake.countQuiet(input.source, input.monitor, input.event, clock.now())
        if (!counted) out.value.detail = 'replayed'
      }
      await s.intake.doorAccepted(input.source, clock.now())
      return ok(null)
    })
    return out
  }

  /**
   * The door's feedback from an app: the envelope's version and route head the text as data, the door route
   * (`feedback`, `<app>`) says which repo or none, and the payload never does. The fingerprint is the repo (or app) and the
   * title only: the same complaint from two builds or screens is one.
   */
  async function feedback(raw: FeedbackRequest): Out<Triaged> {
    const title = cleanText(raw.title).slice(0, MAX_TITLE_CHARS) || raw.app
    const routed = await uow.run(async (s) => ok(await s.intake.routeFor(FEEDBACK_ROUTE_SOURCE, raw.app)))
    if (!routed.ok) return routed
    const repo = routed.value?.repo ?? null
    const head = [`app: ${raw.app}`, `version: ${raw.version}`, `route: ${raw.route}`].map((line) =>
      cleanText(line).slice(0, 300),
    )
    const text = [head.join('\n'), cleanText(raw.text)].filter(Boolean).join('\n\n')
    const out = await receive({
      signal: {
        source: feedbackSource(raw.app),
        kind: 'feedback',
        origin: 'feedback',
        trust: 'outside',
        repo,
        fingerprint: fingerprintOf(repo ?? raw.app, title),
        title,
        text,
        link: raw.link ? cleanText(raw.link) : null,
        madeBy: null,
        probe: raw.probe,
      },
      alert: null,
    })
    if (!out.ok) return out
    await uow.run(async (s) => {
      await s.intake.doorAccepted(feedbackTokenKey(raw.app), clock.now())
      return ok(null)
    })
    return out
  }

  function doorReport(report: DoorReport): Out<null> {
    return uow.run(async (s) => {
      const now = clock.now()
      if (report.kind === 'start') await s.intake.doorStarted(report.sources, now)
      else if (report.kind === 'refused') await s.intake.doorRefused(report.source, now)
      else await s.intake.doorAccepted(report.source, now)
      return ok(null)
    })
  }

  return { file, alert, feedback, doorReport }
}
