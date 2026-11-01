# factory door

The one way an alert from the tailnet becomes a factory Issue. A Bun server of its own, one route: `POST /alert/<source>`.
It holds no factory token and no database credential: it posts one line to the server's unix socket (`POST /intake`). That
socket is the hook's, a same-user boundary (SF11), so a compromised door has what any pane has: it can call the socket's other
routes too (`POST /issues`, `POST /spawns`), but it has no token, no database access and no write to the queue. Design and rules: `docs/design.md` §11.

```
Kuma / HyperDX ──TLS──▶ tailscale serve ──▶ 127.0.0.1:8796 (the door) ──unix socket──▶ the server (POST /intake)
```

## Ingress

The door binds `127.0.0.1` and `FACTORY_DOOR_PORT` (default 8796), never a tailnet address. `tailscale serve` terminates TLS
on the mini's tailnet name; the ACL gives `tag:homelab` and `tag:vps` that port and nothing else (the same shape as dotfiles'
`kuma-door/`; those files are not in this repo).

## What a request passes

In this order: the route (`/alert/<source>`, else 404; another method 405), the source's bearer token in constant time
(401 with no body, an unknown source too), `application/json` (415), at most 64 KiB counted as the bytes arrive (413), valid
JSON of the source's shape (400). Then the source's parser, then the server. The door never logs a body or a token.

| Server | Door answers |
|-|-|
| 201 an Issue was created, 200 attached to an open one or replayed, 202 counted | the same status, `{ "outcome": ... }` |
| 422 refused (a route into IuRoot, outside the roots) | 422, no reason |
| unreachable, or 5xx | 503 (Kuma retries; nothing is spooled) |
| any other answer | 502 |

A Kuma test message and a beat that is neither down nor up (pending, maintenance) answer 200 and file nothing. There is no
health route: the 401 to an unauthenticated `POST /alert/kuma` is the health check (`make verify` does exactly that).

## Tokens

`~/.config/factory/door-tokens.json` (`FACTORY_DOOR_TOKENS_FILE`), mode 0600, read at start:

```json
{ "kuma": "<token>", "hyperdx": "<token>" }
```

A file with a looser mode, one that does not parse, a missing file and one with no source all make the door refuse to start,
with the reason on stderr (`~/Library/Logs/factory-door.err.log`). `factory door token new <source>` writes a fresh token
(32 random bytes, base64url) into the file and prints it once; an existing source needs `--rotate`. The door reads the file at
start, so restart it after a rotation: `launchctl kickstart -k gui/$(id -u)/com.jkrumm.factory-door`. The owner seeds the
tokens into 1Password. `make deploy` creates none.

## Routes

The registry is in the database (`factory.door_routes`), never in git: monitor names and repos are the owner's estate.

```
factory door route set <source> <monitor> <repo>   # the repo must be inside FACTORY_REPO_ROOTS and never IuRoot
factory door route list | rm <source> <monitor>
factory door unrouted                              # monitors that alerted with no route: count, last seen, last title
```

An alert with no route files nothing and is counted once per event (every alert the homelab has arrives here, Kuma attaches
every provider to every monitor). Routed: an open Issue of that monitor gets a `signal` (a regression while the monitor is
down); with none open, a down creates an Issue (`source: alert`) in the route's repo and an up only counts on the route.

## Sources

Each parser is a pure function from the payload to `{ monitor, event, status, title, facts }`, in `src/parsers.ts`, tested
against `test/fixtures/` (shaped after Uptime Kuma's `webhook.js` and HyperDX's `generic.js`; synthetic, with a credentials-bearing
monitor URL to prove it never reaches the facts). The payload is data: nothing in it picks a repo, a role, a path or a command.

### kuma

Uptime Kuma, notification type Webhook, content type JSON (its default body is `{ heartbeat, monitor, msg }`), URL
`https://<mini tailnet name>:8796/alert/kuma`, additional header `{"Authorization": "Bearer <see-1password>"}`.
`monitor` = the monitor's name (ids change between syncs), `event` = `heartbeat.time`, status from `heartbeat.status`
(0 down, 1 up). The monitor's `url` is never read.

### hyperdx

HyperDX (ClickStack), team settings, Webhooks, service Generic, URL `https://<mini tailnet name>:8796/alert/hyperdx`, headers
`{"Authorization": "Bearer <see-1password>"}` (static; header values are not templated), and this body:

```
{
  "title": "{{title}}",
  "body": "{{body}}",
  "link": "{{link}}",
  "state": "{{state}}",
  "startTime": "{{startTimeISO}}",
  "endTime": "{{endTimeISO}}",
  "eventId": "{{eventId}}",
  "alertId": "{{alertId}}"
}
```

Checked against the build deployed on the vps (its `generic.js` and `template.js`) and HyperDX's
`docs/alert-webhook-template-variables.md`:

- The body is Handlebars. Every string variable is JSON-escaped, so each sits inside plain double quotes and is never escaped by
  hand. `{{startTime}}` and `{{endTime}}` are raw Unix milliseconds that would sit unquoted, so the template uses
  `{{startTimeISO}}` and `{{endTimeISO}}` (strings) instead; the parser takes either.
- `{{state}}` is `ALERT` while the alert fires and `OK` when it recovers; any other value files nothing.
- `{{title}}` carries a prefix (🚨 firing, ✅ resolved) and its shape is `Alert for "<name>" - <value> ...`. The value changes with
  every firing, so `monitor` is the quoted `<name>`; a title of another shape loses its prefix and its trailing numbers.
  Route by that name: `factory door unrouted` shows what arrived.
- `{{eventId}}` is the same for a firing and its recovery, so `event` = `eventId@startTime/endTime:status`: the window it was evaluated
  over and the status tell one notification from the next, and a retry of one is the same event.
- Delivery is at least once, with an `Idempotency-Key` header the door ignores: a repeat is the same event key, so one effect.
- HyperDX posts with `Content-Type: application/json`, follows no redirects and blocks private and loopback targets; whether a
  tailnet address passes that check is for the first Test Webhook to show.

## Run

`make deploy` installs and restarts the door's LaunchAgent (`com.jkrumm.factory-door`, `deploy/` and `scripts/launch-door.sh`) from
the same release directory as the server; `make verify` ends with the 401 check, and says why when the door is down (most often
the missing tokens file). Tests: `bun test packages/door` (parsers, tokens, the door in front of a fake server) and
`packages/server/test/door.test.ts` (intake rules, registry, CLI, the door in front of the real server).
