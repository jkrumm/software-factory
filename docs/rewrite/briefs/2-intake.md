# Package 2: Intake

**Everything that arrives becomes one signal envelope and goes through `intake.receive`, which answers filed,
amended, incident, held or dropped.** Every source the running core has is ported onto it, the door posts signals,
and work-repo text may now reach agw (NL22). Branch `rw/2-intake`. Review: deep.

Read `docs/rewrite/briefs/parallel.md` first: its rules hold here and are not repeated.

## Port from

`docs/architecture.md` §Signals and triage (the envelope as written there is the contract); `docs/language.md` Work
(Signal, Triage, Incident, Amend, Origin); decisions NL15, NL16, NL18, NL22; `docs/design.md` §8 "Dedup and learning"
and "Intake: work comes in by itself" (sources, stateful episodes, fingerprints and their window, settle and heal,
write-back, red checks, launchd, Beszel), §11 "The factory door"; `legacy/server/src/intake/`,
`legacy/server/src/issues/{signals,intake,settle,unrouted,door-sources,origin,classify}.ts`, `legacy/door/src/`,
`config/infra.json`.

## Yours

`domains/intake/`, `app/intake*.ts`, `adapters/intake/` (GitHub, Beszel, launchd pollers, the runbook runner for
heal), `api/intake.ts` (`POST` a signal: the door's and `factory signal`'s entry), `packages/contract/src/intake.ts`,
`apps/door/` (moved from `legacy/door` and rebuilt on the contract: loopback, no factory token, no database
credential, the repo from its routes and never the payload), migrations `0200`+.

## Build

1. **The envelope and trust:** `Signal` as the architecture's zod object; `source`, `kind`, `origin`, `trust` set by
   the receiving side (route, poller, caller), never by an outside payload. `repo` likewise.
2. **`receive(signal)`**, deterministic first: fingerprint and the source's own key (a replay is one effect, a
   re-labelled GitHub issue never files twice); stateful episodes per `(source, subject)` (a `down` on an open
   episode amends it, a `down` after its close files anew); the stateless fingerprint window; **correlation**: alerts
   on one host or dependency inside a window join one incident (a VPS outage fires Beszel, HyperDX and Kuma; one Issue
   of kind `incident`). The host and dependency map comes from a port (`IntakeTopology`: the manifests' `signals:`
   and `config/infra.json`'s hosts), the window a setting.
3. **Amend or new:** an owner or agent signal that matches an open Issue amends it: record `noted` on the Issue
   (`recordIn`), which reaches the lead through the machine's `note_lead`. Deterministic matching first; when unsure
   it asks the triage workflow through an `agw` port (a fake here; package 7 brings `factory-triage`).
4. **Quarantine:** an outside signal (others' GitHub issues, app feedback) is `held`: stored, never filed, until the
   owner or the Judge promotes it (a `promote` use case and route; package 6's Judge calls it later). Its text is
   fenced as data whenever it reaches a lead.
5. **Settle and heal** before any lead, as design §8 describes (grace, runbook outside any transaction, healed
   outcome, nothing filed when the source comes back up). An incident that heals before a lead starts closes as
   `healed` through the machine.
6. **Loop guard:** a change a loop made never fires that loop again (mark it in the envelope, refuse it in receive).
7. **Every source ported:** the door (Kuma, HyperDX), GitHub label and author mode, red checks, failed launchd jobs,
   Beszel with its rules and `infra.json` thresholds, and the GitHub write-back on close (marker comment, looked up
   first). A project hears only the sources its `signals:` lists; **a work repo hears only the owner** (NL18), so no
   poller reads one and every automatic signal for one is dropped with a reason.
8. **NL22:** the rule that a work repo's text never reaches agw is gone; do not port `scopeOf`'s withholding into
   intake. NL18 still holds.
9. `factory signal` (generated from your route) is how the owner, Hermes and agents put work in.

## Acceptance

- Scenario: a VPS outage's three alerts (Beszel, HyperDX through the door, Kuma through the door) inside the window
  make one incident Issue; their `up`s heal or amend it, never a second Issue.
- Scenario: an owner signal that matches an open Issue amends it: one `noted` event on that Issue, no new Issue.
- Scenarios for: a replayed signal is one effect; an outside GitHub issue is held until promoted; a heal runbook that
  fixes the symptom files nothing; a work repo drops an automatic signal; the door refuses a payload's repo.
- The pollers run against fakes of GitHub, Beszel and `launchctl` (record and replay of real shapes is fine; no
  network in tests).

## Out of scope

`settled` and admission (package 3: intake files, planning settles). The real `factory-triage` workflow (package 7).
Stop the line as a queue rule (package 3; intake only marks an Issue as an incident or episode). The Console.
