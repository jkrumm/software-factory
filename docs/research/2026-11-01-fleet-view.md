# FV: the fleet view, one read model for every surface

**Status:** proposed by the owner, 2026-11-01. Not planned into waves yet; the program lead authors the plan.

**TLDR.** The factory serves one fleet read model (`GET /fleet`, `factory fleet --format json`, `NOTIFY` on change):
every repo with its plan, every live session with a one-line headline, and every **ask** (anything waiting on the
owner) with its actions. A digest step fills the short texts with a cheap model, only for what changed, at most every
5 minutes. A triage step adds a suggestion with evidence to each ask and cleans up what is provably bookkeeping. The
Herdr board is the first consumer; Iris (IR), Argo (A2) and Hermes read the same model instead of their own.

## Why

- Today two producers answer "what is the fleet doing": `factory status` (sessions, queue, attention) and `agw agents`
  (projects, human queue, `lastReply`, empty `blocker`/`recommendation` fields). dotfiles AGENTS.md names `agw agents`
  "the one producer for Hermes, brain and Argo". The board (`dotfiles/config/herdr-app/mods/jk-board`) reads the
  factory plus a `grep` over `~/SourceRoot/*/docs/waves/PLAN.md`.
- Plans outside that glob are invisible (the teamchat plan lives in
  `prometheus-scripts/wip/waves-2026-10-22-teamchat/docs/waves/PLAN.md`); a session's plan has to come from its spawn.
- Raw wave headings run 10–15 words; nothing short exists to show.
- 13 of 16 human-queue requests are older than 24 h, several provably satisfied (the classic Herdr.app shells are gone
  from the MacBook) or superseded. Four plans sit active but untouched for 4–9 days. The owner wants to decide what
  matters, and have everything else cleaned up.

## The read model

```
summary   { working, idle, done, asks, staleAsks }
asks[]    { id, kind: blocker|question|human|note|permission, repo, session?, plan?,
            short (<= 8 words), text (raw), source, at,
            suggestion?: { verb, why, evidence, confidence }, actions[]: { label, intent } }
repos[]   { name, space, git: { branch, dirty, lastCommit },
            plan?: { path, sha, title, short, goal, waves[]: { n, title, short, status },
                     state: running|planned|scheduled|stale|done, lastTouched },
            sessions[]: { id, role, parent, state, wait, account, terminal, wave?,
                          title (Claude's tab title), headline (<= 8 words), since, lastActivityAt } }
quota, queue   as in `factory status`
```

Plan states: `running` (a live session works it), `planned` (pending waves, never nagged), `scheduled` (an owner-timed
wave or "Later until <date>": silent until then), `stale` (active wave untouched 3 d: shown once in triage as
resume / park / archive), `done` (all waves done: one-click archive).

## Asks: where they come from

Deterministic first, the model only for the rest:

| Source | Signal |
|-|-|
| hc status | `blocked`, `wait=owner` |
| transcript | an `AskUserQuestion` tool call, a pending permission prompt |
| human queue | `dotfiles/scripts/ask-human.sh` requests (dotfiles stays the owner of the queue) |
| factory | attention lines, failed notes |
| deploy gates | a failed deploy that asked through the queue |
| reply extract | the digest reads the last assistant reply: "does it ask the owner something? short + kind" (PR #83 "not merged" is the example) |

## The digest run

- Every 5 minutes the factory computes a fingerprint per item (session turn count, PLAN.md sha, queue ids, attention).
  Unchanged: nothing runs. Changed: only those items go to **one** batched, schema-checked agw call.
- Results are cached by content hash: a plan's short titles are made once per heading change; a headline at most once per
  new turn.
- Building blocks exist in agw (`agw llm title`, `agw llm classify`, `agw decide` with calibrated probabilities). Prefer one
  new generic capability (`agw digest --items <json>`: short title, headline, ask-or-not, kind, confidence) over N calls;
  agw stays unaware of the factory (design §2, dependencies point one way).
- The `/wave` skill writes `<!-- short: … -->` next to each wave heading when it authors a plan; the digest is the fallback
  for plans that predate it.

## Triage: four tiers

| Tier | Rule | Examples |
|-|-|-|
| Automatic | Bookkeeping only, logged and undoable. Never runs a command, never denies an ask. | expired notes dismissed, plans marked stale, an ask folded under the newer ask that supersedes it |
| One click | A suggestion with evidence (a deterministic probe or a newer fact). "Apply all" exists; each item shows why. | resolve "remove Herdr.app" (probe: absent), deny the Oct 29 teamchat deploy gate (a newer deploy exists), archive a 10/10 plan |
| Hand off | The action starts work instead of deciding: a wave or an agw workflow does it, its result comes back as a new ask. | retry deploy, spawn a fixer, review + merge a PR, a fix wave for a reported bug |
| Yours | The business classes and anything needing the owner at a machine. No suggestion button, only Later / Deny. | spend, irreversible data loss, Touch ID, other people |

Consistent with the human-queue policy already in use: an old request is denied, never run with a stale command.
Actions are intents through the API (design §2: writes from any surface are intents, never direct table writes).

## Colour

The board draws only with the Herdr app's `theme()` tokens (`working`, `blocked`, `done`, `idle`, `foreground`, `muted`,
`dim`, `selected`), never its own hex: it follows the light/dark switch and matches the left sidebar's dots. Colour earns its
place by carrying state: `working` and `blocked` are the only hues; progress, plans, asks and actions are grey weight.
Iris and Argo map the same three states onto their own design systems.

## Away and back

At the MacBook the owner triages as things arrive. After a night or a long absence the same stream is a pile, so the
fleet model has a second reading: **what happened since you last looked**.

- **One cursor, server-side.** `owner_seen_at` lives in the factory, not in a surface: catching up on the phone (Iris)
  clears the board too. A surface reports presence (`POST /presence`: the Herdr window active with input, Iris in the
  foreground); a gap of 45 min or more opens an away window.
- **`GET /fleet/since?t=<cursor>`** answers from facts already recorded (factory events, spawns and notes, the hc events log,
  human-queue `askedAt`, each repo's git log, deploy gates, Kuma changes) grouped as:

  | Group | Content |
  |-|-|
  | Needs you | asks raised in the window, ranked, with the triage suggestion and actions |
  | Shipped | merges, deploys, releases, waves closed: one line each with the commit |
  | Went wrong, then recovered | a failure followed by its fix (a failed deploy retried green): collapsed, one line |
  | Handled for you | the triage log: what was resolved, denied or folded, each undoable |
  | Still running | sessions alive now, with headline and how long they have run |
  | Spend | quota used per account in the window |

- **A headline paragraph** at the top, written by the digest from those groups ("Overnight: teamchat Wave 62 shipped,
  agent-workflows Gateway landed, one deploy needs you"). The groups are deterministic; only the paragraph is model text.
- **The board** shows it as a card above Needs you when the window opens: "While you were away · 9h", the paragraph, the
  counts per group, "Caught up" moves the cursor. Asks acted on one by one also move it.
- **While away, interrupt less.** Hermes and Iris push only the *Yours* tier at once; everything else waits for the digest,
  so a night of small events is one read in the morning instead of forty notifications.

## Consumers

| Surface | Reads |
|-|-|
| Herdr board (dotfiles `jk-board`) | `/fleet` over the existing ssh exec; the mock is variant "A + C actions" |
| Iris (IR) | the live glance and decision cards = `asks` |
| Argo (A2) | the Fleet page from a `factory` view |
| Hermes | "what needs me?" = `asks` |
| `agw agents` | becomes a client of `/fleet`, or retires; dotfiles AGENTS.md changes with it |

## Open points for the lead

- **Scope:** design §1 says IuRoot stays outside; the board needs IuRoot sessions (prometheus-epx is today's busiest).
  Read-only visibility of IuRoot sessions and plans is the proposal, no IuRoot intake or spawns.
- **Placement in the program:** before or inside A2/IR, since both want exactly this model. F2's `issue_inbox` is the
  natural later home for asks that become Issues.
- **Board fixes that need no factory work** (dotfiles, can land first): the wave-heading parser drops
  `<!-- status: done 2026-11-01, release … -->`; card clicks should `agent.focus` the session's terminal.
