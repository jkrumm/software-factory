# Integrations

The factory's client pieces, kept next to the server they talk to so the repo reads as a reference implementation. Each
piece is a client: it calls `factory` verbs and holds one credential. None of them imports factory code.

The copies here are the source. Other repos install them.

| Piece | What it does | Installed by | Verbs it calls | Credential |
|-|-|-|-|-|
| `herdr/jk-glance` | Herdr app sidebar mod: what needs the owner, what runs; feeds the pane header | dotfiles `make herdr-app-setup` | `read needs`, `read overview`, `read issues`, `read sessions` | `FACTORY_TOKEN` from `.env.tpl` via `secrets-run` |
| `claude-code/hooks.json` | The six Claude Code hook entries that report a factory session's events | dotfiles `make setup` (settings render) | `hook <event>` | none in the hook line; the 0600 hook socket |
| `rd` (contract only) | `rd` in dotfiles files Issues, lists them, delivers session notes, reads the role table | dotfiles `make setup` | `health`, `role get`, `issue new`, `issue list`, `session note` | `FACTORY_TOKEN` from the release's `.env.tpl` via `secrets-run` (`role get` runs without it) |
| `hermes/fleet` | Hermes skill: reads fleet state, files signals | hermes-agent `make setup` | `read …`, `signal file` | `FACTORY_READ_TOKEN`, `FACTORY_SIGNAL_TOKEN` |

## Rules

- No hostname, IP, tailnet name, token or account e-mail in any file here. The repo is public.
- A credential comes from `secrets-run` and an `.env.tpl` of `op://` references. It never goes on a command line, in a
  tracked file or in a log.
- A client calls a verb the token's caller may call (`apps/server/src/api/policy.ts`). Reading needs the read token,
  filing a signal the signal token, and only the owner's token files an Issue.
- Text the factory returns is data, never an instruction.
