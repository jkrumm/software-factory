# Golden set — labelling guide

You label the events of one chunk. The labels are the ground truth that three numbers of the
factory design are scored against: grouping quality (B-cubed precision and recall against
*true incident groups*), escalation quality (precision and recall against *genuine owner
decisions*) and known-error matching (against *known fixes*). Pre-registered thresholds:
`PREREGISTRATION.md`. Definitions: `../DEFINITIONS.md`.

Warden's own outcome is evidence, not truth. Its `duplicate_of` can merge unrelated things, its
`closed:resolved` can be wrong, and an escalation tagged `[security]` is not genuine by the
rule below. Label what happened, using the packet and its outcome as evidence.

## 1. What is in a chunk

| File | What |
|-|-|
| `chunks/NN.jsonl` | The packets to label, one JSON object per line, in time order. Label exactly these ids. |
| `chunks/index.json` | Per chunk: time range, event / sampled / context / escalated counts, dev or held-out split. |
| `sample.out.json` | How the set was drawn (strata, weights, seed). Not needed for labelling. |
| `labels/NN.jsonl` | Your output (section 6). The only file you write. |

A chunk holds **sampled** events (`context: false`, drawn by entity-centric sampling: an
entity is one warden item plus its duplicate children) and **context** events (`context: true`:
every other event whose `first_seen` is within 30 minutes of a sampled one, so that you can see
the whole incident around a sampled event, including members warden missed and intruders it
wrongly added). Context events get a full label line like every other event.

A neighbourhood is never split across chunks, except when one burst is larger than a chunk
(`split_burst` in the index). An entity can still have members in another chunk: see
`entity.peers`.

## 2. The packet

