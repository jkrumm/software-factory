# Audit: the judgment calls the factory delegates to agw

Scope: software-factory (SF) `apps/server/src/adapters/agw`, the ports and request builders that feed it, and the agent-workflows (AW) `factory-*` workflows and capabilities they call. Read-only; nothing was run except `rg`, `git`, `jq`, `sed`, `agw schema --index`/`agw routes`. Live data: `snapshot/data-*.json`. AW paths are relative to `agent-workflows`: capabilities in `packages/capabilities/src/capabilities` (cap/), workflows in `packages/host/src/workflows` (wf/), routes in `packages/routes/src/table`.

## 0. Ranked findings (gain / risk)

| # | Finding | Lands in | Size | Risk |
|-|-|-|-|-|
| 1 | Five AW workflows turn a model failure into a "successful" neutral answer; SF's retry machinery never sees it and stores the neutral answer as final | both | S+S | med |
| 2 | The 72 h "final look" of factory-screen reuses the idempotency key of the first look with a different input (agw refuses: IdempotencyConflict) | SF | S | low |
| 3 | The errand screen request packs facts into a capped prose field; three fixes in 43 min; type the fields, move the MacBook fact into the prompt, delete the room arithmetic | both | M | low |
| 4 | Standing-policy step: 0 settles, no rules authored anywhere; a stand-in file adapter outlived its package | SF | S then M | low |
| 5 | Queue workflow produces `drop` edges that SF's schema strips; the queue and triage-settle both propose `after` edges | AW (S), then decide | S | low |
| 6 | Two identical call ledgers (`loop_calls`, `queue_asks`), six retry schemes, eleven 10-line adapters and twelve one-method ports | SF | M | med |
| 7 | The digest workflow: an LLM summary of titles the Console could list; own eval scores faithfulness 0.22 | both | M | low-med |
| 8 | AW reason schemas: 5 workflows still use a strict max(300) schema that triggers a billed re-ask, 5 use the shared clip-in-code helper | AW | S | low |
| 9 | Recheck smuggles instructions and events into data fields of workflows that do not know they are being rechecked | both | M | med |
| 10 | Judge precedents: `worthAsking` is a dead channel; precedents include the Judge's own and default answers | SF (+AW prompt) | S | low-med |
| 11 | Contract drift: the two fixture copies already differ; 4 of 11 workflows have no shared fixture; no version handshake | both | S | low |
| 12 | Two keyword vocabularies and two rule modules decide "hands" for an Errand; the KPI that compares rules to the Judge cannot see raise-time refusals | SF | S | low |
| 13 | Legacy `factoryAskInput` shape of factory-ask (old core) still accepted | AW | S | low |
| 14 | Guards exist twice: 10 `guard*` in AW, ~9 `check*` in SF on the same answers | both | L | med (not proposed now) |
| 15 | Steward raises a Decision that the Judge then answers: two model calls to pick wake vs drop (needs data first) | both | M | med |

## 1. Inventory: every factory -> agw call

All calls go through one port (`adapters/agw/port.ts:105-170`): `agw <workflow> --format json --idempotency-key <key>`, input on stdin, exit 10 = pending then `agw run wait <runId>` in a loop, output checked against the call's zod schema. Only limit: an idle watchdog `AGW_IDLE_MS` = 10 min (`kernel/agw.ts:28`), process-group kill, 500 ms pipe grace; lease for a claimed call `AGW_CALL_LEASE_MS` = 35 min (`kernel/agw.ts:35`). Failure kinds: `timeout` (silent), `gone` (non-zero exit or run not `done`), `unreadable` (no envelope, output does not parse). AW side: one re-ask on bad JSON (`MAX_ATTEMPTS = 2`, `packages/capabilities/src/llm/model-call.ts:35,297`), one provider-balance/outage fallback route.

