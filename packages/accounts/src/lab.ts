// The policy lab's reports (docs/accounts.md §The policy lab): the shadow log's line and its disagreement rate, the live
// result per policy from the reset ledger, and the text of `simulate` and `compare`. Pure: the CLI reads and writes the files.
import { type ResetEntry } from './history.ts'
import { type LoadModel } from './load-model.ts'
import {
  type Cache,
  type PickResult,
  type PolicyName,
  type Registry,
  POLICY_NAMES,
  accountUnits,
  isPolicyName,
  livePolicy,
  pickWith,
  policyOfRule,
  required,
} from './policy.ts'
import { type Comparison, type Scenario, type SimResult } from './sim.ts'

/** One live pick and what every other policy would have picked on the same snapshot and the same random draws. */
export interface ShadowLine {
  ts: string
  lane: string
  policy: PolicyName
  picked: string
  /** the policies asked */
  shadowed: PolicyName[]
  /** those that would have picked another account, and which */
  differs: Partial<Record<PolicyName, string>>
}

/**
 * The shadow line of a live pick: each other policy decides over the same snapshot and replays the live pick's random
 * draws (`draws`), so a difference is the policy's and not the dice's. A draw it needs beyond those reads as 0.5.
 */
export function shadowLine(
  reg: Registry,
  cache: Cache,
  lane: string,
  nowMs: number,
  live: PickResult,
  draws: number[],
): ShadowLine {
  const policy = livePolicy(reg)
  const shadowed = POLICY_NAMES.filter((p) => p !== policy)
  const differs: Partial<Record<PolicyName, string>> = {}
  for (const p of shadowed) {
    let i = 0
    const other = pickWith(p, { reg, cache, lane, nowMs, rng: () => draws[i++] ?? 0.5 })
    if (other.picked !== live.picked) differs[p] = other.picked
  }
  return { ts: new Date(nowMs).toISOString(), lane, policy, picked: live.picked, shadowed, differs }
}

export interface Disagreement {
  policy: PolicyName
  /** live picks it was asked about, and how many it would have answered differently */
  picks: number
  differs: number
  rate: number
}

/** Per policy, the share of the live picks it would have answered with another account. */
export function disagreement(lines: unknown[]): Disagreement[] {
  const n = new Map<PolicyName, { picks: number; differs: number }>()
  for (const raw of lines) {
    const l = raw as Partial<ShadowLine> | null
    if (!l || !Array.isArray(l.shadowed) || typeof l.differs !== 'object' || l.differs === null) continue
    for (const p of l.shadowed) {
      if (!isPolicyName(p)) continue
      const c = n.get(p) ?? { picks: 0, differs: 0 }
      c.picks++
      if (Object.hasOwn(l.differs, p)) c.differs++
      n.set(p, c)
    }
  }
  return [...n].map(([policy, c]) => ({ policy, ...c, rate: c.picks ? c.differs / c.picks : 0 }))
}

export interface LiveResult {
  /** the policy the ledger's rule names; `unrecorded` for weeks from before the rule was written down */
  policy: PolicyName | 'unrecorded'
  resets: number
  /** capacity-weighted weekly percent at the reset (0..1) */
  used: number
  /** mean hours an account stood closed at its weekly ceiling before the reset */
  closedHours: number
}

