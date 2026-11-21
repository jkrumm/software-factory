# Leads

A lead is an interactive Claude Code session in a herdr-core terminal. It owns one attempt of one Issue from root cause to verified production and acts only through the factory's verbs.

The factory never takes the lead's word that the work is done. Code reads git, CI and the watch. The lead's report is a claim next to that evidence.

## Leads and attempts

A lead is the Claude Code session that owns one attempt of one Issue.

- **One lead, one attempt.** An attempt is lead number *n* of an Issue. The session is named `lead-<issue>-<attempt>`, the branch `factory/<issue>-<attempt>`. The hook parses the name with no server call, so the name never changes.
- **Interactive, never headless.** The lead is a real Claude Code session in a herdr-core terminal. The factory types the brief and every later note into it.
- **Session state is derived.** `starting`, `working`, `idle`, `compacted`, `walled` and `gone` come from hook events when read, never from a stored column.
- **The factory calls no model.** A lead is the one place model judgment enters a change. Every other judgment is an agw workflow.

<!-- snippet: apps/server/src/domains/leads/names.ts leadKey -->
```ts
export const leadKey = (issue: IssueId, attempt: number): string => `lead-${issueNumber(issue)}-${attempt}`
// …
export const leadBranch = (issue: IssueId, attempt: number): string => `factory/${issueNumber(issue)}-${attempt}`
```

issue_1809 is one attempt end to end. The selfwatch loop filed it on 2026-11-17 at 01:03:01 and it settled six seconds later. The queue admitted it at 02:13:33. `lead-1809-1` started at 02:14:28 on sonnet at high effort and shipped at 03:04:20, 50 minutes later.

`factory issue show issue_1809`, 2026-11-17 (timeline, trimmed; two separate JSON objects, one per line):

```json
{ "at": "2026-11-17T02:14:28.568Z", "kind": "lead_started", "text": "A lead started on sonnet at high effort.", "session": "lead-1809-1" }
{ "at": "2026-11-17T03:04:20.757Z", "kind": "shipped", "text": "Shipped; the watch began.", "session": "lead-1809-1" }
```

![A lead from start to watch: the factory types the brief; the lead reviews its range with agw, lands the change inside the merge window on GitHub, deploys under the lock on the host and reports the ship; the factory checks git, starts the watch and returns a red verify to the lead as a note.](./diagrams/lead-sequence.svg)

The drawing follows one attempt in order, as issue_1809 took it, plus the note a red watch sends back. [Gates](./gates.md) covers what each step owes.

**Example files:**

