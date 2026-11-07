# Architecture: the target of the rewrite

**A modular monolith on Bun: plain TypeScript and zod, Postgres as the only store, domains with no I/O behind ports,
Elysia at the edge, a generated CLI and a static Console served by the same process.** This is the target the rewrite
builds (`docs/rewrite.md`). Until the cutover, `docs/design.md` describes the running factory. Words follow
`docs/language.md`.

## What stays

Interactive Claude Code in herdr-core, one lead per Issue, the factory never calling a model, deterministic keys on
every effect, spool-first hooks with empty stdout, the advisory process lock, the loopback API, `secrets-run`, the
make contract (`check`, `test`, `deploy`, `verify`, `version`, `logs`), `FACTORY_REF=<branch>` deploys, and the
`factory role get <role> --format json` contract `rd` reads. The rules in `AGENTS.md` hold unless a decision says
otherwise.

## Layout

```
apps/
  server/     Elysia app: domains, application services, adapters; serves the Console build
  console/    Vite + React SPA (client only, holds no logic the API could hold)
  door/       alert door, unchanged in role: loopback, no token, posts signals
  cli/        `factory`, generated from the OpenAPI document plus the hook and slot verbs
packages/
  contract/   zod schemas: every request, response and event; the OpenAPI source
  client/     typed client for the Console (Eden) and the CLI's transport
tests/
  scenarios/  use cases run against a real server with fake hc and agw: the factory's acceptance suite
  e2e/        Playwright against the Console on a seeded server
```

## The server

```
apps/server/src/
  kernel/        Result, ids, clock, keys, the event envelope. Imports nothing else
  domains/       pure: types, rules, state machines, ports (interfaces). No I/O, no SQL, no Elysia
    intake/        signal envelope, trust, fingerprint, correlation into incidents, amend-or-new
    planning/      plans, the chain, queue order
    capacity/      accounts, windows, memory, load, repo claims, test slots
    work/          the Issue: the total state machine and its events
    leads/         attempts, briefs, notes, session state derived from hook events
    quality/       gates: evidence, watch, verify, review as evidence
    checkpoints/   decisions, artifacts and revisions, annotations, verdicts, errands, the ledger
  app/           use cases that coordinate domains in one transaction, then run effects
    loops/         steward, judge, triage, queue, friction, hygiene: each a tick with a budget
  adapters/      postgres repositories, hc runner, agw, git, gh, ntfy, tailscale, filesystem
  api/           Elysia route groups per domain, the stream, auth, Console static files
  read/          read models (SQL views and projections) for the API: flow, chain, needs, kpis
```

**Rules, enforced in `make check` by a boundary script:**

- `domains/*` import only `kernel` and their own folder. A domain reaches another only through `app/`.
- Each domain owns its tables. Cross-domain SQL lives in `read/` and is read-only.
- A port is an interface in its domain; an adapter in `adapters/` implements it; tests use fakes of the same interface.
- Only `app/` opens a transaction. A port is never called inside one: claim, commit, call, record.
- Every port returns `Result<T, PortError>`; only a programming error throws.

```ts
type PortError = { kind: 'timeout' | 'gone' | 'refused' | 'unreadable'; detail: string }
type Result<T> = { ok: true; value: T } | { ok: false; error: PortError }
```

## The Issue state machine

States: `settling`, `queued`, `working`, `waiting`, `watching`, `closed`. The machine is a total table: every
`(state, event)` cell is written down, and a missing cell fails `tsc`.

```ts
type Cell =
  | { to: State; reason?: WaitReason; effects: Effect[] }
  | { refuse: string } // the verb's error, named
  | { ignore: string } // why this changes nothing
const TABLE: { [S in State]: { [E in EventKind]: (ctx: Ctx) => Cell } } = {
  /* every cell */
}
```

- **Pure:** `apply(state, event)` returns the next state and effects; `app/` stores the event, the new state (`UPDATE
  ... WHERE id = $1 AND version = $2`) and the effects in an outbox in one transaction, then runs the effects.
- **Model test:** a seeded generator plays random event sequences and checks invariants: a machine wait always has an
  exit that needs no person; a wait on the owner always states what it holds; a closed Issue reopens only by its verb.
- **Diagram:** generated from `TABLE` into `docs/language.md`, so the words and the code cannot drift.
- No XState, no workflow engine. Events in Postgres plus a row version are the whole mechanism.

## Signals and triage

Every input is one envelope and goes through `intake.receive`:

```ts
const Signal = z.object({
  source: z.string(), // kuma, hyperdx, beszel, github, feedback:<app>, owner:hermes, agent:<repo>
  kind: z.enum(['alert', 'request', 'feedback', 'remark']),
  origin: z.enum(['you', 'application', 'infrastructure', 'github', 'feedback', 'factory']),
  trust: z.enum(['owner', 'machine', 'agent', 'outside']),
  repo: z.string().nullable(), // from the route or the caller, never from an outside payload
  fingerprint: z.string(),
  title: z.string(),
  text: z.string(),
  link: z.string().nullable(),
})
// receive(signal): 'filed' | 'amended' | 'incident' | 'held' | 'dropped'
```

- **Correlation:** alerts on one host or dependency inside a window join one incident (the VPS down fires Beszel,
  HyperDX and Kuma; one Issue). The host and dependency map comes from the manifests; the window is a setting.
- **Amend or new:** an owner or agent signal that matches an open Issue amends it and reaches its lead as a note;
  deterministic matching first, the triage workflow when unsure.