/** The reset ledger grouped by the policy that was live in each week (the week's last recorded rule). */
export function liveResults(ledger: ResetEntry[], reg: Registry): LiveResult[] {
  const groups = new Map<PolicyName | 'unrecorded', ResetEntry[]>()
  for (const e of ledger) {
    if (e.weekly === null || !Object.hasOwn(reg.accounts, e.id)) continue
    const key = policyOfRule(e.rule) ?? 'unrecorded'
    groups.set(key, [...(groups.get(key) ?? []), e])
  }
  return [...groups].map(([policy, es]) => {
    const units = (e: ResetEntry) => accountUnits(required(reg.accounts, e.id)).weekly
    const quota = es.reduce((s, e) => s + units(e), 0)
    return {
      policy,
      resets: es.length,
      used: quota ? es.reduce((s, e) => s + (Math.min(100, e.weekly!) / 100) * units(e), 0) / quota : 0,
      closedHours: es.reduce((s, e) => s + e.closed_hours, 0) / es.length,
    }
  })
}

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)} %`
const pad = (s: string | number, n: number) => String(s).padStart(n)
const CELL = 27

/** The model line every report starts with: which measurement the simulation ran on. */
export const modelLine = (m: LoadModel) =>
  `load model measured ${m.measured_at.slice(0, 10)} from ${m.range.from.slice(0, 10)} to ${m.range.to.slice(0, 10)} (${m.sources.counts ?? 'counts unknown'}); measured demand ${m.demand}`

export function simulateText(sc: Scenario & { policy: PolicyName }, r: SimResult): string {
  return [
    modelLine(sc.model),
    `policy ${sc.policy} · demand ${sc.demand} · ${sc.accts.length} accounts · ${sc.weeks ?? 3} weeks · seed ${sc.seed ?? 7}`,
    ...sc.accts.map(
      (a) =>
        `  ${a.id.padEnd(4)} ${a.plan.padEnd(5)} at reset [${required(r.atReset, a.id).join(', ')}]  picks ${r.picks[a.id] ?? 0}  full after ${r.firstFull[a.id] ?? '-'} h`,
    ),
    `used at reset ${pct(r.used)} (capacity-weighted) · blocked ${pct(r.blocked, 2)} · moved ${r.moved} of ${r.sessions} sessions`,
  ].join('\n')
}

export function compareText(c: Comparison, model: LoadModel, live: LiveResult[], shadow: Disagreement[]): string {
  const policies = [...new Set(c.cells.map((x) => x.policy))]
  const demands = [...new Set(c.cells.map((x) => x.demand))]
  const pools = [...new Set(c.cells.map((x) => x.accounts))]
  const out = [
    modelLine(model),
    `${c.weeks} simulated weeks per run, ${c.seeds.length} seeds per cell; cell = used at reset / blocked / moved sessions (all seeds)`,
    '',
  ]
  for (const p of policies) {
    out.push(`${p}`, `  accounts ${demands.map((d) => pad(`demand ${d}`, CELL)).join('')}`)
    for (const n of pools) {
      const row = demands.map((d) => {
        const x = c.cells.find((y) => y.policy === p && y.accounts === n && y.demand === d)!
        return pad(`${pct(x.used)} / ${pct(x.blocked, 2)} / ${x.moved}`, CELL)
      })
      out.push(`  ${pad(n, 8)} ${row.join('')}`)
    }
    out.push('')
  }
  out.push(
    'verdict against v1.9 (more quota used beyond 2 standard errors, no more moved sessions, no more blocked at demand <= 1.0):',
  )
  for (const v of c.verdicts)
    out.push(
      `  ${v.policy}: ${v.beats ? 'BEATS v1.9' : 'does not beat v1.9'} (${v.why}); used ${pct(v.used, 2)} vs ${pct(v.baselineUsed, 2)}, gain ${(v.usedGain * 100).toFixed(2)} ± ${(v.usedGainSe * 100).toFixed(2)} points; moved ${v.moved} vs ${v.baselineMoved}${v.blockedWorse.length ? `; blocks more in ${v.blockedWorse.map((b) => `${b.accounts} accounts at ${b.demand}`).join(', ')}` : ''}`,
    )
  out.push('', 'live, from the reset ledger (the policy each week ran under):')
  if (!live.length) out.push('  no reset recorded')
  for (const l of live)
    out.push(
      `  ${l.policy}: ${l.resets} resets, used at reset ${pct(l.used)}, closed ${l.closedHours.toFixed(1)} h before the reset on average`,
    )
  out.push('', 'shadow log (a pick not made has no outcome, so only how often a policy would have picked otherwise):')
  if (!shadow.length) out.push('  no shadow line yet')
  for (const s of shadow) out.push(`  ${s.policy}: ${s.differs} of ${s.picks} live picks differ (${pct(s.rate)})`)
  return out.join('\n')
}