| Field | Meaning |
|-|-|
| `id` | Warden event id. The key of your label line. |
| `chunk` | Chunk number NN. |
| `context` | true = pulled in by the 30-minute rule, false = sampled. |
| `sample` | `stratum`, `forced` (escalated, taken whole), `weight`. Null on context events. Ignore it while labelling. |
| `entity` | Warden's own group: `id`, `root` (event id), `size`, `root_outcome`, `escalated` (any member), `peers` (every other member: id, first_seen, source, state, short title, even when it lives in another chunk). |
| `source` | Where the signal came from: `slack_alert` (a message in the alerts channel: Kuma relays, chat), `slack_update` (deploy and update notices), `uk` (an Uptime Kuma monitor that went DOWN), `human` (a brief handed to warden by the owner or an agent), `github_go` / `github_pr` / `github_issue` (GitHub), `hermes_log` (a log-line fingerprint of the Hermes gateway), `job` (a graded launchd job), `hyperdx` (observability alert), others rare. |
| `external_id`, `title`, `payload` | The event itself. `payload` is the informative part of the raw payload (at most 400 characters); a `…` marks free text that continues the title. For `uk` rows `status=0` means DOWN. For `hermes_log` it starts with `log_at`, the log line's own host-local time (UTC+1 or UTC+2). |
| `first_seen` | Start of the **latest episode** (see traps). |
| `event` | `resolved_at`: when warden's poller considered the signal gone (recovery message, state cleared, or silence); null = still open at the as-of time. `reminders`: poller counter. Slack rows also carry `msg_last` (time of the latest message) and, when different, `msg_first` (the first message ever seen for this fingerprint, possibly months older). |
| `item` | The ledger row, or null (see traps). `state`, `close_reason`, `root_cause` (warden's own guess, often `unknown-...`), `duplicate_of`, `occurrences` (sightings this row summarises, from the latest poll), `signature`, `repo` (where warden routed it), `origin`, `created_at`, `last_seen`, `episodes`, `latest_episode_at`, `note` (warden's last card text). |
| `escalation` | Present when the item ever reached `needs_decision`. `n`, `first_at`, `last_at`, `category` (the agent's own claim: product, data_loss, spend, other_people, security, blocker, chronic, no category, or null), `question` (note of the last escalation), `verdict_question` (the investigation's own question when it differs). |
| `transitions` | Strings `at from→to [×n] [\| note]`. `∅` = no previous state; a line starting with `…` says entries were elided; `transitions_total` is the full count. Notes are cut at 120 characters. |
| `dispatches` | Per agent tier (investigate, author, implement, review): `n` runs, `status`, `outcome`, `conf`, `next` (the verdict's next action: none, issue, implement, human), `failed`, `text` (`Q:` decision question, `rc:` root-cause key, `PR:` pull request title, `S:` summary). |
| `fix_commits` | Commits and pull requests linked to the item: `repo`, `sha`, `subject`, `date`, `via` (`merged_sha`, `merge_receipt`, `pr_subject`: the item's own merge; `note`: a commit named in a fix-worded note; `pr_url`: a PR with no resolvable commit), `rel` (`before_episode` = dated before this event's `first_seen`, `after_episode`, `undated`), `pr`, `merged`, `unresolved`. |
| `neighbours` | Ids of the events in this chunk within 30 minutes (time order). `neighbours_outside_set`: events in the window that are not in the set at all. |
| `pre_group` | Mechanical grouping hints: `dup_root`, `dup_children`, `same_signature_30m` (same normalised monitor or title), `same_repo_30m`, `cluster` (items one agent investigation covered: a hypothesis, not truth), `cluster_outside_set`. |
| `pre_escalated` | The item has at least one transition into `needs_decision`. |
| `pre_owner_touch` | Escalated, or a transition note starts `closed by hand` / `re-investigation requested`, or an owner or CLI operation exists. |
| `pre_has_fix_commit` | `fix_commits` holds a merge, a PR subject or a fix-worded note commit. |
| `pre_prior_same_signature` | `stem`, `n_prior_events`, `n_prior_items`, `prior_ids` (most recent first), `any_prior_fixed_by_change`, `fixed_examples` (earlier item fixed by a commit dated before this event). |

The `pre_*` fields are mechanical hints. They are often right and sometimes wrong; disagree
freely and say why in `evidence`.

### Traps

1. **One row can hold several episodes.** A recurring fingerprint reuses its row, so
   `first_seen` is the start of the latest episode while `transitions` reach back through
   earlier ones (`item.episodes`, `item.latest_episode_at`). Label the latest episode. Use the
   earlier history as evidence, and say in `why_uncertain` when it blurs the picture.
2. **Unledgered events** (`item: null`): every event of April to August and every
   `slack_update` has no ledger row, so no outcome, transitions or dispatches. Label from title,
   payload and neighbours; use `genuine_owner_decision` `na`; mark `uncertain` when the cause
   cannot be told.
3. **`first_seen` is when the poller saw it, not when it happened.** Slack is read in batches
   roughly every 30 minutes, so a Slack row's `first_seen` can be up to about 35 minutes after its message: judge
   co-firing by `event.msg_last` where it exists (and by `log_at` for `hermes_log`). Until about
   the end of August nearly every event, whatever its source, carries its poll's time, so
   several events sharing one timestamp is an artefact, not proof of one incident.
4. **A recovery is its own event.** A recovery notice or an Up relay is a separate row from the
   alert it ends, and belongs to the same incident.
5. **Relays.** A `slack_alert` row that restates a Kuma monitor is the same incident as the
   monitor's `uk` row; "New incident for ..." and "Automatically resolved ..." messages are
   relays of the same outage, not separate ones.
6. **`occurrences` is a counter**, not extra rows: repeated fires of one fingerprint are one
   event.
7. **Withheld entities.** A few entities that concern a self-contained private repo are not in
   the set. A group can therefore be smaller here than it was in reality.

## 3. The labels

### 3.1 `incident_group` and `group_summary`

`incident_group` is chunk-local: `cNN-gMM`, NN the chunk number from the file name, MM counting
from 01 in the order of each group's first event. Every event is in exactly one group; a lone
event is a group of one.

A **true incident group** is the set of events that are manifestations of one underlying
incident: one cause, one episode. It contains the alert and its recovery, the relays of it, the
GitHub issue the alert bot filed for it, warden's duplicates of it, the chat about it, and every
alert one cause produced across several monitors (one reboot, one outage, one expired
credential). Two tests:

- **Shared cause:** would fixing one thing close all of them?
- **One episode:** no recovery followed by a clean new failure in between.

Events that merely fire at the same time without a shared cause are different groups. The same
symptom on different days is different incidents, unless the packet shows one continuing
episode. Warden's `duplicate_of`, `cluster` and `same_*` hints are hypotheses: verify, split or
merge as the evidence says.

Events that are not incidents (a routine deploy notice, bot chatter, a recovery whose alert is
outside the set, a canary) are grouped by what they are about, never into one big noise group:
one deploy is one group, one chat thread is one group. Start their summary with `noise:`.

`group_summary` is one line of at most 140 characters, the same text on every line of the group
(the validator checks). Shape: what failed or happened, on which service, the cause class, the
date. No ids, no volatile numbers. A later step merges groups across chunks by these summaries,
so an incident that continues in another chunk (see `entity.peers`, `cluster_outside_set`) must
be described so that the other chunk's labeller would write nearly the same line.

### 3.2 `root_cause`

At most 15 words: the real cause, not the symptom ("VPS edge returned 5xx" is a symptom; "an
unattended kernel upgrade rebooted the host" is a cause). Sources in order of trust: an owner's
closing note (`closed by hand: ...`), the subject of the fix commit, review and implement
verdicts, the investigation (`rc:`, `S:`), then the item's own `root_cause` and `note`, which
are warden's guess (`unknown-...` means it did not know). Hindsight is fine here: use whatever
the packet shows, including later transitions.

When nothing supports a cause write `unknown:` followed by what is known ("unknown: monitor
went down, recovered by itself"). That is a valid truth label. For non-incidents write `none:`
and what it is ("none: routine deploy notice"). Members of one group normally share the root
cause: relays and recoveries repeat it.

### 3.3 `genuine_owner_decision`: `y`, `n` or `na`

Genuine means the decision is the owner's by one fixed rule: **product direction, spend,
irreversible data loss, or other people**. Nothing else is genuine, security policy included
(`../DEFINITIONS.md` is binding here, even where a general working rule counts security policy
as an owner decision).

| Value | When |
|-|-|
| `y` | The item needed a decision of exactly those kinds, whether or not warden escalated it. Product direction: what the product or system should do, a scope or priority choice the brief does not settle. Spend: committing money or quota beyond routine (a costlier route, a payment). Irreversible data loss: deleting or pruning what cannot be recovered. Other people: contacting or affecting third parties, shared or work branches. |
| `n` | A decision or owner action was asked for or needed, but it is not genuine. Typical: a choice between two workable fixes (the agent should pick); an agent's obstacle report (denied shell, unreadable live state, "needs access on the host", `[blocker]`); physical or manual host work; a security-policy question; a review that failed for infrastructure reasons; reversible alert tuning; a restart or config choice; a question the brief already answers. |
| `na` | No owner decision was needed or reached: auto-resolved, quiet, ignored noise, a duplicate child, a relay, a deploy notice, information only. Duplicate children are `na` unless they escalated themselves. An escalated event can never be `na`. |

Judge the decision that was *needed*, not warden's handling. An escalation that was easily
decidable by the agent is `n`. A genuine decision that warden closed, ignored or auto-resolved
is `y` (a missed escalation, the case the backtest must catch), with `evidence` saying why.
`escalation.category` is the agent's claim and never decides the label: `[security]` is never
genuine, `[data_loss]` only if the loss is irreversible, `[blocker]` is an obstacle report, and a
transition note starting `re-driven to decide` or `decided without the owner` means warden
itself ruled the question not owner-only. When one escalation mixes a genuine and a non-genuine
question, label by the question that actually blocks progress and mark the event `uncertain`.

### 3.4 `known_fix`: `y` or `n`, with `known_fix_ref`

`y` only if, **at this event's `first_seen`**, an earlier ledger item or commit already held the
fix recipe for this root cause. No look-ahead: evidence dated after the event never counts.

- An earlier item with the same root cause ended `fixed` or resolved by a change (see
  `pre_prior_same_signature.fixed_examples`).
- A commit dated before `first_seen` that fixes this cause (`fix_commits` with
  `rel: before_episode`): the event is a recurrence or a regression.
- `closed:fixed_by` pointing at an earlier item or pull request.
- An earlier closing note spelled out the recipe.

`n`: the cause is novel or unknown, only investigation text exists without a fix, or the only
fix is the one that resolved this very event (`rel: after_episode`). A recipe that did not hold
(it recurred) is still `y`: the recipe existed.

`known_fix_ref` is required for `y` and null for `n`: `item:<earlier event id>` (it may lie
outside this chunk or the set) or `<repo>@<sha7>`; two references separated by `;`. The
backtest checks the match against the right prior incident, so name the real one.

### 3.5 `uncertain`

`true` when a reasonable second labeller could choose a different value for any label: a
contested or unknown cause with more evidence plausibly existing; an ambiguous group (could
merge with or split from a neighbour); a genuine decision that depends on facts not in the
packet; a doubtful known-fix link. `why_uncertain` (at most 120 characters) names which label
and why, and is required when true, null otherwise. The backtest scores uncertain labels both
as labelled and flipped, so use the flag where it is true and nowhere else. Never guess
silently.

## 4. Deriving labels from outcomes and fix commits

| The packet shows | It tells you |
|-|-|
| `closed` with `close_reason` duplicate, `duplicate_of` set | Warden thinks it is the root's incident. Check title, time and cause before you keep the group. Genuine `na`. |
| `closed:ignored` (notes like "matched the policy ignore list", "unstructured #alerts prose") | Noise or a relay. Group it with what it relates to (a relay) or as `noise:`. Genuine `na`. |
| `quiet` | The signal stopped before work started. The cause is often unknown; it is not a fix. |
| `closed:resolved` or `fixed` with `fix_commits` via `merged_sha`, `merge_receipt`, `pr_subject` | A change fixed it. Root cause = what the commit subject names. This commit fixes this event (`after_episode`), so by itself it is not a known fix. |
| `closed:resolved`, note `closed by hand: ...` | The owner's verdict: the best root-cause evidence, and an owner touch. Read it for a genuine decision that was swallowed. |
| `closed:resolved`, note "no change needed", "recovered on its own", "premises don't hold" | A transient or external cause, or a brief that did not apply. Say so in `root_cause`. |
| `closed:fixed_by`, note `fixed by #N` | A known fix: the earlier item `#N`. Check it predates the event. |
| `failed` | Warden's own machinery failed on the item (three strikes). It says nothing about the incident; read the original signal. |
| `needs_decision` still open | A question nobody answered. Judge the question by the rule, not by the fact that it is open. |
| `dispatches[].next` is `human` | The investigation asked for a human. Not automatically genuine. |
| `pre_owner_touch` true, `pre_escalated` false | The owner stepped in by hand. Read the note: a swallowed decision (`y`) or a courtesy close (`na`). |
| `fix_commits` `via: note` | A commit named in a fix-worded note. Check the subject before you rely on it. |

## 5. Worked examples

Real packets, illustrative labels. They show the reasoning, not ground truth; do not copy them.

**Duplicate across source families, chunk 19.** `#1698` is a `job` row "job
com.jkrumm.drift-check is failing" (needs_decision, `[blocker]`: the tailscale daemon is 14 days
behind upstream and the upgrade needs a human on the mini). `#750` is the `uk` monitor "MacMini
Drift - Push", closed by warden as duplicate of `#1698`. Same incident: one group, summary
"Mini drift-check red: tailscale daemon update pending past the 14-day grace, Oct 20-21", root
cause "tailscale daemon update on the mini pending past drift-check's 14-day grace". `#1698`
genuine `n` (an obstacle: manual host work, none of the four kinds); `#750` genuine `na` (a
duplicate child). Known fix `n`. Not uncertain.

**A cascade, chunk 18, 2026-10-17 around 20:52.** Seventeen `uk` HTTP monitors (for example
`#1629` "FPP - Server - HTTP") went DOWN between 20:52 and 20:56 and were back between 20:57 and
21:00 (`event.resolved_at`). Slack relayed their Downs and Ups in one batch that the 21:22 poll
ingested: a row like `#1648` (an Up relay) has `first_seen` 21:22:25 but `msg_last` 20:57:54, and
"New incident for ..." (`#1660`) and "Automatically resolved ..." relays travel with it. One
group holding most of the chunk's 62 events, summary "VPS HTTP monitors all down for about six
minutes, 2026-10-17 20:52". Root cause "unknown: all VPS HTTP monitors failed together for six
minutes", `uncertain` true, "no packet states the cause". `#1173` ("FPP - DB - MySQL" Down,
`msg_last` 20:52:47) belongs to it by time. `#1636` and `#1637` (alert-bot issues about the
egress proxy and the door route, filed 21:04) probably do too, but nothing proves it: put them in
the group with `uncertain` true, or give them a group of their own, and say which in
`why_uncertain`. Warden escalated eighteen items from this chunk, every one a `[blocker]`
question about missing host shell access.

**Escalation, genuine (spend), chunk 14.** `#1452`: "Run check/overview Max-first now (accept
the Max cost), or keep the IU-then-Max fallback while asking IU for the rejected request
schema?" The choice commits quota to the costlier route. Genuine `y`, `evidence` "question
chooses to accept Max cost". Root cause "IU leg of check failed mid-stream; a wrapped gateway
error was misclassified as transient and fell back to Max". The owner never answered (the item
was closed by hand after the improve loop re-routed the check); that does not change the label.

