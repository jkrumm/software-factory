/**
 * The upgrade plan of a `deps` finding: which outdated packages wait out a cooldown, which move together, which major goes
 * alone, and the procedure a light lead follows. Pure: the release dates are looked up by the probe and handed in.
 */

export type Bump = 'major' | 'minor' | 'patch'

/** One outdated dependency. `releasedAt` is when `latest` was published, absent when it could not be looked up. */
export interface UpgradeRow {
  name: string
  current: string
  latest: string
  size: Bump
  releasedAt?: Date
  /** the package manager already holds it back (bun's release-age cooldown) */
  heldBack?: boolean
}

const COOLDOWN_DAYS = 7
const MAJOR_COOLDOWN_DAYS = 14
const DAY = 86_400_000
/** The most packages a plan names; the rest are one line. */
const MAX_PLAN_ROWS = 40

export interface Batch {
  kind: 'together' | 'major' | 'rest'
  /** what the batch is: the group that moves together, the one major, or the patches and minors left */
  label: string
  rows: UpgradeRow[]
}

export interface HeldRow {
  row: UpgradeRow
  /** the first day the version is old enough */
  until: Date
}

export interface UpgradePlan {
  batches: Batch[]
  held: HeldRow[]
}

/** The cooldown of a bump, in days: a major waits twice as long. */
const cooldownDays = (size: Bump): number => (size === 'major' ? MAJOR_COOLDOWN_DAYS : COOLDOWN_DAYS)

/** The first day a row's version is past its cooldown; undefined when its release date is not known. */
export function cooldownEnd(row: UpgradeRow): Date | undefined {
  return row.releasedAt ? new Date(row.releasedAt.getTime() + cooldownDays(row.size) * DAY) : undefined
}

/** `@scope/pkg` -> `@scope`, `eslint-plugin-x` -> `eslint`, anything else (`@types/*` and `owner/repo` included) -> itself. */
export function groupOf(name: string): string {
  if (name.startsWith('@types/') || (name.includes('/') && !name.startsWith('@'))) return name
  if (name.startsWith('@')) return name.split('/')[0] ?? name
  return name.split(/[-_]/)[0] ?? name
}

const byName = (a: UpgradeRow, b: UpgradeRow): number => a.name.localeCompare(b.name)

/**
 * Held: younger than the cooldown. Then each major alone (the majors of one group of packages that move together are one
 * batch, still apart from every minor); a group of two or more non-majors is a batch; the patches and minors left over are
 * one batch.
 */
export function planUpgrades(rows: UpgradeRow[], now: Date): UpgradePlan {
  const held: HeldRow[] = []
  const ready: UpgradeRow[] = []
  for (const row of rows) {
    const until = cooldownEnd(row)
    if (until && until.getTime() > now.getTime()) held.push({ row, until })
    else ready.push(row)
  }
  const groupBy = (list: UpgradeRow[], key: (name: string) => string): Map<string, UpgradeRow[]> => {
    const out = new Map<string, UpgradeRow[]>()
    for (const row of list) out.set(key(row.name), [...(out.get(key(row.name)) ?? []), row])
    return out
  }
  // Only a shared scope proves two majors move together; a shared name stem does not, so those majors stay alone.
  const majorGroup = (name: string): string => (name.startsWith('@') ? groupOf(name) : name)
  const batches: Batch[] = []
  const majors = ready.filter((row) => row.size === 'major')
  for (const [group, members] of groupBy(majors, majorGroup)) {
    const sorted = members.sort(byName)
    batches.push({
      kind: 'major',
      label: sorted.length > 1 ? `${group}, majors that move together` : (sorted[0]?.name ?? group),
      rows: sorted,
    })
  }
  const others = ready.filter((row) => row.size !== 'major')
  const rest: UpgradeRow[] = []
  for (const [group, members] of groupBy(others, groupOf)) {
    if (members.length > 1) batches.push({ kind: 'together', label: group, rows: members.sort(byName) })
    else rest.push(...members)
  }
  if (rest.length) batches.push({ kind: 'rest', label: 'patches and minors', rows: rest.sort(byName) })
  batches.sort((a, b) => order(a.kind) - order(b.kind) || a.label.localeCompare(b.label))
  held.sort((a, b) => a.row.name.localeCompare(b.row.name))
  return { batches, held }
}