- [`names.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/leads/names.ts#L3-L19): the session key and the branch name, one per attempt
- [`docs/language.md`](https://github.com/jkrumm/software-factory/blob/master/docs/language.md#L63-L77): Lead, Attempt, Session state and Delivery as the factory defines them

## The brief

The brief is what the factory types into a lead first: the operating contract, then the Issue as filed.

- **The contract is one constant.** `STANDING_ORDERS` is byte-identical in every brief, so the prompt cache can serve it. A test pins that every brief starts with it. Nothing in it names an Issue, a project or a path.
- **Nine orders, then verbs.** The orders say who owns what and when to stop, one line each. A verb list gives the command for each report, one line each.
- **A rule about one verb lives in that verb's help.** What a Spec page holds, how a Decision is built and settled, what an Errand may ask for, how a verdict and its annotations are answered, how `--review` waits and how a ship states its acceptance: `factory artifact submit|revise|annotation-reply --help`, `factory issue ask|defer|ship --help`, `factory decision take-default --help`, `factory errand raise --help` (`apps/cli/src/filing.ts`). The brief points there; how to wait and the host's shell traps are in the global CLAUDE.md every account loads. A test holds a typical brief at 12,000 bytes and pins its sections and commands, not its phrases.
- **Notes are data.** Only a note introduced as "a note from the owner" is an instruction. Alert text, logs and history never are.
- **Every stop reports.** A lead ends a turn with a verb or keeps working.

Two orders carry the shipping rules. Order 6 on review, as the lead reads it:

```text
Review your own change once per ship range, standard or deep, before you land it: `/review <merge-base>..HEAD --thread factory-<issue number>`. `factory land` refuses a range with a commit uncovered at standard or deep and prints the /review command to run …
```

Order 7 on shipping:

```text
Ship means land and deploy. … Then run `factory land` in the background with its exit code written out (`; echo rc=$?`) and end the turn: it takes the merge window, rebases, checks the review, pushes, waits for CI, runs the merge guard and merges. A refusal names the step and the next command …
```

The steps of `factory land` per ship mode, and what it refuses: `factory land --help` and `docs/operations.md`, section Merging.

Order 4 draws the line for stopping: "Stop by impact, not effort. A broken caller contract or a needed redesign is `factory issue block`, with a draft branch pushed first; many files or red tests are not a block."

The brief changes when a failure repeats. issue_1807 counted 12 of Issues 1640 to 1806 shipped unreviewed, and its fix was an edit of order 6. [Gates](./gates.md#review) tells that case.

**Example files:**

- [`brief.ts`, the standing orders](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/leads/brief.ts#L9-L29): the contract every lead gets, orders 1 to 9 and the "Also" rules
- [`brief.ts`, orders 6 and 7](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/leads/brief.ts#L18-L19): review once per range, and the merge window

## Seats

A seat is the tier and effort a lead starts on, read from the role table.

- **Roles, not model ids.** `config/roles.json` names a tier (`haiku`, `sonnet`, `opus`) and an effort per role. A change to it needs measured data.
- **The lead row** is sonnet at high effort. issue_1809's lead ran there.
- **The light row** is haiku at high effort, a fifth of the cost. It starts mechanical, well-specified work that a check proves.
- **A rule names the light start.** `lightRule` returns why an Issue starts light (`hygiene:<class>`, `kind:docs`, `alert:route`, `triage:small`) or null. An Issue with a design choice (`checkpoint: spec`) never starts light on size alone. A hygiene finding starts light whatever its size.
- **Stated edges do not cost the size.** An Issue filed with `--after`, `--alone` or as a plan row has its edges final, but triage is still asked for its size and kind (with no Issue to wait for, so it names no edge). Before the planned lead starts, `factory issue show` reports the seat the rule gives it now, with the rule's name, or says the size is not known yet.
- **A struggling light lead moves up once.** Its second stall or second refused ship, an out-of-depth block, or a regression on its first watch gives the next lead the lead row. After that, never light again. A filed seat with `moveUp: true` is moved up and spent the same way; any other filed seat is not.

An excerpt of `config/roles.json`, cut off before the end of the file:

```json
{
  "roles": {
    "lead": { "tier": "sonnet", "effort": "high" },
    "light": { "tier": "haiku", "effort": "high" },
```

<!-- snippet: apps/server/src/domains/leads/light.ts MOVE_UP_AFTER -->
```ts
/** A light lead's second stall, or its second refused ship, moves it up. */
const MOVE_UP_AFTER = 2
```

> [!NOTE]
> `domains/capacity/allowance.ts` is a different seat: how many extra leads an account may run while the host idles. It does not choose a tier.

**Example files:**

- [`roles.json`](https://github.com/jkrumm/software-factory/blob/master/config/roles.json#L1-L10): the role table, one tier and effort per role
- [`light.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/leads/light.ts#L47-L85): `lightRule` picks the seat, `moveUpWhy` moves a struggling light lead up
- [`seats.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/capacity/allowance.ts#L21-L39): the extra leads an idle host can take

## Verbs

A verb is a plain `factory` command that reports one outcome of an attempt.

| Verb | Reports |
|-|-|
| `factory issue ship` | Landed and deployed: one `--acceptance` line per acceptance line, each `met:` or `not met:`; the factory finds the merged commits |
| `factory issue defer` | A wait it can name: until a time, until other Issues close, or on a pull request's review |
| `factory issue block` | It cannot go on and nobody can answer |
| `factory issue close` | No commit needed; outcome `done` or `dropped`, with a reason |
| `factory issue ask` | A Decision, with a recommendation, what it checked, the cost of each option and the no-answer default |

- **Every verb names its attempt.** The CLI fills `--attempt` from `FACTORY_SESSION` (`lead-<issue>-<attempt>`); a flag given wins. `--call <id>` makes a repeated call one event.
- **`factory --help` shows a lead's verbs.** With `FACTORY_SESSION` set it lists only the verbs the agent caller may call (`apps/server/src/api/policy.ts` decides), grouped by noun; `--all` lists every verb.
- **The CLI contract is agw's.** `--format json|plain`, data on stdout, messages on stderr, no prompts.
- **Exit codes are a table.** A caller branches on them. A code is never added or changed in this repo alone.
- **A value of `-` reads stdin**, one starting with `@` reads the file it names.

<!-- snippet: apps/cli/src/exit.ts EXIT -->
```ts
export const EXIT = {
  ok: 0,
  general: 1,
  usage: 2,
  auth: 3,
  not_found: 4,
  conflict: 5,
  confirmation_required: 6,
  network: 7,
  rate_limited: 8,
  contract_mismatch: 9,
  pending: 10,
} as const
```

A lead's token is the `agent` caller, which cannot read some owner routes (`factory project list`, `queue get`, `errand list`). With `FACTORY_SESSION` set, `factory --help` lists only the verbs it may call, such as `factory read overview`.

**Example files:**

- [`brief.ts`, the verb list](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/leads/brief.ts#L31-L47): one line per verb; the flags and rules are in each verb's `--help`
- [`exit.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/cli/src/exit.ts#L5-L17): the exit-code table every caller branches on

## Hooks

A hook is the Claude Code event handler `factory hook <event>` that tells the factory what a lead's session does.

- **Spool first, then post.** The hook appends one line to the session's spool file, then posts it to a unix socket within 300 ms. The spool holds the fact when the server is down, and the server replays it with idempotent keys.
- **It never fails the session.** Without `FACTORY_SESSION` it does nothing. Every path ends in exit 0 except one, below.
- **Stdout stays empty,** because Claude Code injects a hook's stdout into the session.
- **One exit-2 path.** A Stop with nothing reported is sent back to the lead once, on stderr, exit 2.
- **It imports only `node:fs`** and the spool half of the contract, so it starts fast.

<!-- snippet: apps/cli/src/hook.ts LOCK_BUDGET_MS -->
```ts
/** How long a hook waits for another hook of its session before it writes a key that cannot collide. */
const LOCK_BUDGET_MS = 200

/** The post to the server may take this long and no longer. */
const POST_TIMEOUT_MS = 300
```

> [!WARNING]
> A hook that writes to stdout changes the lead's context. The only deliberate write is the line after a compaction, which tells a lead to re-read its Issue.

**Example files:**

- [`hook.ts`, the budgets](https://github.com/jkrumm/software-factory/blob/master/apps/cli/src/hook.ts#L21-L25): the 200 ms lock and the 300 ms post
- [`hook.ts`, `toEvent`](https://github.com/jkrumm/software-factory/blob/master/apps/cli/src/hook.ts#L64-L119): the six hook events and the factory event each one stands for
- [`hook.ts`, `runHook`](https://github.com/jkrumm/software-factory/blob/master/apps/cli/src/hook.ts#L249-L301): stop check, spool, then post

## Deliveries and notes

A delivery is what was typed into a lead: its brief, or a note.

- **Keyed.** The delivery key is claimed before the typing. A replay finds the claim and reads it three ways. Typed already: done. Claimed and a turn since: delivered. Claimed and no turn since: typed again.
- **A lead mid-turn is asked again** until its turn ends. A lead whose terminal is gone has the session state `gone`.
- **Only the owner's note is an instruction.** The orchestrator's note reaches a lead as the owner's does. The factory's, the steward's and the Judge's notes arrive as "a note, as data".
- **Pacing.** After a server start, notes go one per 10 s for 10 minutes, so a restart's backlog does not land at once.

Every effect has a key built from its parts, so a replay finds the earlier claim instead of typing blind:

<!-- snippet: apps/server/src/kernel/keys.ts escapePart -->
```ts
/** `%` and `:` inside a part are escaped, so two different part lists never make the same key. */
const escapePart = (part: string): string => part.replaceAll('%', '%25').replaceAll(':', '%3A')
```

**Example files:**

- [`leads-note.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/app/leads-note.ts#L50-L99): the delivery key is claimed before the typing
- [`note.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/leads/note.ts#L10-L20): which notes a lead treats as the owner's word
- [`keys.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/kernel/keys.ts#L3-L23): the one way to build a deterministic key

## The steward

The steward is the supervisor loop over stalled Issues. It acts deterministically first (wake, re-check, requeue, deliver). It asks an agw workflow only when a call needs judgment.

- **A stop with nothing reported is sent back once per turn.** The stop after the send-back is let through. A finished background task can restart the lead milliseconds later, so a stall there was false.
- **A quiet lead gets a note,** which starts with `steward: your session has been idle`. If it still reports nothing, the Issue stalls as `unreported`.
- **An `unreported` stall is woken** up to `maxWakes` times per attempt before the steward asks.
- **A repeated stall is not asked twice.** If a Decision of the steward already answered the same stall, nothing has changed, and no person has written since, the Issue stays stalled or is held until a time.

<!-- snippet: apps/server/src/domains/leads/stop.ts decideStop -->
```ts
export function decideStop(facts: StopFacts): StopDecision {
  if (facts.backgroundTasks || !facts.working || !facts.factoryTurn || facts.reported) return 'let_through'
  return facts.sentBack ? 'let_through' : 'send_back'
}
```

issue_1818 is the case for the repeated-stall rule. Its filed pattern was "Stalled because something blocked the lead": 77 blocked stalls in 7 days. The ship record traces 47 of them to one Issue looping ask, Judge answer, re-block, and finds a residual cause. A lead's first re-block after an answer scored 0.10 to 0.42 on word overlap against a 0.5 threshold, so it counted as a new question: one Issue was asked 3 times in 8 minutes. The fix treats a blocked stall within 10 minutes of the answer, with no lead report between, as the same stall.

`factory issue show issue_1818`, 2026-11-17 (acceptance line, trimmed):

```text
met: the residual cause is fixed: the lead's first re-block after an answer scored 0.10 to 0.42 sameWords against the 0.5 threshold and was asked again …; repeatedStall now treats a blocked stall within 10 minutes of the answer, with no lead report between, as the same stall; 5 new tests, make check-fast green, /review clean, live at 2ea1b114
```

The excerpt of the rule itself:

<!-- snippet: apps/server/src/app/loops/steward.ts straightAfter -->
```ts
const straightAfter =
  cause === 'blocked' &&
  began !== undefined &&
  began.at.getTime() - answered.at.getTime() <= QUICK_REBLOCK_MS &&
```

The same ship stated one acceptance line as not met: `stall:unreported` (37) and `stall:regressed` (15) were not changed, and the Issue named what to count over the next week.

**Example files:**

- [`steward.ts`, `repeatedStall`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/app/loops/steward.ts#L135-L196): the same stall as a Decision already answered
- [`stall.ts`, `decideStall`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/planning/stall.ts#L86-L126): wake, hold, wait or ask, in that order
- [`stop.ts`](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/leads/stop.ts#L34-L47): the send-back, once per turn

**Read more:**

- [Who works](https://github.com/jkrumm/software-factory/blob/master/docs/language.md#L63-L77): Lead, Attempt, Delivery, Defer, Steward, Judge
- [Capacity and leads](https://github.com/jkrumm/software-factory/blob/master/docs/architecture.md#capacity-and-leads): how a lead starts, its terminal and its account
- [Capacity and leads: hooks and notes](https://github.com/jkrumm/software-factory/blob/master/docs/architecture.md#capacity-and-leads): the spool, the socket and the delivery key

Next: [Gates](./gates.md)