**Escalation, not genuine, chunk 18.** `#1173`: "[blocker] Grant read-only host shell for
logs and monitor history to re-investigate, or close the alert as an unexplained one-off?" The
agent reports an obstacle; granting itself host read access is not product, spend, data loss or
people, and closing as a one-off is within the loop's own authority. Genuine `n`.

**Known fix, chunk 16.** `#1538`: a Hermes streaming failure "No suitable backend server found
for model 'hermes'", closed by warden as `fixed_by` item `#1497`; `pre_prior_same_signature`
shows `#1497` fixed by `hermes-agent@115d62c`, dated four days earlier. Known fix `y`,
`known_fix_ref` `item:1497`. Root cause "a model id the gateway no longer serves, pinned in a
Hermes cron job, makes streaming return 404".

**Noise grouping, chunk 08.** `#827` to `#830`, unledgered `slack_update` deploy notices, one
timestamp. `#828` and `#829` deploy two services from the same image tag: one group "noise:
argo-dashboard and argo-api deployed from one release, 2026-08-27". `#827` and `#830` are two
different audio-gateway images: two groups. Root cause "none: routine deploy notice", genuine
`na`, known fix `n`.

**A recurrence after a fix, chunk 14.** `#847`: the recovery notice "VPS edge p95 > 3s (15m)",
an item with 25 episodes since Sep 10. Before this episode `vps@e5c2314` excluded OTLP ingest
paths from the p95 tile and `vps@a865d77` added a two-consecutive-windows guard to the sibling
5xx alert; the guard for this alert (`vps@6480d2f`) landed minutes after (`after_episode`). The
investigation says the alert fires on single transient windows. Root cause "p95 alert pages on a
single transient window, no consecutive-window guard". Known fix `y`, ref `vps@a865d77`,
`uncertain` true, "recipe known only from the sibling 5xx alert". Group it with the alert it
recovers if that alert is in the chunk.

