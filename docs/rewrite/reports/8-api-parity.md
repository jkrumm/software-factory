# Package 8: API, read models, CLI parity, report

**Done: every call a client makes today has an answer on the new server or a named replacement, the token is in front of everything but `GET /health`, the read models and the change stream exist, and the scaffolding is gone.** Branch `rw/8-api-parity` on `a586828` (the brief). Each client group runs against the real server process in `tests/scenarios/clients/`; `make check` is green (output below).

## What changed

- **Auth (`apps/server/src/api/{auth,policy,errors}.ts`, `settings.ts`)**: four callers by bearer token, compared in constant time: `owner` (`FACTORY_TOKEN`, required), `agent` (`FACTORY_AGENT_TOKEN`, a lead session's), `machine` (`FACTORY_DOOR_TOKEN`, the alert door's), `read` (`FACTORY_READ_TOKEN`). Tokens are at least 16 characters and pairwise different. **One policy table** (`policy.ts`) holds a row per route; a route without a row is 403 for everyone, a request without a valid token is 401 on every route but `GET /health`, an unknown path included. A test walks the OpenAPI document and fails on a route without a row. Classes: read (`GET /v1/*`: owner, agent, read), lead verbs (owner, agent), machine (exactly `POST /signals/alerts` and `POST /door/reports`, the owner too), owner only (everything else). Whole texts of Decisions, artifacts, pages and Errands are kept off the read row: the read token sees them only through the read models. The hook socket is untouched (mode 0600).
- **Signal trust follows the token** (`app/intake.ts` `envelopeOfRequest(body, caller)`): owner token gives `owner`, agent token `agent`; the claimed `from` only lowers (`from: owner*` under the agent token is 403 `trust_refused`; `from: feedback:<app>` is `outside` under any write token). The door's route is `machine`.
- **Errors**: `ErrorBody` gains `details` (a refused Decision form carries `details.fields`, a cycle `details.path`); every route declares 400/401/403/404/409/422/500/503 bodies (`errorResponses`); a response the contract refuses is a 500 `invalid_response`. The CLI prints data on stdout for a 2xx only and every failure as one JSON line on stderr with its code and details. One exception, documented in `operation.ts`: `health get` on a 503 still prints the Health body on stdout (the Uptime pusher and `verify.sh` read it) and the error line on stderr.
- **Generated CLI (`apps/cli`)**: every body property is a flag (`--commit a --commit b`, JSON for objects, `--body '<json>'` still works), a route may declare `x-cli: { args: [...] }` so body fields are positional (`issue note <id> <text>`, `queue set drain`), a string or JSON value takes `-` for stdin and `@path` for a file, bare boolean/single-value query flags (`read sessions --live`), per-command `--help`, two-stage parse per operation. Hand-written: `health` alias, `read issue(s)` aliases, `follow` (SSE with cursor resume and backoff), `door token new`, `slot run` (bearer; an auth outage fails open), `hook`, `role`. **Retired commands answer with a hint** (`apps/cli/src/retired.ts`), exit 2.
- **Lead verbs and the brief**: `issue ship|close|defer|block|ask|show`, `artifact submit|revise|show`, `errand raise`, `signal file`, all in plain flag form, all listed in the brief's standing orders (`domains/leads/brief.ts`); the brief says answers, verdicts and Watch failures arrive as notes and that a `changes` verdict means `artifact show` then `artifact revise`; an Issue filed from alerts gets the signals' text and facts in its brief (new leads port `signalsOf`, adapter reads `intake_signals`). A lead's terminal gets `FACTORY_TOKEN` (the agent token) and `FACTORY_URL`. `factory issue show` takes `issue_<n>` and the bare number, as does every route with an Issue id.
- **Owner verbs**: `issue new|cancel|note [--wake]|answer|reopen|prio`, `session note`, `artifact verdict|annotate`, `errand done`, `signal promote`, `queue set run|pace|drain [--project]`, `door token new`.
- **Read API (`apps/server/src/read/`, `api/read.ts`, `api/read-models.ts`, `packages/contract/src/read*.ts`)**: legacy-compatible `/v1/overview|issues|issues/{id}|sessions|sessions/{id}|asks|health|accounts` (numeric `id` kept, `ref: "issue_12"` added), the new `/v1/needs|flow|chain|kpis|friction|signals|changes`, `loop list` kept. Titles and summaries are plain words. KPIs: usage and cost by join from the `usage` schema, `null` and `measured: false` when it is absent. Under the read token a **work repo** (any repo no `project.yaml` describes; one fail-closed rule in `read/work.ts`) loses titles, summaries, repo names and queue messages everywhere; `/v1/signals` loses every word.
- **The stream** (`migrations/0800_changes.sql`, `read/stream.ts`): `factory.changes` filled by triggers on the Issue events, hook events, Decisions, artifacts and revisions, verdicts, annotations, Errands and signals; frames carry kinds, ids and states only. The cursor is `<txid>.<seq>`; a reader emits only rows whose transaction id is below the snapshot horizon, in that order, so a late commit can never appear behind a row already sent. `GET /v1/stream` (SSE, `since` or `Last-Event-ID`, `hello` first, keepalive every 15 s, 410 `cursor_gone`) is hidden from the OpenAPI document; `GET /v1/changes` is the same rows as a poll. Needs PostgreSQL 13+.
- **`/health`**: the heartbeat names are unchanged; additive `lines` (the door's health lines) and `loops` (state of each loop). They never change `status`.
- **Scaffolding**: the internal test routes, the leads-tick route and `FACTORY_CLOCK_OFFSET_MS` are gone. The scenarios drive real routes and the CLI through `tests/scenarios/flow.ts`. A test clock remains only as `FACTORY_TEST_CLOCK_OFFSET_MS`, which `loadSettings` refuses without `FACTORY_TEST_MODE=1`. `reportRegression` and the other dead exports `/analyze` (fallow) found are deleted.
- **Tests**: scenarios per client group in `tests/scenarios/clients/` (`lead`, `dotfiles` through the real scripts with a `factory` shim, `replay` of the recorded requests), `verbs/`, `read/`, plus unit tests per module.

## Parity inventory

Legacy = the running core's CLI and API. "Works" means the client's call, flags and the fields it reads run against the new server in `tests/scenarios/clients/` with the token the client has or needs.

### Lead verbs (standing orders)

| Legacy | New | Status |
|-|-|-|
| `issue phase <id> --phase --note` | derived from state (`phase` on the cards) | retired, hint |
| `issue ask --question --option --default --expires` | `issue ask <id> --attempt --question --recommendation --checked --options '<json>' --no-answer '<json>'` | works (a Decision is a form) |
| `issue wait --until` | `issue defer <id> --attempt --until` or `--after issue_5` | works |
| `issue ship --summary --commit --evidence` | `issue ship <id> --attempt --call --commit …` | works; evidence kinds retired, the review is recorded as evidence (NL23) |
| `issue close --summary --commit\|--document` | `issue close <id> --attempt --outcome done\|dropped --reason` | works |
| `issue block --reason`, `issue drop --reason` | `issue block <id> --attempt --reason`; drop is `close --outcome dropped` | works / retired, hint |
| `issue evidence --kind --link` | the merged commits and the lead's review | retired, hint |
| `issue show <id>` | `issue show <id>` (`issue_12` or `12`) | works |
| (none) | `artifact submit\|revise\|show`, `errand raise`, `signal file`, `lead get` | new |

### dotfiles, the Herdr board, Hermes, Iris, agw, repo scripts

| Client file:line | Call | Fields read | Auth today | New answer | Status |
|-|-|-|-|-|-|
| `scripts/remote-dev.sh:75` | `role get <role> --format json` | role, tier, effort; `error.kind` | none | same, hand-written, unchanged | works; unknown role exit 4 |
| `remote-dev.sh:435` | `health` | exit code | none | `health` alias of `health get` | works |
| `remote-dev.sh:836` | `session note <key> <text>` | exit code, `error.kind not_found` | socket | `session note <session> <text>` | works with change: needs `FACTORY_TOKEN`; a non-lead session is 404 and `rd say` falls back to `hc send` |
| `remote-dev.sh:913` | `issue new --repo --title --after --key --facts -` | stdout, exit | socket | same flags, JSON on stdin | works with change: needs the owner token |
| `remote-dev.sh:924` | `issue list` | stdout | socket | `issue list` | works with change: needs the owner token; the body is `{issues:[cards]}` |
| `scripts/ask-human.sh:680` | `session note <s> <text> --id ask-human-<id>` | exit code | socket | same (`--id` is an alias of `--call`) | works under the agent token a lead's pane carries |
| `hooks/test-slot.ts:209` | `slot run --name … -- …` | exit code | socket | same | works; with no token it runs the command and prints one line |
| `hooks/review-bypass-guard.ts:52` | names `factory issue ask` | none | none | exists | works |
| `config/settings.template.json:129-206` | `hook <6 events>` | none | socket | unchanged | works |
| `jk-board/main.js:32` | `read overview`, `read issues --state all --limit 40`, `read sessions --live` | counts, humanQueue, issues[], card fields | full token | same commands, same routes | works |
| `jk-board/main.js:171` | `read issue <id>` | timeline, sessions, asks | full token | alias of `issue show` | works |
| `jk-board/main.js:39` | `fleet --refresh` | none | full token | `read overview` | retired (exit 2, hint) |
| Hermes `skills/fleet/SKILL.md:21-27`, `scripts/hermes-ops.sh:677` | `read overview\|issues\|issue\|asks\|sessions --live\|health` | the jq list in the skill | read token | same | works; work-repo words hidden |
| Hermes `skills/fleet/SKILL.md:58` | `issue new --repo … --facts -` | exit code | socket | `signal file --from owner:hermes` under an owner token | works with change |
| Iris `factory-http.ts:160,169,175` | `GET /v1/overview`, `/v1/asks`, `/v1/issues/{n}` | builtAt, asks[], health[], options, answer | full token | same routes | works; both `12` and `issue_12` answer |
| Iris `factory-http.ts:182` | `POST /issues/{n}/answer {id, answer}` | `issue`, `state`, `duplicate` | full token | same route, reply `{decision, issue:{id,state,…}}`; a repeat is 409 `no_open_decision` | works with change |
| Iris `factory-http.ts:193` | `GET /v1/stream?since=` | event, id | full token | same route, new cursor `<txid>.<seq>` | works; resume loses and doubles nothing |
| agw `agents` | `read overview`, `read sessions --live` | asks, humanQueue, session cards | full token | same | works |
| Argo | none (grep for `7793`, `FACTORY_`, `/v1/`, `factory read` finds nothing) | | | | no call |
| `scripts/verify.sh:38,66,72` | `/health`, `GET /spawns` without a token, `health` | status, version, 401 | none | same | works (an unknown path without a token is 401) |
| `scripts/verify.sh:73` | `spawn list` | none | full token | `capacity get` | retired, hint |
| `scripts/deploy.sh:160` | `/health` | status, version | none | same | works |
| `devhost-health-check.sh:1313` | `GET /health` | heartbeat names | none | same names | works |

### Legacy surface with no client and no counterpart

| Legacy | Replaced by |
|-|-|
| `spawn list\|create\|get\|cancel\|requeue` | admission starts leads; `signal file`, `issue new`, `capacity get`, `queue get` |
| `fleet`, `status` | `read overview` |
| `session list\|get\|wait` | `read sessions`, `read session <id>`; a lead stops with `issue defer\|block\|ask` and the Stop hook sees background work |
| `issue facts` | `read kpis` |
| `issue stop` | `issue cancel` |
| `issue resume` | not rebuilt |
| `notify list\|test` | `page list`; `notify test` not rebuilt |
| `quota get\|refresh` | `capacity get\|refresh` |
| `door route set\|rm\|list`, `door unrouted` | `door route-set\|route-remove\|routes` |
| `read alerts`, `/v1/alerts` | not rebuilt (no client calls it; the alerts topic is ntfy's) |

## `make check` output

MAKE_CHECK_TAIL

## Ports declared

None new. The leads domain gets `signalsOf` (the signals an Issue was filed from, for the brief), implemented by `adapters/leads/store.ts`. The read models are read-only SQL in `read/` and import types only.

## Events recorded on Issues, and from which use case

No new kind. `issue new`: `filed` (owner) and a `noted` with the request text and facts (as plan rows do). `issue cancel`: `cancelled` (owner). `issue note`: `noted` (owner), with `--wake` also `woken` (a refusal of the wake is reported, the note stands). `session note`: `noted` (owner for the owner token, `factory` for the agent token, fenced as data). `issue answer`: the checkpoints' `answered` through `decision.answer`'s use case. `issue reopen`: `reopened` (quality).

## Review

REVIEW_OUTCOME

## Open points

1. **Package 9, client changes** (each one line):
   - `iris/server/src/adapters/factory-http.ts:68`: `AnswerAck` parses `{decision:{id,answer,…}, issue:{id:"issue_<n>",state,…}|null}`; take the number from `issue.id`.
   - `iris/server/src/adapters/factory-http.ts:182`: treat 409 `no_open_decision` as the old `duplicate: true`.
   - `hermes-agent/skills/fleet/SKILL.md:58`: file with `factory signal file --from owner:hermes --repo <repo> --title … --text …` under `FACTORY_TOKEN`; `issue new` needs the owner token now (Hermes holds only the read token).
   - `dotfiles/config/herdr-app/mods/jk-board/main.js:39`: drop `fleet --refresh`.
   - `dotfiles` skills `wave` and `remote-dev` and `docs/remote-dev.md` teach `issue evidence|stop|resume`, `session wait`, `status`: replace with `issue cancel`, `read overview`, `issue defer`; `scripts/remote-dev-factory.test.sh:43` stubs a `spawn create` that `rd` never calls.
   - `rd` (`issue`, `issues`, `say`) and Hermes ran on the socket with no token: they need `FACTORY_TOKEN` (`secrets-run`). `slot run` callers without a token (the Makefile's `SLOT`, Iris `apple-slot`, agw `run-step.sh`) now run their command unslotted with one stderr line until they get one.
2. **Package 9, this repo**: `scripts/verify.sh:73` (`spawn list`), the gameday scripts (`spawn`, `session`, `quota`, `issue stop`), `scripts/launch-door.sh` and the deploy script (`apps/door` needs `FACTORY_DOOR_TOKEN`), `scripts/env-file.sh` allow-list: `FACTORY_TOKEN`, `FACTORY_AGENT_TOKEN`, `FACTORY_DOOR_TOKEN`, `FACTORY_READ_TOKEN` (secrets, from `.env.tpl`: create `FACTORY_AGENT_TOKEN` and `FACTORY_DOOR_TOKEN` in the `software-factory` item), `FACTORY_STREAM_POLL_MS`. `FACTORY_TEST_MODE` and `FACTORY_TEST_CLOCK_OFFSET_MS` are never allow-listed. Install the new CLI at `~/.local/bin/factory` (report 0, point 11).
3. **`AGENTS.md` contradicts the new core** and is package 9's: "the door holds no factory token" (it holds `FACTORY_DOOR_TOKEN` now and refuses to start without it), "token or socket" for `issue new`, `/fleet`, the read token section (now: GET `/v1/*` only, text of a work repo hidden by one rule), the settings list, `docs/design.md` §11 for the read API.
4. **A card's `visible` is true for any repo no `project.yaml` describes**, including a personal repo not yet synced; the owner still sees the words, only the read token loses them. The legacy flag meant IuRoot only. A display consequence for the board; the safe side.
5. **`/v1/sessions` ids are lead keys** (`lead-<n>-<attempt>`); `address`, `tab`, `status` are kept flat for the board. Insights beyond elapsed, working time, turns and attempts are zeros with `partial: true` (tool calls, subagents, tokens). `spawns` in `overview.queue` is always empty.
6. **New words** for `docs/language.md`: *caller* (owner, agent, machine, read), *needs*, *flow*, *change* and *cursor* (the stream), *work repo* (a repo no `project.yaml` describes), *positional argument* as a CLI form is not a word of the language.
7. **Definitions chosen** (the response says them in `definition`): an avoidable touch is an owner-answered Decision not marked worth asking, plus owner `noted`, `woken`, `cancelled` and `reopened`; a verdict and a done Errand are not counted. First pass is a first Watch that passed. Fix commits per week are not measured.
8. **`issue answer` keeps `{id}` in the path** (Elysia refuses another parameter name at the same position) and accepts Iris's body `id` as a loose key; a retried answer is 409.
9. **A lead whose Issue waits on an open Errand cannot `defer` or `close`** (409, "taken only from a timed wait"): the machine's table, left as it is.
10. **`queue get --project` narrows the answer to that project's row** and does not compute the effective state.
11. **The reviewer drops files on the first pass of a large range** (160 files); a second attempt with the list requirement spelled out was needed (see Review).
