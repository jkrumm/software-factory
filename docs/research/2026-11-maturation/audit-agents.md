# Audit: what an agent touches in software-factory

Scope: the lead's brief, the CLI as an agent sees it, refusals, notes, hooks and integrations, AGENTS.md and the format pages. Read-only. Evidence is file:line from a clean master (8fa0a18c), `factory` read verbs, `snapshot/data-friction.txt` (7 days, 1545 Issues) and `retro.json`. "Unverified" marks what I could not confirm.

Numbers used throughout (retro.json `waste`): refused ships 75 events = 49.8 h/week; stalls 80.4 h; slot wait 254.9 h; owner waits 328.9 h; queue 2078.6 h. Friction counts: 101 ships refused, 37 state-machine refusals, 93 orchestrator notes, 45 owner notes, 39 wall stalls, 37 blocked stalls, 183 unreviewed ships.

---

## 1. The brief

### Size and outline (measured by calling buildBrief with a minimal Issue, notes, check tiers and merge-guard)

- Total 27,751 chars, 4,852 words (about 7K tokens). `STANDING_ORDERS` is 26,581 of it (96%); everything that is about this Issue is about 1.2 KB. Source: `apps/server/src/domains/leads/brief.ts:9-76`, assembly `:187-`.
- Outline: `# Operating contract` (orders 1-9 + "Also"), `# Waiting, and the host's shell`, `# What you do yourself on the mini`, `# Verbs`, then per Issue `# This Issue`, `## As filed`, optional `## Checkpoint`, `## Checks in this repo`, `## Merge guard in this repo`, `## The signals it was filed from`, `## Your seat`, `## Moved up`, `## The previous attempt`, `## Notes from the owner`, `## Notes recorded before you started`.
- Size per block (chars, source-escaped so about 2% over): order 7 (ship recipe) 5,316; Verbs 7,960; order 3 (Spec) 3,646; order 6 (review) 2,273; "Also" 1,824; Waiting 1,789; order 2 (Decisions) 1,607; What-you-do-yourself 979; orders 1,4,5,8,9 together 1,510.
- Churn: 52 commits touch brief.ts in the repo's life; 42 since 2026-11-10, 15 of them `fix`. `git log -- brief.ts` shows the recipe in order 7 was patched three times in two days: `3f1db1ac` "CI wait reads each check bucket, not the watch exit code", `1ca7ba2d` "the CI wait is one group, so a failed push or rebase stops it", `cc996235` "the watch fallback waits for the pushed head to have a run". The newest (`f69d9097`, 2026-11-19) added a sentence to order 1 from one retro sample (signal text: "the cost is one Issue's hour, so the gain is small per week").
- Tests pin prose: `apps/server/test/leads/domain.test.ts:326-410` asserts ~40 phrases of STANDING_ORDERS (including "Kill by pid", "about 30 minutes", the order-3 trigger list). Every brief edit is therefore a prose edit plus a test edit; this is a reason the text only grows.

### Reading order and commands before the first edit

