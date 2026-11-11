// Generated from docs/language.md by scripts/language.ts: do not edit (`bun run --cwd apps/console language`).
export const LANGUAGE = {
  amend: "Adding to an open Issue's scope or facts instead of filing a new one. The lead hears it as a note",
  annotation:
    'A comment anchored by a quote and a path on one revision. If the quote is gone from a later revision it sits in "Unanchored"',
  artifact: 'What a lead hands to a person. One model, four kinds: Concept, Spec, Decision, Report',
  ask: "The lead's verb that raises a Decision (factory issue ask)",
  attempt: 'Lead number n of an Issue',
  'avoidable touch':
    'A touch the factory should have settled: a Decision answered and not marked worth asking, an owner note, wake, cancel or reopen. Not the first note of a filing, a verdict on a Concept or Spec, or a done Errand',
  caller:
    "Who a request comes from, decided by its token: owner, orchestrator (the owner's delegate agent: the owner's rights bar eight routes, its own actor in the log), agent (a lead session), machine (the alert door), read (the surfaces)",
  cancelled: "Outcome: the owner's stop",
  chain: 'The dependency graph of Issues and plan rows, across projects. What decides what can run at once',
  change:
    'One row of the change stream: a kind, ids and states, never words. Its cursor (<txid>.<seq>) resumes the stream without losing or doubling a change',
  checkpoint:
    'Where the factory stops for a person: a Decision, a review of a Concept or Spec, an Errand. Never a merge',
  claim:
    "A lead's place in its repo: leads: N plus one for a fix. A wait that needs a person or a clock gives it back; the lead takes one again before it is told its wait is over",
  compacted: 'Session state: its context was just compacted, no turn since',
  concept:
    "A direction for a whole product, UX or architecture, before building. Three or four per project, ever. Its result goes into the project's DESIGN.md",
  cost: "Dollars the usage schema priced for an Issue's sessions, joined at read, never copied",
  cycle: 'The time from an Issue filed to closed',
  decision:
    'One question as a form: recommendation, what was checked, cost per option, what happens with no answer. Refused when incomplete; it reaches the owner only after the Judge saw it; a second ask on the open one amends it. Raised while its Concept or Spec waits for review, it is about that artifact and waits together with the review',
  'decision status': 'open, answered, or withdrawn (the Issue no longer waits for it: it closed or was cancelled)',
  defer:
    "The lead's verb for a wait it can name: until a time, or until other Issues close (factory issue defer). The event is deferred",
  delivery: 'What was typed into a lead: its brief, or a note. Keyed, so a replay types nothing twice',
  dismiss:
    'A held signal the owner or the Judge turns away, with a reason; it files nothing and stays on record as dismissed',
  'door route':
    "The registry that says which repo a monitor files in. The owner's estate, kept by the factory, not by git",
  dropped: 'Outcome: its lead gave it up, with a reason',
  errand:
    "Something only the owner's hands can do: a portal step, a device run, a 1Password prompt. It reaches the owner only after the screen (rules, then factory-errand) passes it",
  event:
    'A fact recorded on an Issue, stored with who sent it and what it did. State is derived from events, never the other way',
  'first verification pass':
    "A first watch (the window after an Issue's first ship) that ended passed, not regressed. The share of those is a KPI",
  'fix commit':
    'A commit that fixes something that went wrong, sorted by class by the fix-classes loop and counted per week',
  flow: 'The read model of Issues by state over time; Chain is its graph',
  friction: 'Any counted waste: an avoidable touch, a refusal, an undelivered note',
  gate: 'A machine check a lead cannot talk past. Evidence is what a gate reads',
  gone: 'Session state: its session ended or its terminal is gone',
  healed: 'Outcome: an incident that went away before a lead started',
  'held signal':
    'Outside text the factory did not trust enough to turn into work. It waits in Needs you for the owner to promote or dismiss it',
  idle: 'Session state: its last turn ended',
  incident:
    'One root cause seen through many signals: the VPS is down, so Beszel, HyperDX and Kuma all fire. Triage groups them under one Issue',
  issue: "One unit of work: one repo, one branch, one ship. Warp's work item",
  judge: 'The agw workflow that tries to settle a Decision before the owner sees it',
  kind: "What an Issue is: feature, bug, chore, docs, incident. Intake files an owner's or agent's request as feature; triage may refine it when it settles the Issue. A failing check of a project's default branch is an incident, never a bug",
  lane: 'A resource class inside a repo (apple) that an Issue or plan row names; lanes: {apple: 1} in the repo\'s project.yaml caps how many leads of the lane run at once, within leads. An undeclared lane is unlimited (docs/plan.md "Lanes")',
  lead: 'The Claude Code session that owns one attempt of one Issue: understand, build, review, ship, verify',
  line: "Stop the line: while a repo's alert is unsolved, only its fix is admitted",
  'long wait':
    'An Issue in a timed wait of an hour or more with other open Issues waiting behind it. It appears in Needs you until the wait ends',
  loop: 'A named recurring job with a trigger, a budget and one way to act. Its judgment is an agw workflow with its own prompt, tools and skills',
  needs:
    'What waits on the owner right now: open Decisions, artifacts awaiting a verdict, open Errands, held signals, long waits',
  origin: 'Where it came from, in words a person uses: you, application, infrastructure, GitHub, feedback, factory',
  outcome:
    "How a closed Issue ended: done, dropped (its lead gave it up, with a reason), healed (an incident that went away before a lead started), cancelled (the owner's stop)",
  owed: 'Working in a repo without a claim, because the wait that gave it up has ended. Owed Issues are served first, so a new lead never takes the place a resumed one waits for. Among themselves they are served by the earliest wait end, then the Issue number; an owed lead is held up only by those ahead of it in that order, never by itself or one behind it. An owed lead counts in the leads of the account it resumes on, and the account cap never refuses its resume. A note refused for a claim for FACTORY_CLAIM_STALL_MS while a claim would be granted to that lead now is a steward stall; a herd waiting its turn is not',
  page: "One message on the owner's line (ntfy). It carries a checkpoint, is never sent twice, and goes on until the checkpoint is settled",
  pass: 'One run of a loop. A pass claims, commits, calls, records: a replayed pass acts on what the first stored',
  plan: "A project's docs/plan.yaml: rows not yet filed (the format: docs/plan.md). A row may target another repo",
  probe:
    'A test signal a lead marks (probe: true) so it is stored dismissed and never held; its ack is dropped, detail probe',
  project:
    "A repo the factory knows, described by its project.yaml. signals: says which automatic sources it listens to; a work repo listens to the owner only. host: names the host its alerts sit on (a key of config/infra.json's hosts), so its Kuma and HyperDX alerts join that host's incident with Beszel's",
  promote: "A held signal becomes work: the owner's or the Judge's call",
  'queue reason':
    'Why a queued Issue stays queued, in one plain sentence that names the cause and its numbers. Its kind: chain, line, finalizing, unknown_project, drain, load, memory, lane, claim, window, cap',
  'queue state':
    'run (admission decides), pace (one lead per project, spending toward the weekly pace), drain (no new lead), for the whole queue or one project. The more restrictive of the two applies',
  'queue wait':
    'The time from an Issue filed or reopened to admitted (a lead started); settling and the chain are part of it',
  queued: 'State: ready, held back by capacity or a chain',
  reaper: 'The loop that ends, by session key and worktree path, the processes a closed lead attempt left behind',
  refusal: 'An Issue event the state machine refused, or a ship the gate refused. Counted as friction',
  regressed:
    'A shipped change that failed its watch: Verify or a probe found it broken after the ship. The lead goes back to work twice, the third time it is a stall',
  replan:
    "An Issue whose lead proposes changes to a project's plan as a Spec with Decisions, and applies them on the owner's verdict (factory issue replan, gated on the approved Spec and the project's own Issues). Filed by the owner (factory planning replan <project>) or by the planning pass when a long wait has Issues behind it; one open per project",
  report: 'For information, never waits. A spike is a Report with a verdict',
  review:
    "The lead's own check of its change, once per ship range, standard or deep. Part of the lead's work, never a factory step",
  'review status':
    "Of a ship's review: covered, not_required, uncovered, unknown. Recorded with its reason, never a refusal",
  revision: "One version of an artifact's content. A Decision has one; a Concept or Spec gains one with each revise",
  round: 'The nth ask of a workflow about one subject. A subject has a limited number of rounds',
  screen:
    'The Judge looks at a held signal (the screen loop, factory-screen) and promotes it, dismisses it with a reason (a duplicate names the open Issue) or leaves it held with a recommendation the owner reads in Needs you. A signal is screened once; a failed call is retried with a backoff, five times at most',
  seat: "One lead the accounts may hold at once (leads per account, plus the bonus the host's idle minutes earn). A seat is idle when work is queued and no lead holds it",
  'session state':
    "What a lead's session is, derived from its hook events: starting (no hook yet), working (a turn is running), idle (its last turn ended), compacted (its context was just compacted, no turn since), walled (its account hit a limit), gone (its session ended or its terminal is gone)",
  settler:
    'Who settled a Decision, in the order tried: policy, judge, default, owner; or orchestrator, answering for the owner',
  settling: 'State: triage is not done',
  ship: 'Land and deploy',
  'ship refused':
    "The gate's answer to a ship that does not hold; recorded, and counted as friction. A review never refuses a ship: it is recorded as evidence",
  signal: 'Anything that arrives and may become work. Has a kind, an origin and a trust level',
  spec: 'A larger plan to review',
  stale: 'A Needs you item that has waited more than 24 hours',
  stall: "A wait with a machine cause, the steward's to end",
  starting: 'Session state: no hook yet',
  state:
    'Where an Issue is: settling (triage is not done), queued (ready, held back by capacity or a chain), working (a lead runs), waiting (a named wait), watching (shipped and deployed, the watch is on: the factory runs Verify and the probes, and the Issue closes when they pass), closed. The only field a person reads to know what an Issue is doing',
  steward:
    'The supervisor loop over stalled Issues. Acts deterministically first (wake, re-check, requeue, deliver) and asks an agw workflow when a call needs judgment',
  surface: 'Console, Herdr, Iris, Argo, ntfy',
  'test slot':
    "A lease on the host's test capacity that factory slot run takes for a make check, test or e2e step; it waits while the host is busy and records what the step cost",
  touch: 'The owner acting on an Issue',
  triage:
    'Deciding what a signal becomes: a new Issue, an amendment to an open one, part of an incident, held, or dropped',
  'triage outcome':
    'What triage did with a signal: filed, amended, incident, held (quarantined, or a down waiting out its heal grace), dropped. Its detail says why: new, matched, replayed, repeat, joined, regression, healed, quiet, unrouted, quarantined, promoted; for a drop work_repo, no_project, not_listened, loop_guard, no_repo, probe, settled (the workflow found an Issue closed in the last day already settles it)',
  'turn away':
    "An Errand the screen refuses because a token or CLI could do it: the Issue's errand wait ends and the lead hears the reason",
  verdict: "The owner's answer on an artifact: Looks good, With notes, Changes, No longer applies",
  verify: 'The check that ends the watch: make verify, probes',
  wait: 'A pause with a named exit',
  waiting: 'State: a named wait',
  walled: 'Session state: its account hit a limit',
  watch: 'The window after a ship',
  watching:
    'State: shipped and deployed, the watch is on: the factory runs Verify and the probes, and the Issue closes when they pass',
  window: "An account's 5-hour or weekly reset",
  'window point': "A point of the five-hour Max window that an Issue's sessions used, per Issue",
  'work repo':
    'A repo no project.yaml describes, or whose project.yaml says work: true. The read token never sees its words',
  working: 'State: a lead runs',
  'worth asking': "The owner's flag on an answered Decision. Feeds the ledger and the Judge's precedent",
} as const satisfies Record<string, string>
