Branch: night-i-door
Title: feat(door): the factory door, alerts from the tailnet become Issues
Owned files: `packages/door/**` (new), `packages/contract/src/door.ts` (new) and its index export, `packages/server/src/issues/intake.ts` (new), `packages/server/src/socket.ts` and `http.ts` (the new routes only), `packages/server/migrations/` (new files only), `packages/cli/**` (`door` verbs), `packages/server/test/**`, `scripts/` + `deploy/` (the door's LaunchAgent, deploy and verify), `AGENTS.md` (pointer lines), `docs/design.md` §5 and §11. Never: `docs/waves/PLAN.md`, `docs/program.md`, `docs/evidence/**`, `packages/server/src/issues/lifecycle.ts` (use it, ask if it lacks something).

# Brief: I, the factory door (owner decision 2, 2026-11-01)

Read `AGENTS.md`, `docs/waves/night-2026-11-01.md` (decisions 2 and 3), `docs/design.md` §4 and §5, and `packages/server/src/issues/` (F2 Wave 1, live) first.
Today every alert goes to Slack only. The door makes a real alert one Issue. F3's dedup, settle and runbooks are out of scope; an
alert-born Issue only queues until F2 Wave 4 is live.

**The ingress is decided and already declared** (dotfiles-private, not your files): the door binds `127.0.0.1:8796`, `tailscale
serve` terminates TLS on the mini's tailnet name on 8796, the ACL gives `tag:homelab` and `tag:vps` that port and nothing else.
Same shape as dotfiles' `kuma-door/` (read it). So: loopback bind, never a tailnet address in code, and the port from
`FACTORY_DOOR_PORT` (default 8796).

## The door (`packages/door`, a process of its own)

- A Bun server with one route, `POST /alert/<source>`; everything else 404 or 405. `Authorization: Bearer <token>` checked
  against that source's token in constant time; 401 with no body otherwise. Body at most 64 KiB (413, enforced while reading, not
  from `Content-Length`), `application/json` (415). Never logs a body or a token.
- **Tokens:** `~/.config/factory/door-tokens.json` (`FACTORY_DOOR_TOKENS_FILE`), mode 0600, `{ "kuma": "...", "hyperdx": "..." }`,
  read at start. A file with looser mode or that does not parse: the door refuses to start. `factory door token new <source>`
  writes a fresh random token (32 bytes, base64url) into the file and prints it once; the owner seeds them into 1Password in the morning.
- **It holds no factory token and no database credential.** It posts one line to the server over the unix socket
  (`POST /intake`, `FACTORY_SOCKET`, the hook's boundary), so a compromised door can file Issues and nothing else.
  Socket down: 503, which Kuma retries; nothing is spooled.
- **Parsers per source** (pure functions, zod, tested with recorded payloads in `packages/door/test/fixtures/`): each maps a payload to
  `{ monitor, event, status: "down"|"up", title, facts }`. The payload is data: nothing in it picks a repo, a role, a path or a command.
  - `kuma`: Uptime Kuma's webhook provider (JSON with `heartbeat`, `monitor`, `msg`; a test message has both null: answer 200, file nothing).
    `monitor` = the monitor's name (ids change between syncs), `event` = `heartbeat.time`, status from `heartbeat.status` (0 down, 1 up).
  - `hyperdx`: HyperDX's generic webhook, whose body is a template the vps repo controls. Define the template you need
    (`{ "title": "{{title}}", "body": "{{body}}", "link": "{{link}}", "state": "{{state}}", "startTime": "{{startTime}}", "endTime": "{{endTime}}", "eventId": "{{eventId}}" }`;
    check the placeholders against the HyperDX version in `~/SourceRoot/vps/compose.monitoring.yml` with `/research`, never from memory)
    and write it in `packages/door/README.md`. `monitor` = the alert's title with its trailing numbers stripped, `event` = `eventId` plus start time.

## The server

- Migration: `factory.door_routes (source text, monitor text, repo text not null, primary key (source, monitor))`: the registry. Not in git:
  monitor names and repos are the owner's estate. `facts` of an Issue never contain a token.
- `POST /intake` on the socket only: `{ source, monitor, event, status, title, facts }` (zod). In one transaction, with the rule in `issues/intake.ts`:
  1. No route for `(source, monitor)`: no Issue. Upsert one row in `factory.door_unrouted (source, monitor, count, last_seen, last_title)`. Answer 202.
     Every alert the homelab has arrives here (Kuma attaches every provider to every monitor), so this is the common path, and it stays small.
  2. Routed, an Issue of this `(source, monitor)` that is not `closed`: the event is a `signal` inbox row (key `<source>:<monitor>:<event>`) on that Issue. 200.
  3. Routed, none open, `status` down: `createIssue` with `source: "alert"`, `source_key` `<source>:<monitor>:<event>`, `repo` from the route, `title`, `facts`. 201.
     The IuRoot refusal of Wave 1 applies; the route is refused when it is set, too.
  4. Routed, none open, `status` up: nothing but the unrouted-style counter on the route. 202.
- A replayed event is one effect (the keys). Never a port inside the transaction.
- `factory door route set <source> <monitor> <repo>|rm|list` and `factory door unrouted` on the token API (`PUT|DELETE|GET /door/routes`, `GET /door/unrouted`): the repo
  is resolved and checked against `FACTORY_REPO_ROOTS` like a spawn's (422).

## Running it

Its own LaunchAgent (`deploy/com.jkrumm.factory-door.plist` template, `launch-door.sh`), installed and restarted by `make deploy` from the same release directory,
`make verify` adds one line: the door answers 401 to an unauthenticated `POST /alert/kuma` on loopback. `DRY_RUN=1 make deploy` prints it. `GET` on the door has
no health route: the 401 is the health check. `make deploy` does not create tokens and the door not starting for lack of a tokens file fails the verify line with that reason.

## Tests

Through the public surface: the parsers on recorded payloads, a bad token, a body of 64 KiB + 1, a wrong method, loose mode on the tokens file; `/intake`'s four rules, a replay of each, the repo from a
payload ignored (a payload naming a repo or path has no effect), an unrouted monitor filing nothing, an IuRoot route refused. No test touches a real tailnet.

**Gate:** `make check` green, `/review` with findings fixed, one more `/review` pass on the fix commits. **Wait for every review run in the foreground** (`agw run wait <runId>`):
never end a turn while a background shell runs, the factory reads your idle prompt as finished and wakes the lead. Push the branch, open a PR (`gh pr create`, no attribution), don't merge or deploy.
End with a report: done / deferred, one line each, and the exact HyperDX template you settled on.