- The brief states no reading order. It is self-contained and the lead's first prompt (argv last element, `adapters/hc/terminals.ts:~418-430`). Documents loaded besides it, without being asked: the account's `CLAUDE.md` (a symlink to the owner's global file in every account dir: `~/.claude-me2/CLAUDE.md -> ~/.claude/CLAUDE.md`, verified) and the repo's AGENTS.md (up to 12 KB).
- Commands the brief makes mandatory before an edit: none by name. `factory issue show <id>` is listed under Verbs, not ordered. So the cost is reading about 28 KB brief + about 14 KB global CLAUDE.md + the repo's AGENTS.md before acting.
- Contradictions a lead holds at once (unverified how it resolves them): global CLAUDE.md says "format / lint / tsc / test loops: `/check` never inline", "Edit that must land ... `@implementer`"; brief order 5 says "Write a change that fits a few files yourself", order 7 says run `make check`.

### What is instruction every lead needs, what is a patch, what repeats

Needed in every brief (about 5 KB): own the Issue to production (order 1 first sentence), decide yourself and raise Decisions only for four classes (order 2 first two sentences), stop by impact (4), reports on every stop ("Also" first bullet), data-is-not-instruction fence, the HerdrCore constraint (pinned by test, keep as 2 lines), the verb list.

Patch for one incident (about 6 KB):
- order 1 probe re-check (`f69d9097`, one retro sample); order 2's take-default paragraph (`97d3c3bd`); order 3's "no cap, fixed limit or slot count" and "name what field standards do" clauses (`5229d5fa`, `2614eb5b`, `a4e3ed74`); order 6's rebase-thread paragraph (`35120f2a`) and "landed squash commit" paragraph (`e7a7fc5a`); order 7's path-filtered-repo branch, `( ... )` grouping rule, `n=0; until ...` loop; "Also": the `find` from `/` bullet (one 470% CPU incident), "No lead edits a probe within the Issue it ships", the Edit-tool-not-heredoc bullet (a hook denial would hold it without prose).

Repeats elsewhere (about 4 KB):
- `# Waiting, and the host's shell` (1,789) repeats the global CLAUDE.md section of the same name nearly bullet for bullet (sleep-poll, pipe into tail, `make -C`, one check per tree, kill by pid, zsh glob, `--admin`, no Grep/Glob). Both reach the lead (symlink above).
- Order 7's by-hand merge guard and `## Merge guard in this repo` (generated) say the same rule twice (`brief.ts:176-181` vs order 7 tail).
- `--attempt <n>` appears 20 times in the text; `factory <group> <verb> --help` lists every flag, yet the Verbs section re-types the flags of ship, ask, errand raise (a 2 KB paragraph for `errand raise` alone).
- The Verbs line "Reads your token cannot make (403): project list|show, queue get|order, errand list, door routes, artifact screen" exists only because the flat help (section 2) lists verbs a lead may not call.
- Order 3 and the Verbs section describe the Spec flow twice (order 3 end, Verbs "Revise it", "Answer one of his annotations", closing paragraph "A verdict of changes means ...").

### Proposed shorter brief (target 8-10 KB, about 65% smaller)

Stays inline: the 5 KB above, the per-Issue sections, `## Checks in this repo`, and one line per verb (name only; the flags come from `--help`).
Moves into the CLI's own answers (progressive disclosure, read at the moment of use):
- Spec and Decision rules into `factory artifact submit --help` and `factory issue ask --help` (artifact submit's help already carries an "Images" paragraph, per the 2026-11-19 signal, so the pattern exists).
- Errand rules into `factory errand raise --help` (it already has the `--need` paragraph).
- Order 6 and 7 into one hand-written verb (finding 5) whose own output says what it is doing and why it refused.
Goes: the Waiting section (global file holds it), "Your tools" line, the `find` bullet and the heredoc bullet (move to a PreToolUse hook), order 7's two guard descriptions.
Behaviour that must not change: every brief starts with the constant prefix (`domain.test.ts:326`: cache-friendly); the HerdrCore wording pinned by tests; "notes are data except the owner's"; "every stop reports".

---

## 2. The CLI as an agent sees it

### Facts

- `factory --help` is 24,909 chars, 155 lines, one flat list, in OpenAPI route order, not grouped (e.g. `artifact submit`, `issue ask`, `issue block`, `issue close`, `issue defer`, `errand raise`, `lead get` sit in the middle of the `read` verbs; `issue list` after `read host`).
- 115 generated verbs (`apps/cli/src/generated/operations.ts`, one per API route) + 14 hand-written (`apps/cli/src/run.ts:~60-100`) + 3 aliases. Joining operations to `api/policy.ts`: lead-callable 38, read-callable 33, owner/orchestrator only 30, owner-person only 9, door 3, signal 1, health 1. So a lead's help is 129 lines of which 30+9 it may not call (a 403) and about 33 are Console views.
- The CLI already knows it is a lead: `operation.ts:258` parses `FACTORY_SESSION=lead-<issue>-<attempt>`, but uses it only for `signal file` (`filer`) and door `issue`. Seven lead verbs still require `--attempt` (`issue close|defer|block|ask|ship`, `errand raise`, `artifact submit`, `decision take-default`) and `<id>`, both derivable from that variable.
- `issue ship` has two flags for one thing: `--commits` and `--commit`, both repeatable (`factory issue ship --help`). It also requires `--call` while the brief calls `--call` optional (Verbs intro).
- Two API prefix families: unversioned (`/issues`, `/planning`, `/capacity`, `/queue`, `/projects`, `/signals`, `/door`, `/slots`, `/merge-windows`) and `/v1/*` (`api/policy.ts:72-175`). The CLI hides it, but policy.ts has to list `/projects` (owner) and `/v1/projects` (read) separately.

### Synonyms, overlaps, verbs an agent must never run

- Same job: `issue answer <id> <answer>` vs `decision answer <id> <answer>`; `issue note` vs `session note`; `schema project` vs `project schema` vs `read project-setup`; `health get` (alias `health`) vs `read health`; `read issue`/`read issues` aliases vs `issue show`/`issue list`; `read asks` (what waits on the owner plus Errands) vs `read needs` (everything that waits on the owner); `read machine` vs `read host` vs `read throughput` vs `capacity get`; `read retro` vs `factory retro`.
- Evidence the overlap bites: signal "An open owner Decision is missing from read needs: counts.decision 0 while issue 2427 was 'paused on your answer'" (`data-signals-newest200.json`).
- Seven project reads: `project list`, `project show`, `project plan`, `read project-index`, `read project-digests`, `read project-page`, `read project-hygiene`, `read project-setup` (eight with sync). The group name is `project` for some and `read` for others.
- Edge editing in three places: `planning after` (owner), `issue new --after`, `issue defer --after` (lead). Queue explanation in three: `queue order`, `read chain`, `capacity admit` (a write verb that also prints why Issues stay queued).
- Manual loop triggers in five: `loop run <name>`, `planning pass`, `checkpoint pass`, `desk push`, `capacity refresh`, `project sync`; `loop run`'s own list names `planning` and `desk`. Whether they run the same function is unverified (routes in `api/loops.ts:50,70`, `api/planning.ts:314`, `api/checkpoints.ts:899`).
- Verbs no doc or skill names (rg over the repo bar generated/architecture/decisions): `read since`, `read flow-trend`, `desk push`, `read project-setup`, `read project-index` (0 files each); `read changes`, `read fix-commits`, `read loop-yield` (1 each). They are Console views exposed because the CLI is generated one verb per route.
- `artifact` has 21 verbs; 6 are `collection-*`; 9 are owner or owner-person only (`annotate`, `annotation-edit`, `annotation-delete`, `verdict`, `needed`, `screen`).
- Drift in an old-CLI shim: `apps/cli/src/retired.ts` maps 25 commands of a CLI that lived about three days (commit `577b2d95`, 2026-11-07).

### What a lead actually needs (from brief.ts Verbs and the factory skill)

Used by the brief: `issue show`, `issue ship`, `issue close`, `issue defer`, `issue block`, `issue ask`, `decision take-default`, `artifact submit|revise|show|annotation-reply`, `errand raise`, `signal file`, `door route-set|route-remove`, `project plan`, `merge-lock`, `deploy-lock`, `slot run`, `plan merge`, `plan check`, `door token new`.

### Proposed lead-facing surface (15) and how the rest hides

1. `issue show` 2. `issue ship` 3. `issue close` 4. `issue defer` 5. `issue block` 6. `issue ask` 7. `decision take-default` 8. `artifact submit` 9. `artifact revise` 10. `artifact show` 11. `artifact annotation-reply` 12. `errand raise` 13. `signal file` 14. `merge-lock` (or `land`, finding 5) 15. `slot run`.
Second tier, shown only with `factory --help --all`: `deploy-lock`, `plan check|merge|schema`, `project check|schema`, `door route-set|remove`, `door token new`, `project plan`, `read overview|waits`, `capacity get`.
How: the generator already reads the OpenAPI document; let it also import `POLICY` from `apps/server/src/api/policy.ts` and tag each operation with its callers. At run time, `FACTORY_SESSION` present means the lead help (the 15 plus second tier on request); `FACTORY_READ_TOKEN` only means the read help; the owner's host keeps the full list. Callers need no new concept: policy.ts is already the single source (AGENTS.md "Who may call what"). Also group and sort the output (one heading per group). Expected: 24.9 KB to about 3 KB for a lead; the brief's "Reads your token cannot make (403)" line goes.
Behaviour that must not change: all verbs stay callable by name; `make check`'s generated-CLI check still passes; hand-written verbs keep their contracts (`rd` depends on `role get`).
Risk low, size S for the filtered help; M if verbs are also merged (`issue answer` into `decision answer`, `--commits` out, `schema project` out, console-only reads out of the default list).

---

## 3. Refusals

### The top classes and what each tells the agent

Counts: `data-friction.txt` 7 days, merged by pattern with shas removed.
- 44 (+3 on origin/main) "commit <sha> is not on origin/master: merge it first": no next command, no list of what would be accepted. The same text can mean: PR not merged, merged but local ref stale, or a sha typed wrongly. Source `adapters/quality/git.ts:~203` (`lacking()`), reaches the lead through `portError('refused', ...)` with an empty hint (the 2026-11-19 retro signal states "the refusal's hint field is empty, so the lead guesses and ships again").
- 13 "commit <sha> is older than this attempt" (`git.ts:217`): the gate rejects anything at or before the attempt's `cut` (`quality-checkout.ts:16`, `baseSha`). On attempt 2 the base is master at spawn time, so work attempt 1 already landed is "older". Data: issue_2239 (attempt 2: "d9c1abc99bd4 is not on origin/master" then 3 s later "8439f9c229ed is older than this attempt"), issue_2261 (attempt 1 "not in repo", attempt 2 "older than this attempt", same sha), issue_2076.
- 9 "deployed <sha> does not hold <sha> ... make deploy has not run on it": exact next step is in the text (`watch.ts:190`: run `make deploy` inside `factory deploy-lock`). Fine.
- 9 "not in <repo>: push it first" (`git.ts:~190`): a typed sha that does not exist. issue_2303 (shutterflow) tried `c7ac4b647710aae28...` four times in 5 s and 10 min apart, then attempt 2 tried `c7ac4b646710`: digits differ by one. Hand-copied shas.
- 13 waits (Errand 8, Decision 3, artifact 2 + regressed 2): `table.ts:80-105` names the wait, the id and what ends it ("raise the Errand as the last step, end the turn"). Good: this is the model the others lack.
- 3 "N annotation(s) of the owner ... have no disposition": names the verb.
- 37 state-machine refusals, 15 of them `noted` on a closed Issue: "it is closed: reopen it first" (`table.ts:122`) names no command. The sender is the owner/orchestrator (agent notes get 409 per the verb help). `shipped` on "it shipped: the watch is on, and verify ends it" (`table.ts:121`) names none either.

### Is "merge, deploy, then ship" learnable from the brief

Yes in text (order 7: "Ship means land and deploy"; Verbs: "Ship, after you landed and deployed"), but it is one clause inside a 5.3 KB paragraph, and the failure mode in the data is not the order: it is hand-typing the sha(s) (typo, a squash-merge sha vs the branch sha, previous attempt's sha, two shas in one call where one is unmerged). 101 refusals, retro `refused_ships` 75 events = 49.8 h/week (about 40 min per refused ship). Retries come seconds apart (issue_2303 16:51:12 and 16:51:17 with the same sha): the refusal teaches nothing.

### Changes that remove the refusal instead of explaining it

1. `issue ship` takes no sha by default: the server already knows the lead's branch and cut (`quality-ship.ts:103-116`, `GitCommits.branchCommits`, `mergedCommit` which already finds the commit that merged the named ones). With no `--commit`, find the PR of the branch (`gh pr list --head <branch> --state merged`, the quality adapter already reads GitHub in `ci.ts`) or, for a push-shipping repo, the branch's commits on origin/default. Keep `--commit` as an override. If it is genuinely not merged, the refusal says "branch factory/N-A has no merged pull request: `gh pr merge` inside `factory merge-lock`". Removes about 70 of 101 refusals a week.
2. Make the cut Issue-wide: the smallest `baseSha` over the Issue's attempts, not the current attempt's. Removes "older than this attempt" (13/week) for the legitimate case (work landed by an earlier attempt that died before it could ship). The guard's purpose, an old commit proving nothing, still holds against the Issue's first cut.
3. Interim, no design needed: make the two git refusals carry a hint, exactly as the retro signal says. If 1 ships, delete it.
4. Drop `--call` as a required flag of `ship` (derive it from attempt + the commit set); remove the duplicate `--commits`.
5. Name the next command in the two bare state refusals (`table.ts:121-122`): for `noted` on a closed Issue, "`factory issue reopen <id> --reason ...` (owner), then note"; for `shipped`, "wait: verify ends the watch".
Risk: 1 medium (gh call in the ship path; keep the 300 ms-class bounds the adapters already use, a gh failure is a recorded absence like CI is, NL23), 2 low, 3-5 low. Size: 1 M, 2 S, 3 S, 4 S, 5 S.

---

## 4. Notes (93 orchestrator, 45 owner in 7 days)

Method and limit: friction counts only real `issue note` calls (`read/kpis.ts:37-60`: key `^noted:issue_N:owner:`; verdict, Errand-done and filing notes are excluded; bursts within 60 s count once). Retro does not carry note text, so I read the `notes` of the newest 400 Issues (`factory issue show`, updated since 11-13): 41 non-filing notes. This is a sample, not the 138; classes below are from those 41.

- Verdict relays and Errand-done messages: 18 of 41 (automatic, not counted as touches): the owner's verdict note text and "The owner did the Errand ...".
- Facts that were wrong, thin or stale at filing: about 9 (issue_2396 "Corrections to this row ... plan row subs-package was revised in PR #547; the facts you were filed with predate it"; issue_2397 the cause; issue_2211 "Second case"; issue_2407 "A real manual reset to test against"; issue_1926 rounds 6 and 7; issue_1976; issue_2525). A plan row edited after its Issue was filed never reaches the lead except by hand: planning files once (`app/planning-pass.ts:134` writes `factsNote(row)` at filing).
- Owner direction in his own words relayed to a started lead: about 7 (issue_2096/2097 design direction, issue_2226 "optimise for throughput", issue_2427, issue_2531 "Many content pages of mine will be Astro").
- A stop-and-wait order: issue_1300 (WeatherOrb paused). That one produced 8 stalls in the timeline and 3+ Judge "Keep stood down" default answers (issue_1285 similar, 4 stalls): a pause expressed as a note becomes repeated block, steward note, Decision and default (`retro.samples.stalled`).
- A Spec the lead cannot revise: issue_2295 got 5 notes because "This Issue's Spec could not be revised while no lead works"; the signal "A held gate Spec cannot be revised by the session that filed it" (409 "no lead works it yet") says the same.
- Plain edge edits: 2 (`planning-chain.ts:203` records `unafter` as a `noted` event with the actor; the count filter ignores it, but it clutters the note list leads read).
- Notes to closed Issues: 15 refusals a week ("it is closed: reopen it first").

What could be a rule, a brief line or a default:
- Re-send changed plan-row facts: when `planning sync` sees a filed row's facts change before the Issue closes, record one note with the diff (the code path exists at `planning-pass.ts:134`). Candidate for a large share of the "corrections" class (about 9/41).
- A held Spec must be revisable by its filer or the verb refusal must name the way (cancel and refile); today the lead-less case forces notes.
- An owner "pause this" as a state (an owner-set defer until a note), not a block that the Judge answers three times. `queue set <project> drain` exists per project but not per Issue; the retro sample shows the gap. Size M, unverified frequency: only the two weatherorb Issues in the sample.
- Owner "taste" lines (design direction, throughput preference): `retro.taste` exists; route them into the repo's AGENTS.md or the project's policy rather than per-Issue notes. Not measured.
- Owner note on a closed Issue: let `issue note` on a closed Issue within 30 days answer with the reopen verb's name, or reopen with the note as the reason when the caller is the owner/orchestrator.

---

## 5. Hooks and integrations

- What takes part: nothing in the working repo. Hooks are global settings of each Claude account (dotfiles `make setup` renders them from `integrations/claude-code/hooks.json`; `~/.claude/settings.json` has all six, verified). The lead is told apart by `FACTORY_SESSION`, set by the server at spawn (`adapters/hc/terminals.ts:558`). A repo takes part by having `project.yaml`, optional `docs/plan.yaml` with `.gitattributes` line `merge=plan`, and Makefile targets `check-fast`, `merge-guard`, `deploy`, `verify`. `factory project check` already warns on missing make targets; I did not find a check for the `.gitattributes` line (unverified).
- Three copies of the six hook commands: `integrations/claude-code/hooks.json` (the source), the rendered settings, and a hand-built fixture in dotfiles `scripts/factory-hooks.test.sh:35-43`. They match today. Candidate: the server passes the hooks to the lead with the `--settings` flag in `terminals.ts:argv` (line ~420) instead of every Claude session on every machine running a shell guard on six events, which removes the dotfiles render step and the drift risk. Unverified that Claude Code's `--settings` merges hooks the way the rest of the stack needs; check before building. Size S-M, risk medium.
- The shell guard `[ -n "$FACTORY_SESSION" ]` and `hook.ts:317 if (!env.FACTORY_SESSION) return 0` guard twice; the shell one is the cheap one (no bun start), so keep it. Not a finding.
- Drift found: `integrations/hermes/fleet/SKILL.md:76` tells Hermes to run `factory read accounts`; there is no such verb (it is `factory accounts status`; unknown verbs print the whole help instead of an error, exit code not checked). Same file line ~77 says `read kpis` "today it can 500" (unverified, possibly stale). `integrations/README.md` lists `rd` verbs `issue`, `issues`, `signal` as "become passthroughs ... then retire" (not verified in dotfiles). The skill also uses `read issue`, `read issues`: aliases.
- `integrations/herdr/jk-glance/main.js` is 47,920 bytes and its README 16 KB for a status bar; not audited beyond size.
- Events: hook.ts handles exactly the six README events (`hook.ts:71-114`); the Notification matcher names three `quota_auto_resume_*` types; no drift found there.

---

## 6. AGENTS.md, plan.md, project.md

### AGENTS.md (11,988 bytes; 152 commits touch it since 2026-11-01)

Enforced by a script already (one line each suffices; about 3.0 KB now, about 0.8 KB after):
- Public repo (503): `scripts/public-scan.ts` in `make check`. The paragraph restates what the scan allows.
- Layers (381): `scripts/boundaries.ts`; the bullet restates its checks.
- CLI generated, exit codes (615): `generate.ts --check`, `apps/cli/src/exit.ts`.
- Who may call what (460): `policy.test.ts` fails on a missing row; the file header already documents classes.
- Settings (274): `scripts/env-file.sh` allow-list refuses unknown keys.
- State words (426): `scripts/vocabulary.ts` and `retired-words.ts`.
- README counts (211) and Hygiene catalogue (about 200): `readme-check.ts`, `hygiene-doc.ts --check`.
Narrative or only partly checked, and worth keeping: Facts-stored-state-derived, deterministic keys, never-a-port-in-a-transaction (only partly held by the boundaries script), deploy locks fail closed, one process, one schema, trust boundary, hooks stdout empty, heartbeat names, throughput epoch, "factory never calls a model" (I found no check for it in `boundaries.ts`: unverified, a package.json grep would hold it).
Stale or low value: "Live on the mini since 2026-11-08; docs/program.md is the current state" (date narrative), the Console listener bullet (615) duplicates `docs/operations.md "The Console listener"` which it points to, "Where to look" repeats the doc names used at the top. NL numbers appear 96 times in code and docs; AGENTS.md uses them once ("No Effect (NL11)"), the lead cannot resolve them without `docs/decisions.md` (77 KB).
Proposal: cut to about 7.5 KB by replacing the seven enforced paragraphs with one line each ("held by <script>") and moving the Console-listener detail to operations.md. Size S, risk low (AGENTS.md-only `docs:` commit).

### REVIEW.md (3.7 KB)

The front matter of globs is the real contract (read by `agw review route`); the bullets restate AGENTS.md rules (keys, transactions, trust boundary, hooks, public repo, "never calls a model"). A reviewer reads AGENTS.md anyway; keep the front matter and the "what failure looks like" list only for failures AGENTS.md does not state. Size S.

### docs/plan.md (23,486) and docs/project.md (26,914)

- `factory plan schema` prints plan.md whole; `factory project schema` prints project.md whole (26,847 chars measured).
- plan.md by section (chars): The file 1,887, A row 3,606, When a row is filed 1,049, Choosing the seat 1,004, **Lanes 3,886**, **Check tiers 3,087**, Adopting 1,033, Changing an edge 688, Rebasing 998, Splitting 1,066, Checking 2,577, Replan 1,859. Lanes and Check tiers describe `project.yaml` keys (`lanes`, `checks`), which the project.md key reference already documents (rows at project.md:154-156 and :171 plus "Choosing the values"). They are in plan.md because a plan row can name a lane. Moving them out leaves about 16.5 KB; also cutting Rebasing (the brief and `plan merge` already say it), Splitting, Replan (owner/orchestrator only? unverified) gets to about 9-10 KB: the file, a row, when filed, changing an edge, checking. That is 40% of today's page, not a third, but the rest is project.yaml material.
- project.md: the generated Key reference is 16,801 chars; its "Read by" column (internal source paths such as `apps/server/src/app/loops/hygiene.ts`, repeated per row) is about 4,400 of it, of no use to an author. 74 rows, 20 top-level. "Retired keys" prose is 851 chars + 4 table rows + parser support for 4 dead keys (`deploy.migrations`, `ship[].paths`, `jobs`, `ticktick`): "read by nothing". Dropping the Read-by column, the retired section and the "Choosing the values" overlap with the table gives about 15 KB.
- Proposal: `factory plan schema` and `project schema` print an author page (about 9 KB and about 12 KB); the repo pages keep the long form. Delete the retired keys from the parser once `factory project check` over every repo's project.yaml shows none (unverified: I did not check the repos). Size S for each page, S for the retired keys. Risk low.

---

## Findings (full format)

### F1. Ship takes no hand-typed sha
- What is there: section 3. 70 of 101 refusals/week; 49.8 h/week; the retro signal asked for a hint only.
- Why accidental: the server already holds branch, cut and merge detection; an LLM copying a 40-char sha is the failure.
- Change: `issue ship` derives commits (merged PR of the branch, else branch commits on origin/default); `--commit` becomes an override; drop `--commits` and required `--call`; the refusal when nothing merged names `gh pr merge` in the merge window.
- Must not change: git proof that the commits are on the default branch and newer than the Issue's cut; evidence recorded; idempotent repeat of one call.
- Risk medium. Size M.

### F2. The cut is the Issue's, not the attempt's
- Evidence: `git.ts:217`, `quality-checkout.ts:16`, issue_2239, 2261, 2076. 13 refusals/week.
- Change: use the smallest `baseSha` over the Issue's attempts.
- Must not change: an old default-branch commit never proves this Issue.
- Risk low. Size S.

### F3. A lead's CLI fills what it knows
- Evidence: `operation.ts:258` parses `FACTORY_SESSION`; 7 verbs require `--attempt`; 20 mentions in the brief. Refusal `table.ts:63` "filed for attempt N; the Issue is on attempt M" exists for the wrong-attempt case (frequency unverified).
- Change: id and attempt default from `FACTORY_SESSION` for every lead verb (the same mechanism as `signal file`).
- Must not change: an explicit flag wins; outside a lead session the flags stay required.
- Risk low. Size S.

### F4. A lead's help is the lead's verbs
- Evidence: section 2. 24.9 KB flat help; 39 verbs a lead gets 403 on; a brief sentence that exists to warn about them.
- Change: generator tags operations by policy.ts callers; help filters by `FACTORY_SESSION`; `--all` shows everything; group and sort.
- Must not change: verbs stay callable; `make check` generated-file check.
- Risk low. Size S (filter) to M (also merge `issue answer`/`decision answer`, `schema project`/`project schema`).

### F5. One verb for the merge window and the review check
- Evidence: order 7 is 5.3 KB of shell in prose, patched three times in two days; order 6 needs a hand-run `agw review covered`; 183 unreviewed ships/week are counted but the gate does not refuse (NL23).
- Change: a hand-written `factory land --project <repo> --pr <n>` (client side, like `merge-lock`, so AGENTS.md "git never runs inside the leads' pass" holds) that takes the merge lock, rebases, pushes, waits for CI by bucket, runs `make merge-guard`, checks `agw review covered` and merges with the repo's method. Order 6 and 7 become two lines. Merge-lock stays as the primitive.
- Must not change: one lead per repo in the window; no merge on a head CI did not finish green; `--allow-red` only for the fix; admin merge refused.
- Risk medium. Size L. Not a new framework: it moves a recipe from prose into code that already exists in pieces (`merge-lock`, `scripts/merge-guard.ts` with `--wait`).

### F6. Brief at 10 KB
- Evidence: section 1.
- Change: in three small steps. (a) Delete the Waiting section and the "Your tools" line (global CLAUDE.md carries them), S. (b) Move Spec, Decision and Errand rules into the `--help` of `artifact submit`, `issue ask`, `errand raise`, and replace the pinned test phrases by tests of the help text, M. (c) After F5, order 6/7 shrink, S.
- Must not change: constant prefix, tests that pin HerdrCore and the notes-are-data rule.
- Risk low-medium (a lead might not read help; mitigate: refusals name the help). Size S, M, S.

### F7. Changed plan-row facts reach the lead
- Evidence: `planning-pass.ts:134` notes the facts once; notes of the "corrections" class in the sample (9 of 41; the 138 weekly notes are a lower bound for the class, unverified).
- Change: when a filed row's facts change before the Issue closes, record one note with the diff.
- Must not change: facts at filing stay as filed; the rule that a note from the factory is data.
- Risk low. Size S-M.

### F8. Owner pause as a state
- Evidence: issue_1285 (4 stalls, 3 default Judge answers "Keep paused"), issue_1300 (8 stalls and notes). `stall:blocked` 37/week.
- Change: an owner verb that holds an Issue until a note (`issue defer` exists for leads; owner variant), so the lead does not block and the steward and Judge do not cycle.
- Risk medium (touches table.ts). Size M. Frequency: unverified beyond these two.

### F9. A held Spec is revisable by its filer; owner note on a closed Issue names the reopen verb
- Evidence: signal "A held gate Spec cannot be revised ..."; issue_2295 (5 notes); 15 "noted ... closed" refusals/week (`table.ts:122`).
- Change: allow the filer to revise (no attempt) or name the way; hint in the two bare refusals.
- Risk low. Size S.

### F10. Format pages and AGENTS.md
- Evidence: section 6.
- Change: plan schema and project schema pages 9-12 KB; AGENTS.md 7.5 KB; drop the Read-by column; delete retired keys after a repo scan; fix `SKILL.md:76` `read accounts`.
- Risk low. Size S each.

### F11. One verb per route is the cause of the flat help
- Evidence: 115 generated verbs from 115 routes; Console views as verbs (7 with no doc references).
- Change: mark Console-only routes `hidden` in the OpenAPI document (a tag), so the generator keeps them callable but out of help; merge the overlaps listed in section 2 only where two verbs have the same job (`issue answer`/`decision answer`, `health`/`read health`, `project schema`/`schema project`).
- Risk low. Size S.

### F12. Triage "amended" can lose an agent's friction report
- Evidence: signal "A retro signal that writes a preference into AGENTS.md is not amended into an unrelated hygiene Issue": three of three retro signals amended into unrelated friction Issues; one demonstrably lost (issue_2342). Includes the very ship-refusal signal (amended into issue_2471).
- Not in my area to fix; flagged because it reduces the value of the one channel agents use to report friction. Unverified beyond the signal's own evidence.

---

## Top 10 friction removals, ranked by estimated (refusals + notes + stalls) removed per week

Estimates come from the counts above; "share" notes are my reading of the 41-note sample and are unverified.

1. F1 ship takes no sha: about 70 refusals (and about 35 h of the 49.8 h refused-ship waste).
2. F5 `factory land` + review check: up to 183 unreviewed ships and the window mishaps; I would count 40-90 in the first month (unverified: I did not read why the 183 happen).
3. F2 Issue-wide cut: 13 refusals (independent of F1 if F1 slips).
4. F7 changed facts reach the lead: about 20-40 of the 138 manual notes (the "corrections" and "added evidence" classes; unverified share).
5. F9 notes on closed Issues and revisable held Spec: 15 refusals plus about 5 notes.
6. F8 owner pause as a state: 5-10 stalls/week and the Judge Decisions behind them (two Issues in the sample; unverified).
7. F3 id and attempt from the session: unknown refusals (wrong attempt, `table.ts:63`), certain 2 KB of brief text and 20 repeated flags.
8. F4/F11 lead help: no refusal removed that I can count, 39 wrong-verb 403s possible; brief text and about 22 KB of help output per read.
9. F6 brief at 10 KB: no measured refusal; removes 5 KB of duplicate and 6 KB of incident patches, and stops the churn (42 commits in 10 days).
10. F10 pages and AGENTS.md: about 14 KB less for every plan or project author, 4.5 KB less AGENTS.md for every lead in this repo.

## Could not check

- Why 183 ships had no review (light-seat exemption, commits pushed after the review, or ignoring order 6).
- Verbs actually run by leads (no transcript pass; `retro --no-transcripts`).
- Whether `planning pass`, `checkpoint pass`, `desk push` equal `loop run <name>`.
- Whether Claude Code's `--settings` flag can carry the hooks.
- The 138 notes by class (sampled 41 of the newest 400 Issues).
- Which repos still carry retired project.yaml keys; whether the `.gitattributes` `merge=plan` line is checked by `project check`.
- Stall classes `wall` (39) and account resume (apierror.ts resume plan, 14 KB) were out of my area.
