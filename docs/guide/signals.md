# Signals and Triage

Anything that may become work arrives as a signal. Triage decides what it becomes before any lead spends a token: a new Issue, a note on an open one, part of an incident, a held signal or nothing. The deciding is code first and an `agw` workflow only where the code is unsure. Nobody files around it.

## Signals

A signal has a kind, an origin and a trust level. The receiving side sets all three, never the payload.

- **Kinds** are `alert`, `request`, `feedback` and `remark`.
- **Origin** is where it came from in words a person uses: `you`, `application`, `infrastructure`, `github`, `feedback`, `factory`. `originOf` maps the source name to one.
- **Trust** is `owner`, `machine`, `agent` or `outside`. The route, the poller or the caller's token picks it. A body cannot.
- **The fingerprint** is the same ask under another day's words: the repo and the title, lower-cased, digits and punctuation removed, hashed to 16 hex characters. Two reports of one complaint have one fingerprint, so the second finds the first.
- **One envelope.** A monitor's `down`, a GitHub issue, a voice note and a lead's follow-up all become the same `Signal` before triage reads them.

```ts
export const SIGNAL_STATES = ['held', 'filed', 'amended', 'incident', 'promoted', 'dismissed'] as const
export const DISMISSERS = ['owner', 'judge', 'probe'] as const
export const SIGNAL_KINDS = ['alert', 'request', 'feedback', 'remark'] as const
export const SIGNAL_ORIGINS = ['you', 'application', 'infrastructure', 'github', 'feedback', 'factory'] as const
export const SIGNAL_TRUSTS = ['owner', 'machine', 'agent', 'outside'] as const
```

The fingerprint is eleven lines of code:

```ts
export function fingerprintOf(repo: string | null, title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[\p{N}\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return new Bun.CryptoHasher('sha256')
    .update(`${repo ?? ''}\n${normalized}`)
    .digest('hex')
    .slice(0, 16)
}
```

