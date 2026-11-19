import * as z from 'zod'

// `GET /v1/accounts`: the accounts as `packages/accounts` judges them (`claude-account status --json`), plus what only the
// factory knows: the seats each account carries and the leads running on it. The fields of the first group are the package's
// and are named as it names them (snake_case); the second group keeps the names the Console's cards read today.

const nullableString = z.string().nullable()
const nullableNumber = z.number().nullable()

const MODE_KINDS = ['normal', 'drain', 'reserve', 'paused'] as const

/** The mode in force: its kind, where it came from (an override set at runtime or the registry) and when it ends. */
export const AccountMode = z
  .object({
    kind: z.enum(MODE_KINDS),
    for: nullableString,
    until: nullableString,
    until_at: nullableString,
    why: nullableString,
    source: z.enum(['override', 'registry']),
    set_at: nullableString,
    set_on: nullableString,
    /** an override record exists that is no longer in force (ended or cleared) */
    expired: z.boolean(),
  })
  .meta({ id: 'AccountMode' })
export type AccountMode = z.infer<typeof AccountMode>

export const AccountLane = z
  .object({
    open: z.boolean(),
    /** 1-based place in the lane's order, null when closed */
    position: nullableNumber,
    reason: nullableString,
    /** why it takes no work: one of the package's codes (`paused`, `session-max`, `weekly-ceiling`, ...), null when open */
    closed: nullableString,
    why: nullableString,
    opens_at: nullableString,
  })
  .meta({ id: 'AccountLane' })

export const AccountRow = z
  .object({
    id: z.string(),
    plan: z.string(),
    units: z.object({ session: z.number(), weekly: z.number() }),
    enabled: z.boolean(),
    auth_ok: z.boolean(),
    exhausted_until: nullableString,
    /** each limit with its percent, reset and the age of the sample: `session`, `weekly_all`, `weekly_scoped` */
    limits: z.array(z.record(z.string(), z.unknown())),
    mode: AccountMode,
    reserve: z
      .object({
        for: z.string(),
        known: z.boolean(),
        unused: nullableNumber,
        budget_left: nullableNumber,
        released: z.boolean(),
      })
      .nullable(),
    /** the first reason it takes no work in any lane; null when it is open */
    closed: z.object({ closed: z.string(), why: z.string(), opens_at: nullableString }).nullable(),
    /** per lane: whether it takes work, its place and why not */
    lanes: z.record(z.string(), AccountLane),
    forecast: z
      .object({
        method: z.string(),
        weekly_at_reset: z.number(),
        full_at: nullableString,
        waste_percent: z.number(),
        waste_units: z.number(),
        burn_per_hour: z.number(),
        basis_hours: z.number(),
      })
      .nullable(),
    resets: z.array(
      z.object({
        at: z.string(),
        weekly: nullableNumber,
        scoped: nullableNumber,
        modes: z.array(z.string()),
        rule: nullableString,
        closed_hours: z.number(),
        manual: z.boolean(),
      }),
    ),
    /** the seats: the most leads it carries at once (an idle host raises it for a pass), the leads that hold one, and what is free */
    seats: z.object({ cap: z.number().int(), taken: z.number().int(), free: z.number().int() }),
    /** the Issues whose leads run on it now (`issue_12`) */
    leads: z.array(z.string()),
    // the card fields, as the newest poll read them (`ReadAccountQuota`)
    account: z.string(),
    fiveHourUsed: nullableNumber,
    weeklyUsed: nullableNumber,
    fiveHourResetsAt: nullableString,
    weeklyResetsAt: nullableString,
    fresh: z.boolean(),
    /** 1-based place in the order new leads are given accounts (the bulk lane); null: closed, or the reading is stale */
    rank: z.number().int().nullable(),
    rankReason: nullableString,
  })
  .meta({ id: 'AccountRow' })
export type AccountRow = z.infer<typeof AccountRow>

export const AccountsView = z
  .object({
    schema: z.number().int(),
    at: z.string(),
    machine: z.string(),
    /** the picker's rule version */
    rule: z.string(),
    default_account: z.string(),
    lanes: z.array(z.string()),
    accounts: z.array(AccountRow),
  })
  .meta({ id: 'AccountsView' })
export type AccountsView = z.infer<typeof AccountsView>

/** `POST /v1/accounts/:id/mode`: a mode override; `until` is an ISO time or `reset` (drain without one lasts to the reset). */
export const AccountModeBody = z
  .object({
    mode: z.enum(MODE_KINDS),
    /** reserve only: the model whose unused allowance the account holds */
    for: z.string().min(1).optional(),
    until: z.string().min(1).optional(),
    why: z.string().min(1).optional(),
  })
  .meta({ id: 'AccountModeBody' })
export type AccountModeBody = z.infer<typeof AccountModeBody>

export const AccountModeAnswer = z.object({ account: z.string(), mode: AccountMode }).meta({ id: 'AccountModeAnswer' })
export type AccountModeAnswer = z.infer<typeof AccountModeAnswer>
