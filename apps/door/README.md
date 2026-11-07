# factory door

The one way an alert from the tailnet becomes a factory Issue. A Bun server of its own, one route: `POST /alert/<source>`.
It holds no factory token and no database credential: it posts to the server's API over loopback HTTP, `POST /signals/alerts` for an
alert and `POST /door/reports` for what it says about its sources. The body is an `AlertRequest` (`source`, `monitor`, `event`,
`status`, `title`, `facts`), strict: it has no `repo`. The repo comes from the server's route registry, never from the door or the payload.

```
Kuma / HyperDX ──TLS──▶ tailscale serve ──▶ 127.0.0.1:8796 (the door) ──loopback HTTP──▶ the server (POST /signals/alerts)
```

The server is `FACTORY_URL` (default `http://127.0.0.1:7793`, as the CLI's). The door calls it with `FACTORY_DOOR_TOKEN` as its bearer token (the server's `FACTORY_DOOR_TOKEN`; it may file alerts and post reports, nothing else) and does not start without it.

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
| 200 with a `SignalAck` (`filed`, `amended`, `incident`, `held`, `dropped`, with a `detail`) | 200, the same ack |
| 200 with another shape | 502 |
| 422 refused | 422 `{ "error": "the alert was refused" }`, no reason |
| unreachable, or 5xx | 503 (Kuma retries; nothing is spooled) |
| any other answer | 502 |

A Kuma test message and a beat that is neither down nor up (pending, maintenance) answer 200 and file nothing. There is no
health route: the 401 to an unauthenticated `POST /alert/kuma` is the health check (the deploy's verify step does exactly that).

## Log lines, refusals and health

One line per request on stderr: `<ISO time> POST kuma 202 13ms`. A 401 names the source the path claimed, never a token or body:
`<ISO time> POST refused kuma 401 0ms`. The factory's own health probes (deploy and verify) send
`x-factory-probe: 1` and log `POST probe kuma 401 0ms`; they are not refusals. The header is a label, not a control: anyone who can reach the door can set it and keep their own refusals out of the health line.

The door reports to the server's API, best effort (`POST /door/reports`, errors swallowed, never delaying the response):
`start` at boot (six tries, 5 s apart, in the background), `refused` for a 401 on a source it holds a token for (not a probe, and an
unknown source is only logged), `accepted` for a Kuma test message that passed auth. A filed alert also counts as accepted. Two health
lines follow (derived on the server by `healthLines` in `app/intake.ts`; serving them in `/health` is a later package): `door source <s>: <n> POSTs refused since …` (at least 3 refusals, the last within 72 h, none accepted since) and
`door source <s>: nothing accepted for <n> days` (14 days).

## Tokens

`~/.config/factory/door-tokens.json` (`FACTORY_DOOR_TOKENS_FILE`), mode 0600, read at start:

```json
{ "kuma": "<token>", "hyperdx": "<token>" }
```

A file with a looser mode, one that does not parse, a missing file and one with no source all make the door refuse to start,
with the reason on stderr (the service's error log). `newToken` in `src/tokens.ts` writes a fresh token (32 random bytes,
base64url) into the file; the CLI verb that calls it comes with the CLI package, and until then the file is written by
hand. The door reads the file at start, so restart it after a rotation. The owner seeds the tokens into 1Password. A
deploy creates none.

## Routes

The registry lives in the server's database, never in git: monitor names and repos are the owner's estate. The door knows none of
it; what the server does with an alert (file, amend, hold, drop) follows from the route and is in its `SignalAck`.

## Sources

Each parser is a pure function from the payload to an `AlertRequest` minus its `source` (`{ monitor, event, status, title, facts }`), in `src/parsers.ts`, tested
against `test/fixtures/` (shaped after Uptime Kuma's `webhook.js` and HyperDX's `generic.js`; synthetic, with a credentials-bearing
monitor URL to prove it never reaches the facts). The payload is data: nothing in it picks a repo, a role, a path or a command.

### kuma

Uptime Kuma, notification type Webhook, content type JSON (its default body is `{ heartbeat, monitor, msg }`), URL
`https://<mini tailnet name>:8796/alert/kuma`, additional header `{"Authorization": "Bearer <see-1password>"}`.
`monitor` = the monitor's name (ids change between syncs), `event` = `heartbeat.time`, status from `heartbeat.status`
(0 down, 1 up). The monitor's `url` is never read. Facts stay within `MAX_FACTS_BYTES`; a larger set is replaced by `{ "truncated": true }`.

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
  Route by that name: the server's list of unrouted monitors shows what arrived.
- `{{eventId}}` is the same for a firing and its recovery, so `event` = `eventId@startTime/endTime:status`: the window it was evaluated
  over and the status tell one notification from the next, and a retry of one is the same event.
- Delivery is at least once, with an `Idempotency-Key` header the door ignores: a repeat is the same event key, so one effect.
- HyperDX posts with `Content-Type: application/json`, follows no redirects and blocks private and loopback targets; whether a
  tailnet address passes that check is for the first Test Webhook to show.

## Run

`bun apps/door/src/main.ts`, normally under the host's service manager, with `FACTORY_DOOR_PORT`, `FACTORY_URL`, `FACTORY_DOOR_TOKEN` and
`FACTORY_DOOR_TOKENS_FILE` in its environment. Tests: `bun test apps/door` (parsers, tokens, the door in front of a scripted fake server).
