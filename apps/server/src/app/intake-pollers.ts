import { type IntakeSink, type RedBranch, type SubjectState, type Writeback } from '../domains/intake/ports.ts'
import { leadBranch } from '../domains/leads/names.ts'
import { replay } from '../domains/work/machine.ts'
import { issueNumber } from '../kernel/ids.ts'
import { key as keyOf } from '../kernel/keys.ts'
import { err, ok, portError, type PortError } from '../kernel/result.ts'
import { recordIn } from './issues.ts'
import { type IntakeError, isOpen, loadIssue, type Out, type IntakeDeps } from './intake-kit.ts'
import { type Receive } from './intake-receive.ts'

/** A write error as the port error a poller logs. */
function failureOf(error: IntakeError): PortError {
  if (error.kind === 'timeout' || error.kind === 'gone' || error.kind === 'refused' || error.kind === 'unreadable') {
    return error
  }
  return portError('refused', `${error.kind}: ${'detail' in error ? error.detail : JSON.stringify(error)}`)
}

/** What the pollers ask: the red default branch, the subjects of a source, the writebacks, and the receive they push into. */
export function createPollers(d: { deps: IntakeDeps; receive: Receive }) {
  const { deps } = d
  const { uow, clock } = d.deps
  const { receive } = d.receive

  /**
   * The Issues of the project whose lead works or watches on a branch with an open pull request, each noted once: the
   * key is the red Issue and the noted one, so a replay finds the note. The pull requests were read before, outside
   * any transaction.
   */
  async function noteRedBranch(red: RedBranch): Out<number> {
    const open = await deps.openIssues.inRepo(red.repo)
    if (!open.ok) return open
    const candidates = open.value.filter(
      (issue) => issue.id !== red.issue && (issue.state === 'working' || issue.state === 'watching'),
    )
    if (candidates.length === 0) return ok(0)
    const pulls = new Set(red.pulls)
    const link = red.link ? ` (${red.link})` : ''
    const text = `the default branch ${red.branch} is red: the check ${JSON.stringify(red.check)} is failing${link}. Your pull request's merge will be refused by merge-guard until it is green; Issue ${issueNumber(red.issue)} is fixing it.`
    return uow.run(async (s) => {
      let told = 0
      for (const candidate of candidates) {
        const issue = await loadIssue(s.work, candidate.id)
        if (!issue || (issue.state !== 'working' && issue.state !== 'watching')) continue
        if (!pulls.has(leadBranch(issue.id, issue.attempt))) continue
        const noted = await recordIn(s.work, deps, {
          issueId: issue.id,
          key: keyOf('noted', 'red-branch', red.issue, issue.id),
          event: { kind: 'noted', payload: { text }, actor: 'factory' },
        })
        if (!noted.ok) return noted
        if (noted.value.result === 'applied') told++
      }
      return ok(told)
    })
  }

  const sink: IntakeSink = {
    receive: async (r) => {
      const out = await receive(r)
      return out.ok ? out : err(failureOf(out.error))
    },

    subjects: async (source, prefix) => {
      const out = await uow.run(async (s) => {
        const states = new Map<string, SubjectState>()
        for (const subject of await s.intake.latestSubjects(source, prefix)) {
          states.set(subject.subject, {
            subject: subject.subject,
            open: isOpen(await loadIssue(s.work, subject.issueId)),
            since: subject.filedAt,
          })
        }
        for (const subject of await s.intake.pendingSubjects(source, prefix)) {
          states.set(subject.subject, { subject: subject.subject, open: true, since: subject.openedAt })
        }
        return ok([...states.values()])
      })
      return out.ok ? out : err(failureOf(out.error))
    },

    pendingWritebacks: async (limit) => {
      const out = await uow.run(async (s) => {
        const pending: Writeback[] = []
        for (const row of await s.intake.unwrittenBack(limit * 10)) {
          const history = await s.work.history(row.issueId)
          if (!history) continue
          const issue = replay(row.issueId, history)
          if (issue.state !== 'closed' || !issue.outcome) continue
          const closing = [...history].reverse().find((record) => record.kind === 'closed')
          const reason = (closing?.payload as { reason?: unknown } | undefined)?.reason
          pending.push({
            issueId: row.issueId,
            subject: row.subject,
            outcome: issue.outcome,
            admitted: row.admitted,
            summary: typeof reason === 'string' ? (reason.split('\n')[0] ?? null) : null,
          })
          if (pending.length >= limit) break
        }
        return ok(pending)
      })
      return out.ok ? out : err(failureOf(out.error))
    },

    noteRedBranch: async (red) => {
      const out = await noteRedBranch(red)
      return out.ok ? out : err(failureOf(out.error))
    },

    wroteBack: async (issueId, result) => {
      const out = await uow.run(async (s) => {
        await s.intake.recordWriteback(issueId, result, clock.now())
        return ok(undefined)
      })
      return out.ok ? out : err(failureOf(out.error))
    },
  }

  return { sink }
}
