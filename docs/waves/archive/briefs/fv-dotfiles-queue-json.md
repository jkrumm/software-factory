Branch: fv-queue-json
Title: feat(human-queue): ask-human.sh list --json, the queue's read for the fleet view
Owned files: `scripts/ask-human.sh`, its hermetic tests (`human-queue-test` and the files it runs), `docs/` lines that describe `list`. Never: anything else in dotfiles, any other repo.

# Brief: the human queue's machine read (dotfiles, track FV)

Read dotfiles `AGENTS.md`, `docs/waves/fv-board.md` (Wave 1, first item), and `scripts/ask-human.sh` (`cmd_list`, the queue's layout and its "no jq hard dependency" note) first. The factory's fleet view (software-factory `docs/waves/fv.md`) reads the queue; dotfiles stays its owner.

1. `ask-human.sh list --json`: one JSON array on stdout, every request with no result yet: `id`, `text`, `cmd` (as stored), `askedAt` (ISO 8601 UTC), `ageSeconds`, `state` (`pending`, or `queued` when the MacBook was unreachable, as the script knows it). Same visibility rules as `list` (a request mid-write is never seen). No new dependency: the script's own JSON helpers; strings escaped correctly (quotes, backslashes, newlines, control characters).
2. `list` without `--json` is unchanged. An unknown flag exits 2.
3. Tests in the existing hermetic suite: empty queue `[]`, one request, a request with quotes and a newline in its text, a request with a result (absent), a half-written one (absent).

**Gate:** `make check` green in dotfiles, `/review` with findings fixed, one more pass on the fix commits. **Wait for every review run in the foreground** (`agw run wait <runId>`): never end a turn while a background shell runs. dotfiles is direct-to-master: rebase on origin/master and push to master yourself once green and reviewed (no PR), then report the commit, done / deferred, one line each.
