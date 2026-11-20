# Software Factory

Signals become Issues. A lead, an interactive Claude Code session, owns each Issue from root cause to verified production. One person decides only what a person must.

A coding agent writes a change faster than a person can supervise it. Keep a person at the spec, at every question and at the merge, and ten agents wait on one inbox. Take the person out without replacing what they did, and nothing checks the work. This guide explains one implementation that replaces it: a lifecycle server on Bun and Postgres, built and run by one developer on one always-on machine, shown through its own code and its own Issues.

## The result

The scarce resource is the owner's attention, so the factory counts it. `factory read kpis` and `factory read friction`, the 7 days to 2026-11-20 09:38 UTC, all projects:

| What | Count |
|-|-|
| Issues filed | 1,545, of which the factory's own loops filed 282 |
| Issues closed | 1,604, or 229 a day |
| Median time from filed to closed | 85 minutes |
| First verifications that passed | 1,290 of 1,338 (96.4 %; the target is 90 %) |
| Decisions leads raised | 58: the Judge settled 45, a default 7, the owner 5, his delegate 1 |
| Specs, Concepts and Reports the owner judged | 95 |
| Errands that reached the owner's hands | 77 |
| Times the owner stepped in where the factory should have settled it | 58, mostly notes to a lead (0.038 per Issue; the target is at most 0.07) |

No person read a diff. A touch pattern that repeats becomes an Issue the friction loop files.

## Position

**Dark for code, lit for decisions.** No person reviews a change before production. The lead's own review, the gates, a watch window and probes do that job.

What reaches the owner: product direction, spend, irreversible data loss, other people, security policy, rare big architecture and taste. The factory settles everything else. A touch of the owner that the factory should have avoided counts as friction.

## The loop

![The loop: a signal is triaged into an Issue, admitted, built by a lead, gated, shipped and deployed, then verified and watched; a regression returns to the lead, and loops beside the path file signals.](./diagrams/loop.svg)

1. **Signal.** A monitor, a GitHub issue, a lead's follow-up or the owner's words arrives as a signal with a kind, an origin and a trust level ([Signals and Triage](./signals.md)).
2. **Triage.** Rules decide first. An `agw` workflow decides where the rules are unsure. The outcome is one of five: a new Issue, a note on an open one, part of an incident, held, or dropped ([Signals and Triage](./signals.md)).
3. **Issue.** One repo, one branch, one ship. Its state is derived from stored events, and a total table decides every transition ([Issues](./issues.md)).
4. **Admission.** Accounts, windows, memory, load and per-repo claims decide when a lead may start. An Issue that waits says why. An edge to another Issue holds it ([Capacity](./capacity.md), [Chains and Plans](./chains.md)).
5. **Lead.** A Claude Code session in a herdr-core terminal builds the change, reviews its own work and asks the owner only through a checkpoint ([Leads](./leads.md), [Checkpoints](./checkpoints.md)).
6. **Review and merge guard.** The ship is refused unless the evidence holds: commits, review coverage, acceptance, green checks ([Gates](./gates.md)).
7. **Ship and deploy.** The lead lands the change and deploys it under a lock that fails closed ([Gates](./gates.md)).
8. **Verify and watch.** `make verify` and the probes end the watch. A change that breaks something goes back to its lead ([Gates](./gates.md)).

Loops run beside this path: friction, hygiene, selfwatch and the steward file signals and end stalls ([Loops](./loops.md)).

## The concepts on one page

Six nouns carry the design. Every chapter is about one of them.

| Noun | What it is | The rule that makes it work |
|-|-|-|
| **Signal** | Anything that arrives and may become work | Nobody files around triage; text from outside is held until it is let through |
| **Issue** | One unit of work: one repo, one branch, one ship | Its state is derived from its stored events, by one total table |
| **Event** | A fact recorded on an Issue, one of 25 kinds | Only an event moves a state, and each kind has a list of who may send it |
| **Lead** | The Claude Code session that owns an Issue; an attempt is its *n*th try | One Issue, one lead, from root cause to verified production |
| **Checkpoint** | Where the factory stops for a person: a Decision, a Concept or Spec, an Errand | Code decides first, then a workflow, then the owner. Never a merge |
| **Loop** | A named recurring pass with one way to act | Claim, commit, call, record: a replayed pass acts once |

**The six states.** An Issue is settling (triage is not done), queued, working, waiting, watching (shipped, the watch is on) or closed. A screen never shows these words: it says Running, Paused, Ready, Held or Checking, and Planned for a plan row that is not an Issue yet.