| Caller (SF) | Workflow | Decides | Input and caps | Answer schema | AW route | On failure in SF |
|-|-|-|-|-|-|-|
| `app/checkpoints-settle.ts:196` judgeStep (and recheck `app/checkpoints-recheck.ts:308`) via `adapters/agw/judge.ts` | factory-ask | A lead's Decision: owner or answer | `JudgeInput` fields each cut to 2000 (`domains/checkpoints/decision.ts:265`), at most 5 precedents (FTS, `adapters/postgres/checkpoint-store.ts:532`); AW refuses over 20 000 facts | `JudgeVerdictWire` {verdict, answer, reason, source}, no length limits (`packages/contract/src/loops.ts:41`) | factory.ask = HARD (Sonnet medium) | `JUDGE_MAX_TRIES` 3 (`kernel/judge-tries.ts:2`), 5 min backoff, then owner is paged unjudged. But see finding 1: AW never fails, it answers `owner` |
| `app/checkpoints-errands.ts` screenErrand, rescreen (desk), recheck via `adapters/agw/errand.ts` | factory-errand | Errand: pass or turn_away | `detail` max 4000 in SF (`packages/contract/src/checkpoints.ts:578`, `domains/checkpoints/errand.ts:33,370`); AW takes 8000 (`cap/factory-errand.ts:22`) | `ErrandScreenAnswer` {verdict, reason<=300, need?}; AW emits only {verdict, reason} | EASY (Haiku high) | 3 tries, 5 min, then reaches owner unscreened |
| `app/checkpoints-specs.ts:175` via `adapters/agw/spec-screen.ts` | factory-spec-screen | Spec: owner's to read or lead's | content cut at 20 000 with a "[cut: n more]" note (`domains/checkpoints/spec-screen.ts:139`), 12 precedents (marks) | {pass or settle, reason<=300} | EASY | 3 tries, 5 min, then passed to owner |
| `app/loops/errands.ts` (daily, per pass limit) via `adapters/agw/errand-needed.ts` | factory-errand-needed | Standalone request still needed? | detail 4000, command 2000, evidence 4000 | {needed, not_needed, unsure; reason}; closes only on not_needed | EASY | retry after 6 h (`NEEDED_RETRY_MS`) |
| `app/intake.ts:721` via `adapters/agw/amend.ts` | factory-triage mode amend | Does a signal belong to an open or just-closed Issue | text 8000, 40 candidates x 500, 20 settled | `TriageAnswer`; SF re-checks every id (`amend.ts:6-9,48-62`) | EASY | synchronous request path, 8 s wait (`app/intake.ts:111`), late or failed: file anew |
| `app/loops/triage.ts` (PASS_LIMIT 20) via `adapters/agw/steward.ts:13` | factory-triage mode settle | Edges, kind, size, owes-a-Spec | text 8000, 40 candidates, 12 precedents (note 2000) | `TriageAnswer` | EASY | `planCall` rounds, then settled with no edges after `FACTORY_SETTLE_TIMEOUT_MS` |
| `app/loops/steward.ts` via `adapters/agw/steward.ts:7` | factory-steward | What a stalled Issue needs: wake, requeue, raise_decision, none | detail 4000, 20 notes x 500, 40 history lines x 500 | `StewardAnswer` incl. a full Decision form | EASY | `MAX_ROUNDS` 3 (`domains/loops/stall.ts:412`), then `fallbackDecision` (stall.ts:427) |
| `app/loops/queue.ts` via `adapters/agw/queue.ts` | factory-queue | `after` edges and a tie-break order of a repo's queue | 40 issues, title 500, summary 600 | `QueueAnswer` {edges, order, reason}; AW also emits `drop` | EASY | `ASK_LIMIT` 3 per pass, `minGapMs` per repo, one ask per queue shape (`app/loops/queue.ts:61,179`) |
| `app/loops/screen.ts` via `adapters/agw/screen.ts` | factory-screen | Held signal: promote, dismiss, leave | text 8000, 40 issues, 60 projects (`domains/intake/screen.ts`) | `ScreenAnswer` | EASY | `MAX_SCREEN_ATTEMPTS` 5, backoff 10 min doubling to 6 h, batch 10, pass at most every 10 min |
| `app/loops/digest.ts` via `adapters/agw/digest.ts` (workflow string is the two words `factory digest`, every other adapter is hyphenated) | factory-digest | Per-project summary bullets, every 3 h when the input hash changed | 100 done, 60 open, titles 200 | `DigestAnswer` (strict) | FAST (Haiku, no thinking) | stores nothing, asked again next pass |
| `app/loops/fix-classes.ts` via `adapters/agw/fix-classes.ts` | factory-fix-classes | Fix commits the rules cannot class | batch 40, body 800, 20 paths | `FixClassesAnswer`; answer checked against the request | EASY | batch left for next pass |
| `app/loops/hygiene.ts` via `adapters/agw/hygiene.ts` | factory-hygiene | Stale or slop findings in docs (agent step with read tools over a checkout) | 20+20 candidates, `max` findings | `HygieneAnswer` | EASY.agent on opencode | retry after `hygieneRetryMs`; 179 passes in 7 days (`data-loop-yield.json`) |

Not agw calls although the brief lists them: `app/loops/desk.ts`, `app/loops/reviews.ts` (no `agw`/`Workflow` reference; `rg` over both). `adapters/quality/review.ts` uses `agw review prepare/submit`, host operations with no model (AW AGENTS.md "Review v4").

**Budget.** There is none for model calls. `domains/loops/budget.ts` is one constant, `MAX_SIGNALS_PER_PASS = 5`, a cap on signals *filed* by friction, hygiene, selfwatch and throughput. `domains/loops/caps.ts` is the lead-cap-binds finding (project.yaml `leads:`), nothing to do with agw. What limits calls is per-loop pass limits and backoffs (table above). The money is small: AW's own measure is $0.0105 for a 14-case steward run, $0.006 for queue's 10, $0.0032 digest's 9 (`docs/evals/2026-11-16-factory-decision-suites.md`). The claim/lease/backoff machinery therefore protects against double *effects* (a second promote, a second page), which the effect keys already cover, not against spend.

## 2. Deterministic first: how much is decided before the workflow