- **Quarantine:** an outside signal (others' GitHub issues, app feedback) is held and reaches a lead only after the
  owner or the Judge promotes it, fenced as data.
- **Loop guard:** a change a loop made never fires that loop again.
- A project's `signals:` lists the automatic sources it hears. Work repos hear the owner only.
- `factory signal` is how the owner, Hermes and agents put work in. `factory issue new` remains for plan rows and
  the rewrite orchestrator.

## Loops and agw

Each loop is an `app/loops` tick with a trigger and a budget. Its deterministic part runs in the server; its judgment
is a dedicated agw workflow with its own prompt, tools and skills (`agent-workflows`), called through the agw port
with a 30-minute hang guard.

| Loop | Deterministic | agw workflow |
|-|-|-|
| Steward | wake, re-check, requeue, deliver | `factory-steward`: what a stalled Issue needs when the rules do not say |
| Judge | standing policy in `project.yaml`, precedent lookup (Postgres text search) | `factory-ask`: Haiku high, reads the plan, docs and precedents |
| Triage | fingerprint, routes, correlation window | `factory-triage`: kind, origin, size, amend-or-new, likely `after` edges |
| Queue | cycle check, real blockers | `factory-queue`: proposed edges and order; never overrides the owner's `prio` |
| Friction | SQL view over the event log, thresholds | weekly pattern pass |
| Hygiene | `make check`, outdated deps, retired words, broken links, co-change scan | staleness, unslop, untangle findings |

A Decision goes through: standing policy, then the lead's own required fields (recommendation, what it checked, cost
per option, consequence of no answer), then the Judge, then the default after a wait when the option is reversible,
then the owner. The owner's line (ntfy) carries checkpoints only.

## API, client, CLI

- **Elysia** (as Argo and Iris) with zod through Standard Schema, `@elysiajs/openapi` for the document,
  `@elysiajs/eden` for the Console's typed client. Versions are checked when the skeleton is built.
- **The CLI is generated** from the OpenAPI document, one command per operation, keeping agw's contract: `--format
  json|plain`, data on stdout, messages on stderr, the exit codes, never a prompt. The hook, slot and role verbs stay
  hand-written where their contracts demand it.
- **One contract** in `packages/contract` builds every body; a body that does not parse is exit 9.
- The hook socket stays a plain `Bun.serve` unix listener: its contract (mode 0600, empty stdout) does not change.
- Reads cover needs, since a cursor, flow, chain, Issues, sessions, artifacts, signals, kpis, friction and the stream.
  Writes the Console may use: answer, verdict, comment, note, cancel, errand done, promote.

## Perimeter

The API stays loopback. A second loopback listener serves the Console and its routes and is published with
`tailscale serve` (HTTPS on the tailnet, so the PWA installs). The tailnet is the perimeter, and the listener accepts
only requests carrying the owner's `Tailscale-User-Login`, because other tailnet nodes (servers) must not reach a
process that can start Claude Code. That listener can never spawn a session.

## The Console

| Layer | Choice |
|-|-|
| Build | Vite 8, React 19, TypeScript strict |
| Primitives | `@base-ui/react` with shadcn components (`shadcn init -b base -t vite`) in the repo |
| Style | Tailwind 4, Basalt's tokens (`basalt-ui tokens:css --only core`) through an `@theme inline` bridge, Basalt's fonts, Phosphor icons; a test fails on any raw colour |
| Routing | TanStack Router: typed search params, deep links from ntfy and Herdr |
| Server state | TanStack Query, invalidated from the event stream; polling is the fallback |
| Tables | TanStack Table and Virtual; cards under a breakpoint |
| Forms | TanStack Form with the contract's schemas |
| Chain | `@xyflow/react` with `@dagrejs/dagre` |
| Keys, palette | TanStack Hotkeys (pre-1.0, pin exactly), `cmdk` in a Base UI dialog |
| Local state | a small store on `useSyncExternalStore` |
| PWA | `vite-plugin-pwa`; the last snapshot shown with its age when offline; no Web Push |

The Console stays thin: every rule, filter and number comes from the API. Patterns come from the owner's work chat
UI (shell, tokens, primitives) and Argo (TanStack wiring); no code is copied from the work repo.

**Artifacts** are Markdown or HTML made from shared templates in Basalt's look, so a lead produces them easily and
they render and annotate the same way. Markdown renders in the page through a sanitiser; HTML runs in a
`sandbox="allow-scripts"` iframe with a network-blocking CSP and an injected annotator that posts selections out.
Anchors are a quote plus a path, with an "Unanchored" group as the fallback.

## Data

Blobs (artifact revisions) live under the factory's data directory, never in git. The cutover imports Issues, events,
decisions and evidence from the current schema so the KPIs keep their history; everything else is rebuilt. Usage and
cost come from the `usage` schema by join, never copied.

## Tests

- **Unit** where logic is pure and dense: the state machine, correlation, gates, the queue order.
- **Model test** of the state machine.
- **Scenarios** (`tests/scenarios`): use cases end to end against a real server and Postgres with fake hc and agw.
  They are the acceptance suite, and a lead runs the ones its change touches as its proof.
- **E2E** (`tests/e2e`, Playwright) for the Console's flows; the verifier adds screenshots per change.
- `make check`: frozen install, oxfmt, oxlint (type-aware), `tsc`, the boundary script, the retired-word check,
  `bun test`, scenarios. E2E runs in `make check` once the Console exists.