const order = (kind: Batch['kind']): number => (kind === 'rest' ? 0 : kind === 'together' ? 1 : 2)

const day = (date: Date): string => date.toISOString().slice(0, 10)

const rowText = (row: UpgradeRow): string =>
  `${row.name} ${row.current} -> ${row.latest} (${row.size})${row.releasedAt ? `, released ${day(row.releasedAt)}` : ', release date unknown: check it before editing'}`

/** The plan as text lines, longest lists cut at `MAX_PLAN_ROWS` packages. */
export function planLines(plan: UpgradePlan, now: Date): string[] {
  const lines = [`Upgrade plan as of ${day(now)} (cooldown ${COOLDOWN_DAYS} days, ${MAJOR_COOLDOWN_DAYS} for a major):`]
  let shown = 0
  let cut = 0
  const take = (row: UpgradeRow, prefix: string): void => {
    if (shown >= MAX_PLAN_ROWS) cut++
    else lines.push(`${prefix}${rowText(row)}`)
    shown++
  }
  // The held rows come first: they are the ones a lead must not miss, so a long plan cuts batch rows, never them.
  if (plan.held.length) {
    lines.push('Held back, do not upgrade yet:')
    for (const { row, until } of plan.held)
      take(row, `  until ${day(until)} (${cooldownDays(row.size)}-day cooldown): `)
  }
  if (!plan.batches.length) lines.push('Batches: none, every outdated version is still inside its cooldown.')
  plan.batches.forEach((batch, index) => {
    const how =
      batch.kind === 'major'
        ? batch.rows.length > 1
          ? 'one batch, apart from every other'
          : 'alone'
        : batch.kind === 'together'
          ? 'move together'
          : 'one batch'
    // past the cap a batch is only counted: its header would stand empty and cost the brief's clip budget
    if (shown < MAX_PLAN_ROWS) lines.push(`Batch ${index + 1} (${batch.label}; ${how}):`)
    for (const row of batch.rows) take(row, '  ')
  })
  if (cut) lines.push(`  and ${cut} more: run the ecosystem's own outdated command for them`)
  return lines
}

/** The procedure every dependency Issue carries: one numbered line per rule, in the order a lead works. */
export function procedureLines(): string[] {
  return [
    'Procedure (light seat; follow it in order):',
    `1. Cooldown: skip a version younger than ${COOLDOWN_DAYS} days (${MAJOR_COOLDOWN_DAYS} for a major) unless it fixes an advisory (the \`advisories\` finding or \`bun audit\` names it). The held list above is the plan's answer; a version with an unknown release date is checked by hand first (\`npm view <name> time.<version>\`, the registry page or the tag date).`,
    "2. Batches: work the batches above in order, one commit each. Patches and minors of one ecosystem go together, packages that move together (a framework and its plugins, a monorepo's packages) go together, every major goes alone (the majors of one scope that must move together are one batch of their own). If a batch is red, split it by halves to find the package that breaks it.",
    '3. Read before you edit: for every major, and for every batch that fails, read the changelog and the migration guide through `/research` (never from memory), then write what changed into the commit body (breaking changes met, config touched, a one-line source link).',
    "4. Prove it: after each batch run the repo's fast check (`make check-fast`, else its `make check`), at the end the full check; for a deployed service, ship and wait for verify. A dependency commit is reviewed like any other: run `/review` on the range before the ship (order 6), a `chore(deps)` commit included.",
    '5. Never leave half done: a batch that cannot be made green is reverted and filed as its own signal with the error (`factory signal file --from agent:<repo> --repo <repo> --title "Upgrade <batch> fails: <error>" --text "<package versions, the failing command, the output>"`).',
    "6. Stay inside the runtime pins: never upgrade past what the repo pins allow (engines, `.bun-version`, `rust-version`, `requires-python`, the Swift tools version, a base image's OS, a runner label); name such a version as held and why.",
    '7. Report: the ship note lists per batch the packages and versions, the held-back versions with their release date and the day they open, anything held by a pin or an unreadable changelog, and the check results. The next pass does not redo this research: it starts from that list.',
  ]
}
