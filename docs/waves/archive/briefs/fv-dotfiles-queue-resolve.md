Branch: fv-queue-resolve
Title: feat(human-queue): ask-human.sh resolve, the owner's answer to a request without the MacBook
Owned files: `scripts/ask-human.sh`, its hermetic tests (`human-queue-test`), `docs/` lines that describe the queue's verbs. Never: anything else in dotfiles, any other repo.

# Brief: resolving a queue request (dotfiles, track FV)

Read dotfiles `AGENTS.md`, `docs/waves/fv-board.md`, and `scripts/ask-human.sh` (how a result is written: `<id>.res`, its last line is the result, the temp+mv+chmod pattern, the `.queued` marker) first. The factory's fleet view (software-factory FV Wave 3) offers the owner "resolve" and "deny" on a queue request; dotfiles stays the queue's owner, so the factory calls this verb and never writes the queue's files.

1. `ask-human.sh resolve <id> --as done|denied|superseded [--note <text>]`: writes the request's result the way a real answer is written (atomic, mode as today), with a result line a waiting caller reads as "not run" for `denied` and `superseded` (its exit status says so: the existing code for a refused request), and `done` for a request satisfied by other means. The request's command is **never** run by `resolve`. Refused when the request already has a result or does not exist (exit 2, a line).
2. `list --json` gains `resolvedAs` and `resolvedNote` on nothing (resolved requests stay out of `list` as today); `status <id>` shows them.
3. Tests in the hermetic suite: each `--as`, a second resolve refused, an unknown id, a waiting `ask` caller that sees `denied` as not run.

**Gate:** `make check` green in dotfiles, `/review` with findings fixed, one more pass on the fix commits. **Wait for every review run in the foreground** (`agw run wait <runId>`): never end a turn while a background shell runs. dotfiles is direct-to-master: rebase on origin/master and push to master yourself once green and reviewed (no PR), then report the commit, done / deferred, one line each.