![An Issue's states and the events that move between them.](./diagrams/issue-lifecycle.svg)

**The 25 events,** by where in an Issue's life they fall ([`events.ts`](https://github.com/jkrumm/software-factory/blob/d83ba1e8040a4d8aa3c0639bf659f773f09b67b8/apps/server/src/domains/work/events.ts) holds the kinds and `SENDERS`, who may send each):

| Phase | Events | Sent by |
|-|-|-|
| Arrive | `filed`, `settled` | the factory; the owner or his delegate can file directly |
| Start | `admitted`, `lead_started`, `seated`, `moved_up`, `lead_gone` | the factory; the owner or his delegate sets a seat |
| Work | `noted`, `paused`, `deferred`, `stalled`, `woken` | the lead defers or reports a stall; the owner or his delegate pauses; the owner, the steward, the Judge and the factory note and wake |
| Ask a person | `asked`, `answered`, `submitted`, `verdict_given`, `errand_raised`, `errand_done`, `errand_turned_back` | the lead asks, or the steward for it; the Judge, a default or the owner answers |
| Finish | `shipped`, `watch_passed`, `regressed`, `closed`, `reopened`, `cancelled` | the lead ships or closes, the factory watches, the owner or the factory reopens or cancels |

**A wait names its exit.** A waiting Issue says why it waits and what ends the wait ([`WAITS`](https://github.com/jkrumm/software-factory/blob/d83ba1e8040a4d8aa3c0639bf659f773f09b67b8/apps/server/src/domains/work/issue.ts)). Eight of the twelve waits end by a machine: a timer, a dependency, an outside review, and the five stalls the steward ends. Four need a person: a Decision, a review, an Errand, and the owner's own pause.

**The three checkpoints,** and who settles each before the owner is asked:

![The routes of a Decision, a Spec and an Errand to whoever settles them.](./diagrams/checkpoint-routes.svg)

## How to read this guide

| If you want | Read |
|-|-|
| the idea in an hour | [Issues](./issues.md), [Leads](./leads.md), [Checkpoints](./checkpoints.md) |
| why it is safe without a person at the merge | [Gates](./gates.md), [Signals and Triage](./signals.md), [Capacity](./capacity.md) |
| how it runs many Issues across repos | [Capacity](./capacity.md), [Chains and Plans](./chains.md), [Loops](./loops.md) |
| to build your own | [Running a Factory](./running.md), then [Learnings](./learnings.md) |

## One Issue through the chapters

`issue_1809` runs through five chapters. The factory's own selfwatch loop filed it at 01:03:01 UTC on 2026-11-17 and triage settled it six seconds later ([Signals and Triage](./signals.md)). It stood 1 h 10 min in the queue ([Capacity](./capacity.md)), then `lead-1809-1` worked 12.7 minutes over 8 turns ([Leads](./leads.md)). The lead shipped 3 commits with a review that covered them, and the watch passed at 03:11:00 ([Gates](./gates.md)). Two hours and eight minutes, 2.19 dollars, no Decision, no Errand, no note. Its events are in [Issues](./issues.md#issue_1809-end-to-end).

## Chapters

| Chapter | Claim |
|-|-|
| [Signals and Triage](./signals.md) | Anything that may become work arrives as a signal, and triage decides what it becomes before a lead spends a token. |
| [Issues](./issues.md) | An Issue is one row with one total transition table, and its state is derived from stored events. |
| [Leads](./leads.md) | A lead owns one attempt of one Issue and works from a brief that is a contract. |
| [Gates](./gates.md) | A gate is a machine check a lead cannot talk past, and a ship holds only on evidence. |
| [Capacity](./capacity.md) | Admission is a decision with numbers, and a waiting Issue always says why it waits. |
| [Chains and Plans](./chains.md) | What waits on what is a graph across repos, and a plan is rows not yet filed as Issues. |
| [Checkpoints](./checkpoints.md) | The factory stops for a person at a Decision, a Spec or an Errand, never at a merge. |
| [Loops](./loops.md) | A loop is a named recurring job with one way to act, and a replayed pass acts once. |
| [Learnings](./learnings.md) | What the factory measured about itself, and what changed because of it. |
| [Running a Factory](./running.md) | One host, one database, one deploy lock: what it takes to run this. |

## What this is not

- It is not a product. It is one implementation for one host, set up for its place. It shows the language, the patterns and how far the automation reaches.
- It is MIT licensed. Take the parts you want.
- Every claim in the guide links the code or the Issue that holds it.

Next: [Signals and Triage](./signals.md)
