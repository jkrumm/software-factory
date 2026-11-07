# Package 8: API, read models, CLI parity

**Every call a client makes today runs against the new server: the lead's verbs, `rd`, the hooks and guards in
dotfiles, Hermes, Iris, Argo and the Herdr board. Add the read models and the stream the architecture names, put the
token in front of everything, and clear the debts packages 0 to 7 left for this package.** Branch `rw/8-api-parity`.
Review: deep, `--thread rw-8-api-parity`. After this package the cutover only switches what runs.

## Read first

`docs/rewrite.md`, `docs/architecture.md` (§API, client, CLI; §Perimeter; §Data), `docs/language.md`,
`docs/product.md`, `AGENTS.md` (the CLI contract, the role contract, the token rules, the read token, the heartbeat
names), `docs/rewrite/learnings.md` (every "for package 8" line is yours), and the reports
`docs/rewrite/reports/{0..7}-*.md` (their open points). The running core's API, to match: `docs/design.md` §11 "The
read API", "The read token", "The fleet view"; `legacy/server/src/{http,status}.ts`, `legacy/server/src/read/`,
`legacy/cli/src/{run,read,client}.ts`.

## Build

1. **The parity inventory first**, as a table in your report: every call each client makes to the factory today
   (command or route, flags, the fields it reads), and the new command or route that answers it. Clients to sweep:
   lead briefs and standing orders (what a lead is told to run), `~/SourceRoot/dotfiles` (`scripts/remote-dev.sh`
   and its tests, `scripts/ask-human.sh`, `hooks/test-slot.ts`, `hooks/review-bypass-guard.ts`, the hook settings
   that run `factory hook`), `~/SourceRoot/hermes-agent`, `~/SourceRoot/iris`, `~/SourceRoot/argo`, the Herdr board
   (find where it reads the factory: dotfiles or the herdr app). A call with no answer in the new core is built, or
   listed with the reason it retires and what replaces it. You change only this repo; a client that must change
   gets a precise line in your report for package 9.
2. **Auth:** the bearer token on every route but `GET /health`; the read token passes on `GET /v1/*` only; the hook
   socket keeps its own contract (mode 0600 is its credential). **Signal trust comes from the token, never from the
   caller's claimed `from`** (report 2, open point 5): the owner's token is `owner`, an agent's lead session is
   `agent`, the door's route is `machine`. The slot and planning routes take the token too. The perimeter's Console
   listener is not yours (it comes with the Console).
3. **Errors:** declare the error bodies in every route's OpenAPI responses; the generated CLI prints data on stdout
   and every failure on stderr as one JSON line with its code (agw's contract), including a refused Decision form's
   fields and a cycle. A response the contract refuses is a 500, not a 422 (report 0, open point 6).
4. **Lead verbs and the brief:** every verb a lead uses exists with a plain CLI form (positional ids, flags; `--body`
   JSON only where a form is genuinely structured, like a Decision), and the brief's standing orders list them all:
   `ship` (5), `ask`, `artifact submit|revise|show`, `errand` (6), `close`, `defer`, `block` (4). `factory issue show`
   takes `issue_<n>` and the bare number. The brief tells a lead that answers and verdicts arrive as notes and how to
   read an artifact; an Issue's alert facts come from `intake_signals` into the brief.
5. **Owner verbs:** `cancel` (the `cancelled` event), `note` (with `--wake`), `reopen`, `answer`, `verdict`,
   `comment`, `errand done`, `promote`, `prio`, `queue set run|pace|drain` (global and per project, the cutover needs
   it), `door token new`.
6. **Reads and read models** (`read/`, SQL views and projections, read-only): needs (what waits on the owner), since a
   cursor, flow, chain, Issues, Issue detail, sessions, artifacts, signals, KPIs (the `docs/product.md` table, usage
   and cost **by join** from the `usage` schema, NL20, never copied), friction (counts first), loops (report 7), and
   **the stream** (one change stream the Console and the Herdr board follow, server-sent events with a cursor so a
   reconnect resumes). Titles and summaries in plain words, no ids as display text (RS13).
7. **`/health`:** keep the heartbeat names; add the door's health lines (report 2, open point 7) and the loops' state
   without breaking the pusher's fields.
8. **Clean the scaffolding:** the internal test routes and `FACTORY_CLOCK_OFFSET_MS` go; the scenarios drive the real
   routes and CLI (a test clock may remain only behind a setting the server refuses outside tests, named so). Delete
   `reportRegression`'s reopen half (no caller, report 5). Run `/analyze` once over `apps/` and `packages/` and remove
   what it finds dead.

## Acceptance

- The parity table is complete, and **each client's calls run against the new server**: a scenario per client group
  (lead verbs through a fake lead's CLI calls; `rd --role` and the dotfiles hooks through their real scripts with
  `PATH` pointing at the new CLI where they shell out; Hermes, Iris, Argo and the Herdr board through their recorded
  requests replayed against the read API with the read token).
- A request without a token is 401 on every route but `/health`; the read token is refused on writes; a signal's
  trust follows its token.
- The stream resumes from a cursor without losing or doubling an event.
- `make check` green, output in your report.

## Out of scope

The Console and its listener. Changing other repos (list the changes for package 9). Deploy scripts and the import
(package 9). New loops.

## Finish

As `docs/rewrite/briefs/parallel.md` §Finish says, with `docs/rewrite/reports/8-api-parity.md`. You are the only
package running: shared files are yours, keep each domain's code where its package put it.
