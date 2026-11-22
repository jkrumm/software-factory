import { type Alert, type Received, type RepoSignals, type Triaged } from '../domains/intake/model.ts'
import { groupOf, issueKindOf, type Topology } from '../domains/intake/rules.ts'
import { type Issue } from '../domains/work/issue.ts'
import { type IssueId } from '../kernel/ids.ts'
import { type Key, key as keyOf } from '../kernel/keys.ts'
import { ok } from '../kernel/result.ts'
import { fileIn, recordIn } from './issues.ts'
import { moveUpIfDue } from './move-up.ts'
import {
  actorOf,
  type Decision,
  dropped,
  eventKeyOf,
  isOpen,
  loadIssue,
  MAX_DISMISS_REASON,
  noteText,
  type Out,
  replayedOf,
  type Stores,
  triaged,
  type IntakeDeps,
  type Ledger,
} from './intake-kit.ts'

/** The monitor path: a `down` amends, joins or files; an `up` heals or notes. */
export function createAlerts(d: { deps: IntakeDeps; ledger: Ledger }) {
  const { deps } = d
  const { clock, settings } = d.deps
  const { note, store } = d.ledger

  async function amendOpen(
    s: Stores,
    r: Received,
    alert: Alert,
    issue: Issue,
    subjectId: number,
    groupKey: string | null,
  ): Out<Triaged> {
    const now = clock.now()
    const evKey = eventKeyOf(r) as Key
    let detail: Triaged['detail'] = 'repeat'
    let recorded = false
    if (issue.state === 'watching') {
      // A light lead's first watch that breaks moves the Issue up instead of going back to that lead.
      const moved = await moveUpIfDue({ work: s.work }, deps, {
        issueId: issue.id,
        regressedWatch: issue.watch,
        detail: noteText(r),
      })
      if (!moved.ok) return moved
      recorded = moved.value?.result === 'applied'
      if (recorded) detail = 'regression'
    }
    if (issue.state === 'watching' && !recorded) {
      // A `down` while the watch runs is the change breaking something: the machine takes it back to its lead.
      const regressed = await recordIn(s.work, deps, {
        issueId: issue.id,
        key: keyOf('regressed', 'signal', r.signal.source, alert.subject, alert.event),
        event: { kind: 'regressed', payload: { watch: issue.watch, detail: noteText(r) }, actor: 'factory' },
      })
      if (!regressed.ok) return regressed
      recorded = regressed.value.result === 'applied'
      if (recorded) detail = 'regression'
    }
    if (!recorded) {
      const noted = await note(
        s,
        issue.id,
        keyOf('noted', 'signal', r.signal.source, alert.subject, alert.event),
        r,
        'down again',
      )
      if (!noted.ok) return noted
    }
    await s.intake.touchSubject(subjectId, { at: now, upAt: null, repeat: true })
    if (groupKey) await s.intake.touchIncident(issue.id, now)
    const signal = await store(s, r, evKey, 'amended', issue.id)
    return ok(triaged('amended', detail, issue.id, signal))
  }

  async function join(s: Stores, r: Received, alert: Alert, issue: Issue, groupKey: string | null): Out<Triaged> {
    const now = clock.now()
    const noted = await note(
      s,
      issue.id,
      keyOf('noted', 'signal', r.signal.source, alert.subject, alert.event),
      r,
      groupKey ? 'joins this incident' : 'a related alert',
    )
    if (!noted.ok) return noted
    await s.intake.insertSubject({
      source: r.signal.source,
      subject: alert.subject,
      fingerprint: null,
      issueId: issue.id,
      groupKey,
      filedAt: now,
      lastSeen: now,
      repeats: 0,
      upAt: null,
      writeback: false,
      admitted: null,
    })
    if (!groupKey) {
      const matched = await store(s, r, eventKeyOf(r), 'amended', issue.id)
      return ok(triaged('amended', 'matched', issue.id, matched))
    }
    await s.intake.touchIncident(issue.id, now)
    const signal = await store(s, r, eventKeyOf(r), 'incident', issue.id)
    return ok(triaged('incident', 'joined', issue.id, signal))
  }

  /** The workflow found the ask already covered by a recently closed Issue: stored dismissed by the judge, nothing filed. */
  async function coveredBy(s: Stores, r: Received, decision: Decision, stateKey: Key | null): Out<Triaged> {
    const id = decision.settled as IssueId
    const head = `already covered by ${id}`
    const reason = (decision.reason ? `${head} — ${decision.reason}` : head).slice(0, MAX_DISMISS_REASON)
    const stored = await store(s, r, stateKey, 'dismissed', null, { reason, by: 'judge', at: clock.now() })
    return ok(triaged('dropped', 'settled', null, stored, head))
  }

  async function fileNew(
    s: Stores,
    r: Received,
    filedKey: Key,
    options: { groupKey: string | null; writeback?: boolean; admitted?: string | null; stateKey?: Key | null },
  ): Out<Triaged> {
    const now = clock.now()
    const { signal } = r
    const filed = await fileIn(s.work, deps, {
      key: filedKey,
      event: {
        kind: 'filed',
        payload: { repo: signal.repo as string, title: signal.title, kind: issueKindOf(r), origin: signal.origin },
        actor: actorOf(r),
      },
    })
    if (!filed.ok) return filed
    const issue = filed.value.issue
    if (filed.value.result === 'replayed') return ok(triaged('filed', 'replayed', issue.id))
    const stored = await store(
      s,
      r,
      options.stateKey === undefined ? eventKeyOf(r) : options.stateKey,
      'filed',
      issue.id,
    )
    if (r.alert) {
      await s.intake.insertSubject({
        source: signal.source,
        subject: r.alert.subject,
        fingerprint: r.alert.status === 'event' ? signal.fingerprint : null,
        issueId: issue.id,
        groupKey: options.groupKey,
        filedAt: now,
        lastSeen: now,
        repeats: 0,
        upAt: null,
        writeback: options.writeback ?? false,
        admitted: options.admitted ?? null,
      })
    }
    if (options.groupKey) {
      await s.intake.insertIncident({ issueId: issue.id, groupKey: options.groupKey, openedAt: now, lastAlertAt: now })
    }
    return ok(triaged('filed', 'new', issue.id, stored))
  }

  async function downIn(
    s: Stores,
    r: Received,
    alert: Alert,
    ctx: { info: RepoSignals; topology: Topology; heal?: unknown; decision?: Decision },
  ): Out<Triaged> {
    const now = clock.now()
    const { signal } = r
    const evKey = eventKeyOf(r) as Key
    const prior = await s.intake.signalByKey(evKey)
    if (prior) return ok(replayedOf(prior))
    if (await s.intake.seen(evKey)) return ok(dropped('replayed', 'this event already settled'))

    const latest = await s.intake.latestSubject(signal.source, alert.subject)
    if (latest) {
      const issue = await loadIssue(s.work, latest.issueId)
      if (isOpen(issue)) return amendOpen(s, r, alert, issue, latest.id, latest.groupKey)
    }
    // An alert that never reported up since its last Issue was filed is the same one still firing: that Issue closing did not
    // clear it, so a closed Issue never covers it (on the first live read 36 of 37 such dismissals came back as an Issue of their own).
    const stillFiring = latest?.upAt === null

    const groupKey = groupOf(ctx.topology, r, signal.repo as string, ctx.info.host)
    if (groupKey) {
      // Alerts on one host are serialized: two at once must see each other's incident, never open two.
      await s.intake.lock(`group:${groupKey}`)
      const incident = await s.intake.latestIncident(groupKey)
      if (incident && now.getTime() - incident.lastAlertAt.getTime() <= settings.incidentWindowMs) {
        const issue = await loadIssue(s.work, incident.issueId)
        if (isOpen(issue)) return join(s, r, alert, issue, groupKey)
      }
    }

    if (ctx.decision?.settled && !stillFiring) return coveredBy(s, r, ctx.decision, evKey)
    if (ctx.decision?.amend) {
      const issue = await loadIssue(s.work, ctx.decision.amend)
      if (isOpen(issue)) return join(s, r, alert, issue, groupKey)
    }

    const rule = ctx.heal === undefined ? ctx.info.heal.find((h) => h.when === `${signal.source}.down`) : undefined
    if (rule) {
      if (!(await s.intake.pendingOf(signal.source, alert.subject))) {
        await s.intake.insertPending({
          source: signal.source,
          subject: alert.subject,
          repo: signal.repo as string,
          received: r,
          rule,
          openedAt: now,
          dueAt: new Date(now.getTime() + rule.graceMs),
          attempts: 0,
          results: [],
        })
      }
      return ok(
        triaged(
          'held',
          'settling',
          null,
          null,
          `waiting ${Math.round(rule.graceMs / 1000)} s for ${signal.source} to come back`,
        ),
      )
    }

    // the heal pass's facts are stored under the key `settle`, the name rows already carry
    const withHeal: Received =
      ctx.heal === undefined ? r : { ...r, alert: { ...alert, facts: { details: alert.facts, settle: ctx.heal } } }
    return fileNew(s, withHeal, keyOf('filed', 'signal', signal.source, alert.subject, alert.event), { groupKey })
  }

  async function upIn(s: Stores, r: Received, alert: Alert): Out<Triaged> {
    const now = clock.now()
    const { signal } = r
    const evKey = eventKeyOf(r) as Key
    const prior = await s.intake.signalByKey(evKey)
    if (prior) return ok(replayedOf(prior))
    if (await s.intake.seen(evKey)) return ok(dropped('replayed', 'this event already settled'))

    const latest = await s.intake.latestSubject(signal.source, alert.subject)
    const issue = latest ? await loadIssue(s.work, latest.issueId) : null
    if (latest && isOpen(issue)) {
      // The same lock as a join: an up that checks "every alert is up" must not miss an alert joining at that moment.
      if (latest.groupKey) await s.intake.lock(`group:${latest.groupKey}`)
      await s.intake.touchSubject(latest.id, { at: now, upAt: now })
      const all = await s.intake.subjectsOfIssue(issue.id)
      const everyUp = all.every((subject) => subject.id === latest.id || subject.upAt !== null)
      if (everyUp && (issue.state === 'settling' || issue.state === 'queued')) {
        // No lead has started: nothing is left to do, and the machine closes it as healed.
        const healed = await recordIn(s.work, deps, {
          issueId: issue.id,
          key: keyOf('closed', 'signal', issue.id, 'healed'),
          event: {
            kind: 'closed',
            payload: { attempt: null, outcome: 'healed', reason: `${signal.source} is up again: ${signal.title}` },
            actor: 'factory',
          },
        })
        if (!healed.ok) return healed
        if (healed.value.result === 'applied') {
          const stored = await store(s, r, evKey, 'amended', issue.id)
          return ok(triaged('amended', 'healed', issue.id, stored))
        }
      }
      const noted = await note(
        s,
        issue.id,
        keyOf('noted', 'signal', signal.source, alert.subject, alert.event),
        r,
        'up again',
      )
      if (!noted.ok) return noted
      const stored = await store(s, r, evKey, 'amended', issue.id)
      return ok(triaged('amended', 'matched', issue.id, stored))
    }

    const pending = await s.intake.deletePending(signal.source, alert.subject)
    if (pending) {
      // The `down` that was waiting is settled too: its late retry opens no second row.
      const waiting = eventKeyOf(pending.received)
      await s.intake.remember([evKey, ...(waiting ? [waiting] : [])], now)
      return ok(dropped('healed', 'it came back up while settling; nothing filed'))
    }
    return ok(dropped('quiet', 'it is up and nothing of it is open'))
  }

  return { downIn, upIn, fileNew, coveredBy }
}

export type Alerts = ReturnType<typeof createAlerts>
