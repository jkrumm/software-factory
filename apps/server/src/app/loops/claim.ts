import { type CallLoop, type CallPlan, type CallPolicy, planCall } from '../../domains/loops/calls.ts'
import type { LoopStore } from '../../domains/loops/ports.ts'
import type { IssueId } from '../../kernel/ids.ts'
import type { Key } from '../../kernel/keys.ts'

/** What a loop does about one subject: the stored answer, a wait, or a call this pass now owns (`claimed`). */
export type Claimed = Exclude<CallPlan, { kind: 'claim' }> | { kind: 'claimed'; round: number; key: Key }

/**
 * Claim and commit: reads the rounds of the subject, plans from them alone, and when a new round is due stores its claim
 * (the table's unique round makes two passes claim it once). The call itself is made by the caller, with no transaction open.
 */
export async function claimRound(
  stores: { loops: LoopStore },
  input: {
    loop: CallLoop
    issue: IssueId
    subject: string
    now: Date
    policy: CallPolicy
    keyFor(round: number): Key
  },
): Promise<Claimed> {
  const plan = planCall(await stores.loops.calls(input.loop, input.issue, input.subject), input.now, input.policy)
  if (plan.kind !== 'claim') return plan
  const key = input.keyFor(plan.round)
  const won = await stores.loops.claimCall({
    key,
    loop: input.loop,
    issueId: input.issue,
    subject: input.subject,
    round: plan.round,
    claimedAt: input.now,
    leaseUntil: new Date(input.now.getTime() + input.policy.leaseMs),
  })
  return won ? { kind: 'claimed', round: plan.round, key } : { kind: 'in_flight' }
}
