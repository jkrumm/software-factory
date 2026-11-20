# Checkpoints

A checkpoint is where the factory stops for a person. Each kind has a contract the code enforces. A Decision goes to the Judge first. A Spec waits 24 hours and then proceeds on its defaults. An Errand is only for a person's hands. Screens (last section) decide what reaches the owner, and whatever reaches the owner and did not need to is counted as an avoidable touch.

![Checkpoint routes: a Decision passes the Judge, then the owner, and takes its default when no answer comes; a Spec reaches the owner and goes ahead on its defaults after 24 hours; an Errand is turned back unless it needs hands, and a check can close it.](./diagrams/checkpoint-routes.svg)

## Decisions

A Decision is one question as a form. The lead raises it with `factory issue ask`, and the form is refused unless every field is filled.

- **Required fields.** `question`, `recommendation`, `checked` (what the lead looked at), at least two `options` each with a `label`, a `cost` and a `reversible` flag, and `noAnswer.consequence`. A form with a missing field is refused with every missing field named, and nothing is stored.
- **A recommendation is an option.** It must be the label of one of the options.
- **A default is reversible.** `noAnswer.default` names a reversible option and comes with `waitMinutes` (1 to 10080). Both are given or neither is. When the wait runs out, the default is taken; a lead that already went on with it takes it sooner with `factory decision take-default <id> --attempt <n>`.
- **Waiting is not a choice.** A recommendation or default of "Keep waiting", "Wait for review", "Do nothing" or "Hold" is refused. What it waits for is a person's chore, and a chore is an Errand. The steward's own asks are exempt: a hold is a real answer to a stall.
- **Three steps, in order.** The Judge (next section), the default after its wait (or taken by the lead), the owner. The Decision records who settled it: `judge`, `default`, `owner`, or `orchestrator` when it answers for the owner. (Rows from before 2026-11-20 may also say `policy`: that step is gone, and `project.yaml`'s `policy:` key is accepted and dropped.)

<!-- snippet: apps/server/src/domains/checkpoints/decision.ts NO_OP_LABELS -->
```ts
const NO_OP_LABELS: readonly RegExp[] = [
  /^(?:keep|continue|stay|remain|just|simply)\b.{0,12}\b(?:waiting|wait|blocked|paused)\b/i,
  /^(?:wait(?:ing)?|do(?:ing)? nothing|no[- ]?op|no action|nothing|hold|leave (?:it )?(?:as is|open|alone))\b[^,;:]{0,30}$/i,
]
```

A label that goes on to a plan ("Wait for Issue 12 to land, then ship") does not match, so a real option can still say wait.

`factory issue show issue_1413`, 2026-11-17, trimmed: a default taken because no one answered.

```json
{
  "question": "Drop the factory_legacy schema and the pre-cutover dump now that the way back is gone?",
  "options": [ "Delete the dump now, drop factory_legacy on 2026-12-15", "Drop both now", "Keep both" ],
  "recommendation": "Delete the dump now, drop factory_legacy on 2026-12-15",
  "default": "Keep both",
  "askedAt": "2026-11-15T11:19:30.783Z",
  "answeredAt": "2026-11-16T11:19:40.294Z",
  "settledBy": "default"
}
```

The wait was 24 hours. The default is not the recommendation: the lead recommended the cleanup and named the reversible option as the fallback.

**Example files:**

- [`decision.ts` L63-L151](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/checkpoints/decision.ts#L63-L151): `readDecisionForm`, every required field and the reversible default.
- [`decision.ts` L153-L172](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/checkpoints/decision.ts#L153-L172): the labels that are no choice, and the refusal that points to an Errand.
- [`decision.ts` L180-L191](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/checkpoints/decision.ts#L180-L191): when the default is due.

## The Judge

The Judge is the agw workflow `factory-ask` that tries to settle a Decision before the owner sees it.

- **Every Decision, first.** The Judge sees a Decision before the owner does. A failed call is retried after 5 minutes, three tries in all. After the third the Decision goes to the owner unjudged.
- **It reads what a lead would.** The plan, the docs and the precedents: Decisions the owner answered before. An answer the Judge, a default or the orchestrator gave is never one.
- **It sees scrubbed text.** Every field is scrubbed and cut at 2000 characters, and the repo is passed as its name, never a path.
- **It answers or hands on.** The verdict is `answer` or `owner`. The factory checks an answer before acting on it.
- **Never irreversible.** The answer must be exactly one of the options, must name a source, and must not be an option that cannot be taken back. An irreversible option is the owner's.

<!-- snippet: apps/server/src/domains/checkpoints/decision.ts guardVerdict -->
```ts
export function guardVerdict(form: DecisionForm, verdict: JudgeVerdict): Guarded {
  const source = verdict.source.trim()
  if (source === '') return { ok: false, why: 'the answer names no source' }
  const label = optionOf(form, verdict.answer)
  if (label === null) return { ok: false, why: 'the answer is not one of the options' }
  const option = form.options.find((candidate) => candidate.label === label)
  if (option && !option.reversible) {
    return { ok: false, why: `${label} cannot be taken back: an irreversible option is the owner's` }
  }
  return { ok: true, answer: label, source }
}
```

`factory issue show issue_653`, 2026-11-17, trimmed: a Decision about a stalled lead, settled by the Judge in six seconds.

```json
{
  "question": "Lead on issue_653 has been idle 20 minutes after two steward wakes, with nothing reported and no tool running. How should the Issue proceed?",
  "options": [ "Stop the attempt and re-file the Issue", "Keep the lead and take no further action", "Drop the Issue" ],
  "recommendation": "Stop the attempt and re-file the Issue",
  "askedAt": "2026-11-10T17:14:48.470Z",
  "answeredAt": "2026-11-10T17:14:54.626Z",
  "settledBy": "judge"
}
```

Across the 300 newest closed Issues of this repo (2026-11-17), 24 Decisions were answered: 21 by the Judge, 3 by a default, none by the owner.

**Example files:**

- [`decision.ts` L9-L17](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/checkpoints/decision.ts#L9-L17): the four steps and who may settle.
- [`decision.ts` L203-L217](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/checkpoints/decision.ts#L203-L217): `guardVerdict`, the factory's checks on an answer.
- [`decision.ts` L227-L273](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/checkpoints/decision.ts#L227-L273): `JudgeInput`, what the workflow is given.

## Specs and artifacts

An artifact is what a lead hands to a person. A Concept and a Spec wait for a verdict, a Report never waits, and a Decision is answered, not judged.

- **Verdicts.** Looks good, With notes, Changes, No longer applies.
- **His delegate may give a Spec's verdict for him.** The orchestrator (the owner's planning session) calls `factory artifact verdict` with its own token on a Spec that is no owner gate; a Concept, a Report and a gate stay his alone. It is recorded as `orchestrator`, shown as "By your delegate", and left out of the verdict KPI and the retro's taste. The lead hears who gave it. The owner reopens it by giving his own verdict on the same revision: that replaces the delegate's, clears its "needed me" mark, and the lead hears one more note. Annotations and the "needed me" mark stay his alone.
- **Annotations are anchored.** The owner comments on a quote of one revision, with the occurrence he selected and the text around it, so a sentence that stands three times is painted at the one he chose, and stays there when a later revision adds text above it. If the quote is gone from a later revision, the comment moves to "Unanchored". A comment can hang on a picture instead (a screenshot, a diagram), optionally at a spot on it: it follows the picture by its source, then its caption, so a revision that reorders the pictures keeps each comment on its own.
- **Every annotation is answered.** The lead replies `applied`, `deferred` or `declined`. A deferral names the Issue or signal it filed, and a decline gives its reason. A deferral or decline without that detail is refused.
- **A revision after Changes always reaches the owner.** The owner asked for it.
- **24 hours, then the defaults.** A Spec or Concept with no verdict after 24 hours gets a verdict of Looks good from the factory, with a note. The lead goes on with the defaults it named, and the owner can still overrule them with a note. A Spec whose Issue closed or moved on is withdrawn instead. No second push is sent, because it would fall on the same hour as the default.

<!-- snippet: apps/server/src/app/checkpoints-reviews.ts lookAtReview -->
```ts
export function lookAtReview(input: { wait: ReviewWait; closed: boolean; waiting: boolean }): Look {
  const { wait, closed, waiting } = input
  if (closed || !waiting) {
    return {
      outcome: 'withdrawn',
      reason: closed ? 'the Issue is closed' : 'the Issue no longer waits for this review',
    }
  }
  return {
    outcome: 'defaulted',
    reason: `no verdict in ${SPEC_WAIT_HOURS} hours: the lead goes on with the defaults the ${wait.kind === 'spec' ? 'Spec' : 'Concept'} names`,
  }
}
```

issue_1797 is this guide. Its Spec went through the whole cycle on 2026-11-17 (`factory artifact show`, trimmed):

| At | Event |
|-|-|
| 03:34:55 | Revision 1 handed over |
| 07:20:57 | Verdict on revision 1: Changes, with four annotations |
| 07:24:38 | Revision 2 handed over, 3 minutes 41 seconds later |
| 07:24:47 | Spec screen: passed by rule, "a revision the owner asked for with his verdict of changes" |
| 07:41:19 | Verdict on revision 2: With notes, with three annotations |

Two of revision 1's annotations and the lead's replies:

> **Owner**, on "VitePress": Hmm not rather Astro with BasaltUI tokens or even MDX then or some proper guide framework etc.?
>
> **Reply, applied**: Basalt look adopted … So the default stays VitePress, a docs framework that does all three natively, and Starlight with the same tokens is open choice 1 with its cost.

> **Owner**, on "archify": Basalt UI should have a archify theme we probably want to create it
>
> **Reply, deferred**: Filed as [an Issue of repo-a] … The guide's five diagrams use it; the diagram step waits for [it], the chapters do not.

The other two were the address, applied, and Markdown that renders the same on GitHub, applied from the start instead of "eventually". Revision 2 drew three more: one declined, with the reason that a 404 on `<name>.github.io` means the organisation published no site and not that the name is free.

**Example files:**

- [`artifact.ts` L28-L33](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/checkpoints/artifact.ts#L28-L33): the verdicts, and which kinds wait for review.
- [`artifact.ts` L102-L125](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/checkpoints/artifact.ts#L102-L125): the three dispositions and the note a deferral or a decline cannot go without.
- [`checkpoints-reviews.ts` L23-L41](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/app/checkpoints-reviews.ts#L23-L41): what a Spec that waited its 24 hours becomes.

## Errands

An Errand is something only the owner's hands can do: a portal step, a device run, a 1Password prompt.

- **A stated need.** The lead raises it with `--need secret|hands|place`, and what it `tried` before asking. A call without either is refused.
- **Secret, hands, place.** `secret` is 1Password, a biometric or a password and only the owner has it. `hands` is a device, a portal or a physical step. `place` must run on the owner's MacBook with no secret. A fourth, `approval`, is found by rule: the owner's yes, with the command run on the mini.
- **A check closes it.** An Errand may carry a shell command that exits 0 while it is still needed. The `errands` loop runs it every hour with no model. An exit of 1 to 125 closes the Errand as not needed, and a command that could not answer keeps it open.
- **Turned away.** An Errand that asks a person for what the host does for the lead never reaches the owner. A refusal at raise costs the lead one refused call, and one at the screen costs the Issue its wait. The rules look first, then the `factory-errand` workflow.
- **Never a review.** A request to approve one's own pull request is no Errand. The lead defers on the review instead.

<!-- snippet: apps/server/src/domains/errands/errand.ts refuseHostClass -->
```ts
export function refuseHostClass(input: ErrandRaised): string | null {
  const text = `${input.summary}\n${input.detail ?? ''}`.toLowerCase()
  const tried = input.tried.toLowerCase()
  for (const host of HOST_CLASSES) {
    if (!host.names.test(text) || host.settledBy?.test(tried) || host.settled?.(input)) continue
    return `an Errand is for a person's hands, and ${host.name} is not: ${host.route}. Nothing was raised.`
  }
  return null
}
```

It turns away four classes: a door token or route, an install, a sudo step the lead can avoid, and a Report that does not show in Needs you. The last is a defect of the factory, not a person's hands, and the route it names is a signal.

issue_1714 closed that gap by rule. It was filed on 2026-11-16 at 20:42 as "An Errand that needs neither a secret nor the owner's hands never reaches him: run it by rule or refuse it". It closed done at 23:55 (`feat(errands): decide an Errand by rule before it reaches the owner`).

**Example files:**

- [`errand.ts` L37-L78](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/errands/errand.ts#L37-L78): `readErrand`, the need and `tried` it requires.
- [`errand.ts` L92-L137](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/errands/errand.ts#L92-L137): the classes of work the host does, and the refusal.
- [`need.ts` L3-L14](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/errands/need.ts#L3-L14): the four needs and where each shows.

## Screens

A screen is the check a checkpoint passes before it reaches the owner. Rules go first, and a workflow takes what they cannot decide.

- **The Spec screen.** On 2026-11-14 the owner said most Specs reaching the owner could have been decided by their lead: 12 looks good and 16 with notes against 3 changes in 14 days. The rules decide what they can. Then the `factory-spec-screen` workflow reads the Spec with the owner's newest "needed me" marks as precedents. It passes what is the owner's: a UI screen the owner has not seen, product direction, spend, security policy, other people's data, a change that cannot be undone. It settles the rest as Looks good with its reason, so the lead builds at once.
- **Rules first.** A revision after a verdict of Changes passes. A Spec its filer attached passes. A Replan that changes no plan row and cancels nothing is settled.
- **Fail toward the owner.** A screen that cannot be reached passes the Spec after its last try, so a broken screen costs the owner a read and never a Spec the owner should have seen.
- **The held-signal screen.** The Judge looks at a held signal, outside text the factory did not trust enough to turn into work, and promotes it, dismisses it with a reason, or leaves it held with a recommendation. A signal is screened once, and a failed call is retried five times at most.
- **The Errand screen.** The rules and workflow under Errands.

<!-- snippet: apps/server/src/domains/checkpoints/spec-screen.ts screenSpecByRule -->
```ts
export function screenSpecByRule(input: RuleInput): RuleOutcome | null {
  if (input.revision > 1 && input.earlier.includes('changes')) {
    return { outcome: 'passed', reason: 'a revision the owner asked for with his verdict of changes' }
  }
  if (input.origin.gate) {
    return { outcome: 'passed', reason: 'an owner gate: only the owner gives its verdict' }
  }
  if (input.origin.filedSpec) {
    return { outcome: 'passed', reason: 'its filer attached it with the Issue for the owner to review' }
  }
```

The first rule is the one the screen of issue_1797's revision 2 cited in the table above. The cost of getting a screen wrong is counted. `factory read friction --format json`, 2026-11-17, the group `avoidable_touch` over 7 days, trimmed:

```json
{ "key": "touch:decision_answered", "label": "Decisions the owner answered that were not worth asking", "count": 5 }
{ "key": "touch:noted", "label": "Notes the owner sent to a lead", "count": 58 }
{ "key": "touch:woken", "label": "Waits the owner woke by hand", "count": 2 }
{ "key": "touch:cancelled", "label": "Issues the owner cancelled", "count": 11 }
{ "key": "touch:reopened", "label": "Issues the owner reopened", "count": 0 }
```

An avoidable touch is a touch the factory should have settled. A verdict on a Concept or a Spec, the first note of a filing and a done Errand are not counted.

**Example files:**

- [`spec-screen.ts` L13-L24](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/checkpoints/spec-screen.ts#L13-L24): why the screen exists, and its failure mode.
- [`spec-screen.ts` L88-L120](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/checkpoints/spec-screen.ts#L88-L120): `screenSpecByRule`, the deterministic first look.
- [`spec-screen.ts` L122-L141](https://github.com/jkrumm/software-factory/blob/master/apps/server/src/domains/checkpoints/spec-screen.ts#L122-L141): the checks on the workflow's answer, and the scrubbed content it reads.

**Read more:**

- [Checkpoints](https://github.com/jkrumm/software-factory/blob/master/docs/architecture.md#checkpoints) in `docs/architecture.md`.
- [Where the owner comes in](https://github.com/jkrumm/software-factory/blob/master/docs/language.md#L79-L112) in `docs/language.md`.

Next: [Loops](./loops.md)