| Call | Rules before it | Verdict |
|-|-|-|
| steward | `decideStall` (`domains/loops/stall.ts:91`): too young, wall window open, a note arrived, move seat, 2 wakes for unreported, same-stall repeat/hold. Only the rest is asked | good |
| triage settle | `settleRule` (`domains/loops/settle.ts:45`): incident, alert-filed, stated edges, nothing open: settle now | good |
| fix-classes | `ruleClass`, model only for the rest | good, the pattern to copy |
| queue | cycle check, <2 candidates, shape already asked, gap, budget; edges then re-checked by `checkQueue` | ok; edges' value is measured (finding 5) |
| spec screen | `screenSpecByRule` (`domains/checkpoints/spec-screen.ts:96`): revision after "changes", owner gate, filer-attached, no-op Replan | ok, 4 rules |
| errand screen | at raise: `triage()` (`domains/checkpoints/triage.ts`: declined, bot check, keyless, off-macbook, empty place, unroutable, MacBook verbs); before the Judge: `screenByRule`, `screenByNeed`, `screenByReview` (`errand.ts:~270-365`) | many rules, but see below |
| held-signal screen | the intake gate (`domains/intake/rules.ts`) decides who may file; nothing before the Judge for a held signal beyond "work repo waits for owner" (`app/loops/screen.ts:~60`) | thin |
| Judge | one rule step: `policyStep` (`app/checkpoints-settle.ts:155`) | effectively none |

**Policy: "0 settled by standing policy" is unused, not unreachable.** The path is wired: `settleDecision` runs `[policyStep, judgeStep, defaultStep]` (`app/checkpoints-settle.ts:102`), rules come from the stored project's `policy:` (`app/planning-policies.ts:11-18`, schema `packages/contract/src/project-file.ts:804`), `matchPolicy` is a case-insensitive substring of the question plus an answer that must equal an option (`domains/checkpoints/decision.ts:193-201`). `rg '^policy:'` over every `~/SourceRoot/*/project.yaml` and software-factory's own file finds no rule, and there is no verb that writes one: the owner would have to hand-edit YAML with a phrase that occurs in a future question. The Judge has taken the whole role (45 settled, `data-friction.txt`), seeded by owner answers through the precedent query. A stand-in `fileStandingPolicies` (`adapters/checkpoints/policies.ts`, comment "until package 3") is still wired for one scenario test (`tests/scenarios/checkpoints/checkpoints.test.ts:83`, `main.ts:18,335`, `checkpoint-settings.ts:10,15,36`, `scripts/env-file.sh:18`).

**Errands: 1.9 % by rule vs 26 % by Judge is not a measurement of rule strength.** `errandCounts` (`read/kpis-flow.ts:150-158`) counts only rows in `factory.errands` with an Issue. Everything `triage()` refuses at raise time ("Nothing was raised") never becomes a row, so the dominant rule path is invisible and the denominator excludes it. What the data does say: 15 of 54 raised were turned away, 14 of them by the Judge; 11 of 77 that reached the owner needed neither a secret nor hands (`errands_no_secret_no_hands`, 14 %), which the KPI itself calls a missing rule. And the Judge was wrong where it lacked a host fact: the MacBook `make deploy` turned away with "run it over ssh" (commit f5dbe639), the mini sudo password (`need.ts` comment: "the screen model does not know that policy"). The right split is: facts about where a command can run and what a secret is belong in rules (they are), judgments about "is this worth a minute" stay with the model; the 14 judge turn-aways are the corpus for the next rules. Mine them with the existing replay (it replays rules only, `scripts/errand-replay.ts`, `domains/checkpoints/triage-replay.ts`) extended to rows with `screen_by = 'judge'`.

## 3. Overlap and request builders

**Same question, several prompts.** "Is this the owner's?" is answered by factory-ask (taste/product, spend, irreversible, other people, security policy, only-the-owner action; `cap/factory-ask.ts:~190`), factory-spec-screen (UI/look, product, spend, security policy, other people, cannot be undone, materially different defaults; `cap/factory-spec-screen.ts:~110`), and, with a different lens, factory-errand ("worth the owner's time") and factory-triage's `checkpoint: spec`. The list is also restated in SF `packages/contract/src/filing.ts:65`, `checkpoints.ts:635`, `docs/language.md:103,215`. All ten capabilities already share the fence skeleton (`prose-prompts.ts`: `untrustedPreamble`, `fencePreamble`, `fencedBlock`, `endOfData`), so the skeleton is not the duplication; the **owner-class text is**. Proposal: one exported `OWNER_CLASS` fragment in AW used by ask and spec-screen (S). Do not merge the workflows: inputs and outputs differ (Decision with typed options, Spec page with marks, Errand with command).