Fingerprints, like every effect of the factory, are deterministic keys (`key(...parts)` in `kernel/keys.ts`): the same parts give the same key in every process. A signal received twice finds what the first one stored and does nothing again. [Issues](./issues.md#deterministic-keys) covers the keys.

### Where a signal comes from

The source name decides the origin and, for an alert, which projects listen.

| Source | Origin | Enters through |
|-|-|-|
| `kuma`, `hyperdx` | infrastructure, application | the door, one token per source |
| `launchd` | infrastructure | a poller inside the server |
| `github`, `checks` | github | pollers, only for projects whose `signals:` list them |
| `owner:<who>` | you | `factory signal file`, the owner's own words |
| `agent:<repo>` | factory | a lead's or a loop's `factory signal file` |
| `feedback:<app>` | feedback | the door, one route per app |

```ts
export function originOf(source: string): OriginName {
  if (source === 'kuma' || source === 'launchd') return 'infrastructure'
  if (source === 'hyperdx') return 'application'
  if (source === 'github' || source === 'checks') return 'github'
  if (source.startsWith('feedback:')) return 'feedback'
  if (source.startsWith('owner')) return 'you'
  return 'factory'
}
```

**Example files:**

- [`contract/src/intake.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/packages/contract/src/intake.ts#L52-L81): the envelope: kinds, origins, trusts, and the fields the receiver sets
- [`domains/intake/rules.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/intake/rules.ts#L12-L20): `originOf`, source name to origin
- [`domains/intake/rules.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/intake/rules.ts#L104-L115): `fingerprintOf`
- [`kernel/keys.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/kernel/keys.ts#L12-L23): `key`, the one way to build a deterministic key

## Triage

Triage is deciding what a signal becomes. It answers with one of five outcomes and, for each, a detail that says why.

| Outcome | Means |
|-|-|
| `filed` | a new Issue |
| `amended` | a note on an open Issue |
| `incident` | joined to the Issue of one root cause |
| `held` | quarantined, or a `down` waiting out its heal grace |
| `dropped` | nothing filed: `work_repo`, `no_project`, `not_listened`, `loop_guard`, `no_repo`, `probe`, `settled`, `quiet` |

The rules decide first and in this order:

- **The loop guard.** A signal that reports a change a loop made never fires an automatic sender again (`loop_guard`). A loop cannot trigger itself through its own filing.
- **The gate.** An unknown repo hears no one, a work repo hears only the owner, and a project hears the automatic sources its `signals:` list names.
- **A match on an open Issue.** A title that clearly names an open Issue amends it. A retro recommendation (its text carries the `Retro: <date> kpi=…` marker) is the exception: it files its own Issue, since it asks for a change of its own.
- **The fingerprint.** A signal an open Issue already carries, or one closed in the last 24 hours, is a `repeat`, not a second Issue. An amend by title or by the workflow keeps the fingerprint too.
- **A loop's finding key.** Friction, hygiene, selfwatch and throughput file with a key (loop, class, repo, subject) and skip the title match and the workflow: an open Issue of the key takes a note, one closed in the last 24 hours makes a `repeat`, else a new Issue. An agent's own signal is never folded into an Issue a finding filed.

Only when the rules cannot say does the factory call a workflow. `agwAmend` hands `factory-triage` the signal, the open Issues of the repo and the ones closed in the last day, and takes an Issue id back. The adapter refuses an id it did not show. The call's key is built from the source, the fingerprint and a digest of the text, so a replayed pass asks nothing twice.

```ts
        key: key(
          'triage',
          'amend',
          signal.source,
          signal.fingerprint,
          digest(`${signal.title}\n${text}\n${closed.map((c) => c.id).join(',')}`),
        ),
        output: TriageAnswer,
      })
```

An unanswered workflow files a new Issue. A duplicate costs a note; a lost request costs the work.

### Settling

An Issue starts `settling`, and triage is not done until it settles. `settleRule` answers `now` or `ask`. An incident, an Issue an alert filed and an Issue whose filer stated its edges settle at once. A request from a person or an agent asks `factory-triage` again for the Issues it must wait for, its kind, its size and whether the lead owes a Spec first.

```ts
export function settleRule(facts: SettlingFacts, candidates: readonly TriageCandidate[]): 'now' | 'ask' {
  if (facts.kind === 'incident' || facts.fromAlert || facts.statedEdges) return 'now'
  if (refinable(facts)) return 'ask'
  return candidates.length === 0 ? 'now' : 'ask'
}
```

The factory itself calls no model. Every judgment goes through an adapter in `apps/server/src/adapters/agw/`.

**Example files:**

- [`app/intake.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/app/intake.ts#L764-L840): `receive`, the whole decision in order
- [`domains/intake/rules.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/intake/rules.ts#L46-L61): `gate`, who may put work in which repo
- [`adapters/agw/amend.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/adapters/agw/amend.ts#L17-L72): the `factory-triage` call in amend mode and its checks
- [`domains/loops/settle.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/loops/settle.ts#L39-L54): `settleRule`, deterministic first

## Incidents and amendments

An incident is one root cause seen through many signals. An amendment is a signal added to an open Issue as a note instead of a new Issue.

- **Incident.** Alerts from `kuma` and `hyperdx` that sit on one host join one Issue. When the VPS is down, three monitors fire and one Issue opens.
- **Amendment.** The lead of the open Issue hears the signal as a note. The Issue's scope grows; the queue does not.
- **Healing.** A `down` waits out its project's heal grace. An `up` inside it files nothing (`healed`).
- **A lead never amends itself.** The Issue whose lead files a signal is not a candidate for it: a follow-up is work for someone else.

### issue_1809 and issue_1818

`issue_1809` began as a signal. The selfwatch loop files one when a limit of the factory itself trips, here more than eight callers waiting for a test slot for fifteen minutes. `factory issue show issue_1809 --format json`, 2026-11-17, its `triage` entry (fields trimmed, other repos renamed):

```text
at:      2026-11-17T01:03:01.481Z   outcome: filed
origin:  factory   trust: agent   source: agent:software-factory   kind: request
title:   Self-watch: more than eight callers have waited for a test slot for fifteen minutes
text:    Self-watch slot_line (waiting) on software-factory more than 8 callers waited for a test
         slot in 15 consecutive minutes 17 minutes in a row since 2026-11-17T00:46:07.340Z: 24
         waiting now, 24 at most, 1 of 2 base slots held … Reproduce: factory capacity state
         (the slot lines); factory slot list …
```

Six seconds later the Issue was `settled`. The signal carries its own evidence and the commands that reproduce it, so the lead starts from facts, not from a report to interpret.

`issue_1818` shows an amendment. The friction loop filed three signals within 16 seconds, one per stall pattern, in a window of 1,205 Issues filed and 1,183 closed:

| Time | Signal title | Count in 7 days | Outcome |
|-|-|-|-|
| 02:06:04 | Friction: Stalled because something blocked the lead | 77 | `filed` |
| 02:06:15 | Friction: Stalled because the lead stopped reporting | 37 | `amended` |
| 02:06:20 | Friction: Stalled because a shipped change regressed | 15 | `amended` |

The second and third did not open Issues. They reached the lead of `issue_1818` as notes (`noted` at 02:06:15 and 02:06:20). The lead shipped at 02:48:31. [Issues](./issues.md) shows what a `noted` event does to the transition table.

**Example files:**

- [`domains/intake/rules.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/intake/rules.ts#L4-L7): the sources that correlate into an incident
- [`app/intake.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/app/intake.ts#L533-L575): `repeatIn` and `eventIn`, a repeat or a one-off event of a subject that already has an Issue
- [`app/intake.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/app/intake.ts#L577-L627): `humanIn`, a person's or an agent's signal filed or amended

## Held signals and the screen

A held signal is outside text the factory did not trust enough to turn into work. It is stored, fenced as data, and waits for a person or the Judge.

- **Quarantine.** A signal with trust `outside` is held. It reaches a lead only when the owner or the Judge promotes it.
- **Promote** makes it work. **Dismiss** turns it away with a reason of 1 to 500 characters and keeps it on record as `dismissed`.
- **The screen.** The `screen` loop shows each held signal once to the `factory-screen` workflow, with the open Issues and the project names. The Judge promotes, dismisses (a duplicate names the open Issue) or leaves it held with a recommendation the owner reads.
- **Bounded retries.** A failed call backs off from 10 minutes to 6 hours and gives up after five tries. After 72 hours the signal gets one last look and is filed for a lead to investigate, who drafts any reply as an Errand and posts nothing itself.
- **A dismissed report is answered.** The next one with the same words is a new report, under the key after it.

```ts
/** A held signal whose screening failed this often is left unscreened for good: the owner sees it as it is. */
export const MAX_SCREEN_ATTEMPTS = 5
/** Signals the Judge looks at in one pass. */
export const SCREEN_BATCH = 10
```

**Example files:**

- [`app/intake.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/app/intake.ts#L638-L689): `hold` and `outsideIn`, the quarantine and its one exception
- [`domains/intake/screen.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/intake/screen.ts#L1-L61): the screen's limits, the backoff, the request the workflow sees
- [`adapters/agw/screen.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/adapters/agw/screen.ts#L1-L10): `factory-screen` through the agw port

## The door

The door is a separate process that takes alerts and feedback from outside and holds nothing but its own token. It files no Issue and picks no repo.

- **Two routes.** `POST /alert/<source>` and `POST /feedback/<app>`, one bearer token per source, compared in constant time.
- **The repo comes from the route registry.** `factory.door_routes` maps a monitor, or an app, to a repo. The payload never does. A strict body means a `repo` field is a 400.
- **An alert with no route is counted, not filed.** The ack is `dropped`, detail `unrouted`, and `factory door routes` lists the monitors that fired with none.
- **No database credential.** The door calls the server's API as caller `machine` and nothing else.
- **A body cap.** 64 KiB, enforced on the bytes as they arrive.

```ts
/**
 * `POST /signals/alerts`: what the door files for one alert. The payload is data: nothing in it picks a repo, a role, a
 * path or a command, so there is no such field here (the body is strict); the repo comes from the door's routes.
 */
export const AlertRequest = z
  .strictObject({
```

```ts
    if (!routed.value) return ok(dropped('unrouted', `no route for ${input.source} ${input.monitor}: counted`))
```

**Example files:**

- [`apps/door`](https://github.com/jkrumm/software-factory/tree/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/door): the whole door, small enough to read in one sitting
- [`packages/contract/src/intake.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/packages/contract/src/intake.ts#L159-L175): `AlertRequest`, the strict body
- [`app/intake.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/app/intake.ts#L1013-L1068): `alert`, the route lookup and the envelope the server builds

## Work repos

A work repo is a repo no `project.yaml` describes, or one whose `project.yaml` says `work: true`. It hears only the owner.

- **Everything else is dropped.** The gate answers `work_repo` for any signal whose trust is not `owner`.
- **One exception.** A lead's signal for a work repo, when its own Issue the owner filed, is held instead: the owner can promote work it owes there. The screen never reads it.
- **Outside text is dropped before it is stored** (`work_repo`), and the read token never sees a work repo's words, only shape, ids, states and counts.

```ts
    if (signal.trust === 'outside') {
      const where = signal.repo ? await deps.projects.find(signal.repo) : ok(null)
      if (!where.ok) return where
      if (where.value?.work) return ok(dropped('work_repo', `${signal.repo} is a work repo: it hears the owner only`))
```

**Example files:**

- [`domains/intake/rules.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/domains/intake/rules.ts#L42-L61): `gate`, work repo before any other rule
- [`app/intake.ts`](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/apps/server/src/app/intake.ts#L764-L790): `receive`, where the exception for an owner-filed lead sits

**Read more:**

- [`docs/architecture.md` Signals and triage](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/docs/architecture.md#L84-L141): quarantine, the screen, the door's registry, healing
- [`docs/language.md` Work](https://github.com/jkrumm/software-factory/blob/2511836af2e3c6f09eb0f76ded4d5e49b47003ab/docs/language.md#L7-L44): signal, triage outcome, held signal, door route, work repo

Next: [Issues](./issues.md)
