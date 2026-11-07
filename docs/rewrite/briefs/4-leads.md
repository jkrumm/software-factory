# Package 4: Leads

**Run the lead of an attempt and follow it: the hc runner, the brief in the new words, notes, the hooks with their
spool and socket (contract unchanged), session state derived from hook events, and the send-back.** You implement the
work domain's effect ports `start_lead`, `note_lead` and `finalize`, and the lead's own verbs. Branch `rw/4-leads`.
Review: deep.

Read `docs/rewrite/briefs/parallel.md` first: its rules hold here and are not repeated.

## Port from

`docs/architecture.md` §What stays (interactive Claude Code in herdr-core, spool-first hooks with empty stdout,
deterministic keys), §API (the hook socket stays a plain `Bun.serve` unix listener); `docs/language.md` (Lead,
Attempt, Review, Stall); `AGENTS.md` (the hook rules, verbatim: they do not change); `docs/design.md` §3 "Sessions and
events", "Derived session state", "As built" (runner, spaces, hooks and socket, prompts, spool, witness), §4 "Attach
or start", "The lead's verbs", "The send-back", "Finalize once", "Resume", "Notes", §5 "The lead's job", "The brief",
"Following a lead"; `legacy/server/src/{hc,hc-runner,hc-events,runner,spawns,sessions,spool,witness,screen,prompts,
briefs,spaces}.ts`, `legacy/server/src/issues/{lead,brief,follow,resume,sendback,lead-activity,leadtree,names,
worktree,finalize,timers,verbs}.ts`, `legacy/cli/src/hook.ts`, `config/roles.json`.

## Yours

`domains/leads/`, `app/leads*.ts`, `adapters/hc/`, `adapters/git/` (worktrees), `adapters/socket/` (the unix listener),
`api/leads.ts`, `packages/contract/src/leads.ts` (and the spool's shape, kept byte-compatible), the hand-written
`factory hook <event>` verb in `apps/cli` (it imports only `node:fs` and the contract's spool module, keeps stdout
empty for every event, exits 0 whatever happens but the Stop send-back's exit 2, the one compact line), migrations
`0400`+.

## Build

1. **The runner** over `hc`: a terminal carries `factory.key=<spawn key>`, the runner looks before it acts, so a
   replayed `start_lead` never spawns twice. The lead is interactive Claude Code with the role table's tier and
   effort, in its worktree `factory/<issue>-<attempt>`, in the project's space. Never `claude -p`.
2. **The brief** in the language's words (Issue, lead, attempt, Decision, Errand, Watch, Verify, review once per ship
   range, standard or deep, NL12 and NL23), built from the Issue's events: title, kind, origin, every note recorded
   before the attempt started, fenced outside text.
3. **Notes:** `note_lead` delivers the events from `from` to `version` (report 1, effects) through `hc send`, keyed so
   a replay types nothing twice; a lead mid-turn gets it at its turn's end.
4. **Hooks, spool and socket:** the contract does not change (mode 0600, empty stdout, spool first, then post). Session
   state is derived from hook events when read: working, idle, compacted, gone.
5. **Lead verbs and events:** `lead_started`, `lead_gone` (a lost terminal, a failed spawn), `stalled` with cause
   `unreported` (a stop without a verb) and `wall` (the account's window; the window itself is capacity's, read
   through a port), `deferred` (the lead's timed or `after` wait), `closed` by the lead (done or dropped). The
   send-back on Stop. `finalize` once per attempt: terminals, transcripts, worktree, the repo claim (through a
   capacity port).
6. **`/health` tick staleness**, if your package brings the tick that runs the outbox (report 0, open point 5): add it
   with the heartbeat names unchanged. If the tick belongs better to package 7's loops, say so and leave it.

## Acceptance

- Scenario: start: `admitted` runs `start_lead`, the fake hc shows one terminal with its key, `lead_started` recorded.
- Scenario: note: an owner signal's `noted` reaches the lead once, also when the outbox runs twice.
- Scenario: compact: a `session-start` with `source: compact` prints the one line, every other hook prints nothing.
- Scenario: lose a terminal: `lead_gone`, a new attempt up to the limit, then a stall.
- Scenario: replay a tick: run the outbox and the hook replay twice; nothing doubles (terminals, notes, events).

## Out of scope

Ship, watch, verify, evidence (package 5). Asks, artifacts, errands (package 6). The steward (package 7). The read
API and stream (package 8).
