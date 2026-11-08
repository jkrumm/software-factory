# Hermes

Hermes is a signal-in, read-out client. The `fleet` skill (`fleet/SKILL.md`) teaches it the factory's words, how to
read fleet state and how to put work in. It decides nothing: not what an Issue becomes, its order, its priority or the
answer to a Decision.

## Verbs

- Read, under the read token: `factory read overview|needs|flow|chain|issues|issue|sessions|accounts|friction|health`.
  Read-only; the server withholds the text of work repos (IuRoot) under it.
- Write, under the signal token: `factory signal file --from owner:hermes --repo <repo> --title … --text -`. One signal
  per distinct request; triage decides what it becomes.

Hermes never runs `factory issue new`. The signal token cannot, and the read token cannot file anything.

## Credentials

Both live in Hermes' `.env.tpl`, resolved by `secrets-run`:

- `FACTORY_READ_TOKEN`: the CLI's fallback when `FACTORY_TOKEN` is unset, so every `factory read` uses it.
- `FACTORY_SIGNAL_TOKEN`: set as `FACTORY_TOKEN` for the one `signal file` command, so the server accepts
  `--from owner:hermes` as the owner's. The owner's own token never goes in that file.

## Install

hermes-agent `make setup` symlinks `fleet/` into `~/.hermes/skills/fleet`. This copy is the source.