## 6. Output: `labels/NN.jsonl`

One JSON object per line, one line per packet of `chunks/NN.jsonl`, any order.

| Key | Type | Rule |
|-|-|-|
| `id` | int | Packet id. Every packet exactly once, context events included. |
| `incident_group` | string | `cNN-gMM`. |
| `group_summary` | string | 1 to 140 characters, identical across the group. |
| `root_cause` | string | 1 to 15 words. `unknown: ...` or `none: ...` where that is the truth. |
| `genuine_owner_decision` | `"y"`, `"n"`, `"na"` | `na` is not allowed when `pre_escalated` is true. |
| `known_fix` | `"y"`, `"n"` | |
| `known_fix_ref` | string or null | Required for `y` (`item:1234`, `repo@abcdef1`, joined by `;`), null for `n`. |
| `uncertain` | bool | |
| `why_uncertain` | string or null | Required when `uncertain` is true (at most 120 characters), null otherwise. |
| `evidence` | string, optional | At most 160 characters: the packet fields behind a `y`, a missed escalation, a `known_fix` `y`, or any label that departs from a `pre_*` hint. |

```json
{"id": 1698, "incident_group": "c19-g04", "group_summary": "Mini drift-check red: tailscale daemon update pending past the 14-day grace, Oct 20-21", "root_cause": "tailscale daemon update on the mini pending past drift-check's 14-day grace", "genuine_owner_decision": "n", "known_fix": "n", "known_fix_ref": null, "uncertain": false, "why_uncertain": null, "evidence": "escalation is a [blocker]: manual host work"}
```