Real overlaps worth acting on:
- **`after` edges proposed twice**: factory-triage settle (`cap/factory-triage.ts`, at filing) and factory-queue (`cap/factory-queue.ts`, per queue shape). The factory already distrusts both: a source with >=10 measured edges and >60 % not needed gets no new edges (commit 0b96072c, `domains/loops/edge-need.ts`). Decide with the Improve screen's per-source edge-need figure (not in the data set; unverified), keep one.
- **"Still needed?" asked three ways**: factory-errand with events stuffed in (recheck), factory-errand-needed (daily, standalone requests, evidence of the same source's other requests), and the desk rescreen. See finding 9.
- **Steward then Judge**: factory-steward's `raise_decision` builds a full Decision form (`cap/factory-steward.ts` `stewardDecision`) that factory-ask then answers. The Judge eval set (`docs/evals/2026-11-11-factory-ask-judge.md`) says steward Decisions were sampled "from 94" and are "operational, any answer is right". If most Judge-settled Decisions are steward-asked (query: `factory.decisions` by `asked_by` x `settled_by`, not run), the 45 Judge settlements are mostly a model answering a model.
- **Adapters and ports**: eleven `adapters/agw/*.ts` of 10 lines each, twelve one-method port interfaces (`domains/loops/ports.ts:437-462`, `domains/checkpoints/ports.ts:487-502`, `domains/intake/ports.ts:221,233`), five different method names (`ask`, `screen`, `judge`, `digest`, `settle`) for one concept. `JudgeInput` (`decision.ts:~250`) hand-duplicates `JudgeInputWire` (`contract/loops.ts:15`).

**The three "screen request" fixes (06bcc71b, f5dbe639, 9ba3034a), 08:37 to 09:20 on 2026-11-20, all in `app/checkpoints-errands.ts`.** f5dbe639 appended a static MacBook paragraph to `detail` after the 4000 cut; 06bcc71b reserved room for it (`4000 - MACBOOK_FACT.length - 1`) because a long detail pushed it out; 9ba3034a found the recheck path built `detail` separately (`recheckErrandDetail`) and merged the three into `errandScreenDetail` (`domains/checkpoints/errand.ts:391`). The weakness is structural, not three slips:
1. Facts are packed into one prose field whose cap is the contract's: `ErrandScreenRequest.detail` max 4000 (`contract/checkpoints.ts:578`) equals the raise-time cap of the lead's own detail (`errand.ts:33`), and the request then adds command, host, events and a 600-character fact on top, so everything is cut to fit. AW accepts 8000 (`cap/factory-errand.ts:22`): half of the headroom is unused.
2. The MacBook rule is an instruction placed *inside the untrusted fence* (`cap/factory-errand.ts` `buildFactoryErrandPrompt` fences `Errand detail`; the preamble says nothing in the block changes the rules). Policy belongs in the prompt next to the existing sudo paragraph (`factory-errand.ts:~70`), keyed by a typed `host`.
3. Three builders, one cap, no schema field for `command`/`host`/`events`, though factory-errand-needed already has `command` and `host` as fields (`cap/factory-errand-needed.ts:41-44`).
Same pattern for decisions: recheck appends events to `checked` after slicing it to 1200 (`domains/checkpoints/recheck.ts:155`), cutting the lead's own evidence.

## 4. Prompt and schema quality; idempotency

- **Failure semantics differ per workflow, silently** (finding 1). Fail-closed inside AW (catch `StepFailed`, return a valid neutral answer): factory-ask (`wf/factory-ask/index.ts:49` verdict owner, reason "judge unavailable: <kind>"), factory-triage (`index.ts:37`), factory-steward (`index.ts:51`), factory-queue (`index.ts:38`), factory-hygiene (`index.ts:63`). Fail-the-run: factory-screen, spec-screen, errand-needed, errand ("It does not fail closed: a failed call fails the run, because the factory records a failed call with a backoff and retries", `wf/factory-errand/index.ts`). The factory never reads the "unavailable" reason (`rg unavailable` in `apps/server/src` hits only HTTP 503 helpers). Consequences, all from the code: a model outage makes the Judge answer `owner`, so `judgeStep` records `passed` and pages the owner on the first failure, the 3-try/5-min machinery (`checkpoints-settle.ts:241-245`, migration 0980) is only reachable by process failures; a queue outage is stored as an *answered* ask for that shape and the shape is never asked again (`shapeAsked`, `app/loops/queue.ts:~175`); a triage-settle outage settles the Issue with no edges for good; steward `none` x3 raises the factory's own fallback Decision.
- **Reason schemas**: five capabilities use `rawReason` + `clipReason` (240, clip in code, "a model that writes 300 characters is never re-asked"; `cap/one-line.ts:1-12`), five (errand, spec-screen, errand-needed, screen, digest) still declare `z.string().max(300)` as the model's schema and each redefines `oneLine` (`factory-errand.ts:51`, `factory-spec-screen.ts:78`, `factory-screen.ts:68`, `factory-errand-needed.ts:61`, `factory-fix-classes.ts:30`). A 301-character reason is a billed re-ask or a failed run.
- **Output the factory ignores or never receives**: queue `drop` (AW `cap/factory-queue.ts:71,93,116`: "the factory checks every drop against its own record") is not in SF's `QueueAnswer` (`contract/loops.ts:193-200`, no `drop`; zod strips it); SF's edge take-back is the deterministic sweep (commit 0b96072c, `app/loops/queue.ts:263`), `rg '\.drop|drop:'` in SF src finds nothing. In the other direction `ErrandScreenAnswer.need` (`contract/checkpoints.ts:591`, consumed at `errand.ts:422`) is never emitted: AW's answer is "{verdict, reason}, nothing else" (`wf/factory-errand/README.md`), so `need` is always null on the Judge path. The prompts return JSON fields only; there is no place where the factory regexes prose (checked `amend.ts`, `checkScreen`, `checkSpecScreen`, `checkErrandScreen`, `checkAnswer`).
- **Prompts**: instructions are specific, have a fail-closed default sentence each ("when unsure, owner/pass/leave"), a fenced untrusted block with per-call nonce, and a repeated contract after the data. Weaknesses: no worked examples in any prompt (14-17 eval cases exist but are not used as few-shot); `factory-ask` has accreted exception clauses (the "default" section, `cap/factory-ask.ts:~215-235`) after incidents, which is how it will keep growing; factory-ask's `source` is a free string with a convention (`default | plan: .. | facts: .. | precedent: ..`) that SF only checks for non-empty (`guardVerdict`, `decision.ts:231`).
- **Idempotency**: AW's contract is "same (workflow, key) is the same run, a different input under the same key throws `IdempotencyConflict`" (`packages/runtime/src/runtime.ts:303-306`). So the key must determine the input.
  - factory-screen: `key('screen', row.id, attempt)` (`app/loops/screen.ts:97`). A `leave` is recorded with `...row.screening` (`screen.ts:~104,128`), attempts unchanged. The 72 h final look (`isFinalScreen`, `screen.ts:94`) sends `final: true` and the current open Issues under the same key, so it collides with the first look unless an earlier call failed. Effect: one failed call (counted in `attempts`), a 10-minute backoff, then it works with `attempt+1`. Unverified live; check the AW journal for factory-screen runs with an idempotency error.
  - factory-ask: `key('factory-ask', id, tries, formDigest)`; a lease-lapse retake (35 min) rebuilds precedents from the live ledger (`checkpoints-settle.ts:200-209`), which can differ, same conflict, rare.
  - amend: the key digests signal text and settled ids but not the candidate list (`amend.ts:~44`).
  - A replayed pass does not pay twice when keys are stable: `loop_calls`/`queue_asks`/`decision_steps` store the answer and the claim; a retake carries the same key.
- **Retry stacking**: one Decision can cost 3 factory tries x 2 AW attempts (+ a fallback route) = up to 6 model calls, and a screen up to 5 x 2. Cheap, but it is why nothing here is a budget.

## 5. Feedback and replay

| Workflow | Outcome signal in SF | Fed back? | Replay or eval |
|-|-|-|-|
| factory-ask | owner answers, `recommendation_taken` 2/5 | precedents via `to_tsquery` over question words, owner rows first (`checkpoint-store.ts:532-540`); `worthAsking` "needed a click the owner never gave" (`read/kpis.ts:670` targetSource) so always null | AW `packages/eval/factory-ask/cases.jsonl`, 34 cases built from the live ledger, measured (Haiku none 78 %, Sonnet medium 84 %); the one workflow tuned on live data |
| factory-spec-screen | owner's "needed me" marks, `specs_not_needed` 5/95 | yes, 12 newest marks as precedents (also into triage settle) | 17 cases, scored runs of 2026-11-16, hand-written |
| factory-triage settle | `needed` on specs with source triage; edge-need per source | marks as precedents; edge-need stops a source (rule) | 16 cases |
| factory-errand | none: "what reached him and he found needless is his word, not counted" (`kpis-flow.ts:344`) | no | 14 cases, "no scored run recorded in the journal" (`routes/table/factory.ts` comment); SF replays only the rules |
| factory-errand-needed | none | no | 14 cases, no scored run recorded |
| factory-screen | owner acts on left signals | no | 14 cases, no scored run recorded |
| factory-steward | `nudges_acted` 80/143 = 56 % (but that KPI measures the *idle nudges*, a rule path (`decideIdle`), not this workflow) | no | 14 cases, 76 % per action |
| factory-queue | edge-need (shared files of both shipped Issues) | as a stop rule only | 10 cases, 9/10, order unscored |
| factory-digest | none | no | 9 cases; judged faithfulness 0.22 |
| factory-fix-classes | none | no | 9 cases (30 commits), 25/30 |
| factory-hygiene | `classes` noise share (`data-finding-classes.json`: cochange 10/10 noise, held) | held classes, a rule | 3 cases |

Judge self-reinforcement: the precedent query filters only `answered_at IS NOT NULL` (`checkpoint-store.ts:534`), so Judge-settled and default-settled Decisions are precedents for later Judge calls; with 45 judge settlements to 5 owner in 7 days, the five slots are mostly the model's own earlier answers, only ordered after owner rows. SF's replay tooling (`scripts/errand-replay.ts`, `triage-replay.ts`) is deterministic rules only, no workflow is replayed against recorded outcomes on the SF side.

## 6. Contract drift

The mechanism is one JSON fixture mirrored by hand: `packages/contract/fixtures/loops.json` (+`fix-classes.json`) here, `packages/host/test/fixtures/software-factory-loops.json` there; `apps/server/test/loops/wire.test.ts` header says "the same bytes are parsed in agent-workflows". They are no longer the same bytes: a `jq -S` diff shows an `errand` section only in AW, `drop: []` and `settled: null` in AW's outputs only, different hygiene and triage examples. Covered: ask, steward, triage, queue, screen, hygiene (+fix-classes). Not covered by any shared example: errand (AW-only), spec-screen, errand-needed, digest. There is no schema version, handshake or startup check; SF's zod objects strip unknown fields, so an extra field added in AW (`drop`) is silent, and a missing one (`need`) is silent too. AW workflows carry a `VERSION` string (e.g. `2026-11-14.1`) that the factory never reads. AGENTS.md allows the dependency direction factory -> agw, and AW already has `toJsonSchema` and `agw schema`; neither is used for a check.

## 7. Findings in detail

### F1. Failure semantics are decided per workflow inside AW; SF's retry path is bypassed
- What is there: section 4. Five `catch` blocks that return a neutral valid answer (`wf/factory-{ask,triage,steward,queue,hygiene}/index.ts`), four workflows that fail the run. SF's `planCall`, `decision_steps.tries`, queue ledger `failed` outcome and `JUDGE_MAX_TRIES` are written for the second kind.
- Why accidental: two policies for one question ("what happens when the model is down"), the owner of the outcome (SF, which knows whether a neutral answer is acceptable) does not choose; the sentinel `"... unavailable"` string is not parsed anywhere.
- Change: AW removes the five catch blocks (keep `Cancelled`/`InfraError` propagation, guards stay for bad answers), update the five READMEs and tests (`packages/host/test/factory-*.test.ts`), bump versions. SF: nothing for ask/steward/queue/triage (they already map `!ok` to `failed` rounds); check three outcomes: judge after 3 tries pages owner (already), queue failed round retries after `retryMs`, settle falls back to `FACTORY_SETTLE_TIMEOUT_MS`.
- Must not change: owner-class answers stay with the owner; an Issue never waits forever (settle timeout, steward fallback Decision); guards that refuse a bad answer.
- Risk med (an outage now shows as failed calls and longer waits instead of quiet neutral answers; verify the loops' summaries show it). Size S in AW, S in SF.

### F2. Final-look idempotency conflict in factory-screen
- Evidence: `app/loops/screen.ts:94-105`, runtime conflict rule `runtime.ts:303-306`.
- Change: SF: key `('screen', id, attempt, final ? 'final' : 'first')`. One line plus a test that runs two requests with the same attempt through a fake that mimics the conflict.
- Must not change: replays of the same look find the same run.
- Risk low, S. Verify first (unverified): `agw` journal, workflow factory-screen, errors containing "idempotency".

### F3. Errand screen request: type it, move the fact
- Change: AW `factory-errand` input gets `command: string|null`, `host` (same enum as errand-needed) and `events: string|null` (recheck); the MacBook paragraph moves into `INSTRUCTIONS` beside the sudo paragraph, conditional text "when host is macbook"; caps raised to the AW 8000 or kept per field. SF: `ErrandScreenRequest` gains the fields (`contract/checkpoints.ts:575-581`); delete `MACBOOK_FACT`, `SCREEN_DETAIL_MAX`, `errandScreenDetail` and `recheckErrandDetail` (`errand.ts:366-410`, `recheck.ts:158-170`); callers pass fields. Drop `need` from `ErrandScreenAnswer` or have AW emit it (it is dead today).
- Must not change: the first screen, the desk rescreen and the recheck produce the same verdicts on the 14 eval cases plus one new case "macbook make deploy" (must pass); detail still scrubbed.
- Risk low-med, M (two repos, ~-80 lines SF, +30 AW, eval case).

### F4. Standing policy
- Change step 1 (S, SF): delete `adapters/checkpoints/policies.ts`, `FACTORY_CHECKPOINT_POLICY_FILE` (`checkpoint-settings.ts`, `main.ts:18,335`, `scripts/env-file.sh:18`), port the scenario test to a `project.yaml` policy or a fake store. Step 2 (M): choose. Option A, delete `policyStep`, the `policy` Settler, `PolicyRule`/`policy:` key (a retired-key shim, the schema accepts and drops `jobs`/`ticktick` the same way, `project-file.ts:~805-815`), `matchPolicy`, the KPI part and the doc rows. Option B, replace it with a rule that fills itself: an *exact* normalised question (`normalizeQuestion`, `recheck.ts:91`, already exists) plus identical option labels already answered by the owner in the same repo is reused without a call, recorded with `by: 'policy'` and the precedent's id as source. B is the deterministic-first rule the Judge needs before it; I lean to B (the data: owner settled 5 in 7 days, so exact repeats are plausible but the count is unverified; query `factory.decisions` by normalised question).
- Must not change: an irreversible option is never taken by a rule (`guardVerdict`); owner can overrule with a note.
- Risk low, S then M.

### F5. Queue: dead `drop`, overlap with triage edges
- Change: AW removes `drop` from prompt, schema, `none`, guard, scorer and fixture (`cap/factory-queue.ts:71,93,116`), SF unchanged (version bump). Then compare edge-need of source `queue` vs `triage` from the Improve screen and delete the weaker proposer (SF: `app/loops/queue.ts` 305 lines + `domains/loops/queue.ts` 193 + `queue_asks` if queue goes; or triage settle's `after`).
- Must not change: owner `prio` is absolute; chain cycles refused; deterministic take-back sweep.
- Risk low for the `drop` part. S.

### F6. One call ledger, one retry policy, one adapter table
- Evidence: `migrations/0700_loops.sql:5-24` and `0960_queue_asks.sql:6-28` are the same table (key, round, claimed_at, lease_until, outcome answered|rejected|failed, answer, detail, finished_at, `CHECK ((outcome IS NULL) = (finished_at IS NULL))`); `claimRound` (`app/loops/claim.ts:15-45`) and `claimQueueRound` (`app/loops/queue.ts:77-100`) are the same function. Retries: `planCall` (steward/triage), queue ledger, `decision_steps.tries` (`JUDGE_MAX_TRIES=3`, 5 min), `errands.screen_tries`, `spec_screens.tries` (both reuse the Judge constants), `signals.screening.attempts` (5, 10 min doubling), `NEEDED_RETRY_MS` 6 h, hygiene `retryMs`.
- Change (SF only): (a) merge `queue_asks` into `loop_calls` (loop `'queue'`, nullable `issue_id`, `subject = repo|shape`, `applied/refused/after_shape` into one `detail jsonb`; expand then contract migration); (b) `adapters/agw/*.ts` to one `workflows.ts` table of `{name, answer}` and one `AgwWorkflow<Req,Ans>` function type replacing twelve ports (`ask` everywhere); (c) `JudgeInput` = `JudgeInputWire`; (d) one `RETRY` constants module. Do (b)-(d) first, (a) separately.
- Must not change: replayed pass acts on the stored answer; lease 35 min; no call inside a transaction.
- Risk med for (a) (migration and queue loop), low for (b)-(d). (b)-(d) S each, (a) M.

### F7. Digest
- Evidence: Console strip shows deterministic counts plus three LLM bullet lists (`apps/console/src/components/flow/digest-strip.tsx:~10-50`); `docs/evals/2026-11-16-factory-decision-suites.md`: judged 0.22, "writes 'so customers can see when they will be charged' for Issues whose titles say neither"; loop every 3 h per project (`data-loops.json`), table `project_digests` (migration 1014), route `factory.digest` FAST, `cap/factory-digest.ts` 261 lines, workflow, eval, `kernel/digest-scope.ts`, `domains/loops/digest.ts` 183, `app/loops/digest.ts` 84.
- Change (owner call, tendency delete): bullets become titles: Shipped = newest closed titles, Next = queued titles, Risks = held and paused reasons already in `DigestIssue.reason`; delete workflow, route, loop, `factory.digest` setting, eval. If the owner values grouped themes, keep and make the judged score a gate.
- Must not change: counts; digest never names an Issue not shown.
- Risk low-med (UI content change), M.

### F8. AW reason handling
- Change (AW): errand, spec-screen, errand-needed, screen, digest move to `rawReason` + `clipReason` (one shared `oneLine` removed 5 times), SF wire stays <=300. Eval each (cases exist).
- Risk low, S.

### F9. Recheck is a different question asked through the first-screen prompts
- Evidence: `recheckPreface` (`recheck.ts:150`) is placed inside `checked`/`detail`, i.e. inside the untrusted fence, with `checked.slice(0,1200)`; the prompts say nothing about a recheck. Candidates are rechecked after 6 h with no owner answer if the Issue got a new event (`recheckDue`).
- Change: AW `factory-ask` and `factory-errand` accept `recheck: { afterHours, events } | null` and carry a short "Recheck" section in INSTRUCTIONS ("settle only if the events show the question moot or answered; otherwise keep"). SF passes it; `recheckJudgeInput`/`recheckErrandDetail` shrink to an events builder. Fold with F3.
- Must not change: a recheck never settles an owner-class Decision (`guardVerdict` still applies).
- Risk med (changes a prompt: needs the 34-case ask eval re-run), M.

### F10. Judge precedents
- Change: SF `precedents()` filter `settled_by IN ('owner','orchestrator')`; remove `worthAsking` from `JudgeInput.precedents` and the AW prompt/schema (keep the DB column, expand-contract later). Keep the 5-slot limit.
- Must not change: owner rows still first; irreversible guard.
- Risk low-med: re-run the factory-ask eval (34 cases include precedents?), unverified. S.

### F11. Contract drift
- Change: (a) re-sync the fixtures now and add examples for errand-needed, spec-screen, digest and errand to SF's `fixtures/loops.json` (S both); (b) make the sync a failing check: SF test reads the AW fixture path from an env var when present (CI in AW checks out SF? no; simpler: both repos print the sha256 of the fixture in `make check` and the verify step compares through `agw`); (c) SF `make verify` compares each request/answer schema with `agw schema <workflow>` JSON (if the `serverOnly` workflows are exposed there; unverified) and fails on a field only one side has; (d) fix the false claim in `contract/loops.ts:5-8`.
- Risk low, S. Do (a) and (d) at once.

### F12. Errand rules: one vocabulary, one KPI
- Change (SF): `HANDS_WORDS` (`errand.ts:241`, 45 words) and `PHYSICAL` (`need.ts:42`, 28 words) into `need.ts`; `screenByRule` calls `namesPhysical`. KPI: a counter for raise-time refusals so the rule share is real (needs a place to record it: unverified whether `api` logs them).
- Behaviour that must not change: `screenByRule` stays conservative: any hands word keeps the Errand.
- Risk low, S.

### F13. Legacy ask shape
- `cap/factory-ask.ts`: `factoryAskInput`, `factoryAskOrJudgeInput`, `isJudgeInput`, `askOfJudge`, "today's ask is the running factory's" comment. `rg` over `~/SourceRoot` (excluding md/docs) finds the factory's `tests/scenarios/loops/loops.test.ts` and AW's own tests as the only users; the old core is gone. Collapse to one shape (AW AGENTS.md: "Remove the old one a release later, once `rg` finds no caller"). Risk low, S.

### F14. Guards in two places (not proposed now)
10 `guard*` in AW `cap/factory-*.ts` against ~9 `check*`/`guardVerdict` in SF `domains/`; the factory re-checks because it is the one that acts and holds the shown ids (`amend.ts` docstring). If one side goes it should be AW's (the factory cannot trust an answer and owns the facts), but AW runs the guards after the step so replays and eval scoring include them. L, leave until F1 and F6 land.

### F15. Steward then Judge
- Needs data first: count `factory.decisions` by `asked_by` and `settled_by` in the last 30 days. If steward-asked Decisions are mostly Judge/default-settled, remove `raise_decision` from the steward's actions (AW: `stewardDecision` ~60 lines, prompt paragraph, `checkShape`; SF: `decision` plumbing in `stall.ts`), keep `fallbackDecision`, and let a steward that cannot choose say `none`. Risk med, M.

## 8. Calls to merge or delete, rules to exist first, replay harnesses

**Merge or delete (marked by repo)**
1. Delete the model-failure catch blocks in five workflows (AW) and let SF own retry (F1).
2. Delete `MACBOOK_FACT`/`errandScreenDetail` room arithmetic by typed fields (SF+AW, F3); delete dead `need` on the errand answer.
3. Delete `drop` from factory-queue (AW, F5); then keep only one of {queue edges, triage settle edges} (decide on measured edge-need; SF+AW).
4. Merge `queue_asks` into `loop_calls` and the eleven adapters/twelve ports into one table (SF, F6).
5. Delete the policy file adapter and env (SF, F4), then replace or delete `policyStep`.
6. Delete the digest workflow in favour of deterministic bullets (SF+AW, F7, owner call).
7. Delete the legacy ask shape (AW, F13); `worthAsking` (SF+AW, F10).
8. Recheck as a typed section of ask/errand instead of data-smuggling; consider routing Errand recheck to errand-needed (SF+AW, F9).

**The rule that should exist before each workflow**
- Judge: exact normalised-question reuse of an owner answer (F4 option B); irreversible-option guard stays.
- Errand screen: "macbook command not one of the three verbs and no mini-side equivalent stated" and the Judge turn-away corpus mined into `screenByRule` words; one vocabulary (F12).
- Held-signal screen: a rule for the 72 h final look that needs no model (`decideFinal` already holds the fallback) and for dismissal of probe-titled signals; today only "work repo" is ruled (`app/loops/screen.ts:~60`).
- Intake amend: skip the call when the fingerprint is already open-matched (done) and, if kept, test QUICK (effort low, `packages/routes/src/table/_shared.ts:74`; Iris eval of 2026-11-20 shows quality held at 2.0 s) because it waits 8 s on a request path and a late answer files a duplicate (`app/intake.ts:111,721`). AW route change, S, needs its own 16-case run.
- Spec screen: already four rules; add "owner marked needed:no for source+repo three times and no owner-class word" only after F10-style data.
- Queue/triage edges: only the deterministic blockers (cycles, same-file) first; the model for the rest, one proposer.

**Replay harness needed, ranked by outcome data already in SF's database**
1. factory-errand (owner turn-backs, desk closes, judge turn-aways, 14 cases not scored): replay recorded Errands through the screen and compare with `screen_by`, `turned_away_at`, owner-declined holds (SF script + AW `agw eval` cases mined from rows). (SF+AW)
2. factory-spec-screen: owner marks `needed_me` on ~95 verdicts are labels; 17 hand cases only. (SF+AW)
3. factory-triage settle (`checkpoint: spec`, size, edges): labels from `needed_me` with source triage and `edge-need`. (SF+AW)
4. factory-screen (held signals): promote/dismiss outcomes of the owner's own later action; 14 cases, never scored. (SF+AW)
5. factory-ask: exists (34 cases from live data); refresh quarterly from `decisions` where owner overruled the Judge. (AW)
6. factory-queue and factory-steward: the labels are weaker (edge-need, nudge outcome); keep hand sets. Digest, fix-classes, hygiene: leave.

## 9. Could not check (unverified)

- Live run journal of agw (the factory workflows are `serverOnly`, not in `agw schema --index`): idempotency conflicts, failure rates, per-workflow cost and latency, how often the 8 s amend wait expires.
- Postgres counts: Judge-settled Decisions by asker (steward share), exact-question repeat rate for owner answers, errands raise-refusal count, per-source edge-need figures, and whether a `needed_me`-style label exists for errands.
- Whether `agw schema <workflow>` exposes the `serverOnly` workflows' JSON schemas (for F11c).
- Whether the factory-ask eval cases include precedents (F10).
- Nothing was edited; `git status` is clean in both repos.