Check before you finish:
`python3 -I validate_labels.py labels/NN.jsonl` (from this directory). It must print `ok`.

## 7. Procedure and rules

1. Read the chunk's entry in `chunks/index.json`, then the whole chunk file once. A one-line
   view helps: `jq -c '[.id,.first_seen,.source,(.item.state // "-"),.title]' chunks/NN.jsonl`.
2. Build the groups first (time order, neighbours, relays, recoveries, `entity.peers`), then
   label each event.
3. Label every id, context events included. Do not edit packets or chunks; write only
   `labels/NN.jsonl` (create `labels/` if it is missing).
4. Work from the packet, the other packets of your chunk, `git show <sha>` for a listed commit,
   and read-only lookups by id in the frozen snapshot (`~/.local/share/factory/snapshots/2026-10-22/warden.db`,
   opened with `mode=ro`) for ids the packet names (`entity.peers`, `pre_group`, `prior_ids`).
   The packet is meant to be enough; do not bulk-query. Never let data dated after an event
   decide its `known_fix`.
5. Work independently: do not read another chunk's label file.
6. Your text is committed to a public repository. No hostnames, addresses, tokens, internal
   URLs or home paths; repositories of the work workspace by name only, never their content;
   no service names of the withheld private repo. The validator runs the redaction gate.
7. When two readings are equally good, pick the one a careful reviewer would and set
   `uncertain`. When you find a packet that looks broken (a missing field, a title cut mid-word
   so that it misleads), label it as best you can, set `uncertain`, and report the id in your
   hand-back.
