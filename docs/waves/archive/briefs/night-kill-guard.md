Branch: hooks-broad-kill-guard
Title: feat(hooks): deny pattern kills that reach other agents' processes
Owned files (dotfiles): `hooks/broad-kill-guard.ts`, `hooks/broad-kill-guard.test.ts` (new), `config/settings.template.json` (the Bash PreToolUse list), the hooks suite in `Makefile` if tests are listed there, `AGENTS.md`/`docs/` lines naming the Bash hooks. Nothing else.

# Brief: a PreToolUse guard against pattern kills (incident 2026-11-01 20:12)

**Incident.** An agent on the mini ran `for p in $(pgrep -f 'gate.sh'); do pkill -TERM -P $p; kill $p; done` to stop its own
gate script. `pgrep -f` matches the full command line of every process of the user, and a Claude Code session's prompt is its
argv, so every session whose prompt matched got SIGTERM: eight agents across three repos ended in the same second.

**Hook** `hooks/broad-kill-guard.ts`, registered on `Bash` beside `protect-branches.ts` and `docker-makefile.ts`, same I/O
shape as those (read them; reuse `docker-makefile.ts`'s shell-aware tokenizer if it can be shared without copying 700 lines,
otherwise a small tokenizer: quoted text is data). Deny, with a reason that names the safe alternative:
- `pkill` with `-f` (any flag cluster containing `f`), or `pkill` with any pattern and no `-P <pid>`/`-g <pgid>`;
- `killall`;
- `kill`, `xargs kill` or `pkill -P` fed by `pgrep -f` (a `$(pgrep -f …)` substitution, a pipe `pgrep -f … | xargs kill`, or a
  `for … in $(pgrep -f …)` loop whose body kills).
Allow: `kill <literal pid>`, `kill $!`, `kill "$(cat <pidfile>)"`, `kill %<job>`, `pkill -P <literal pid or $!>`, `pgrep`
alone (reading is fine), and any of these words inside quoted text (a grep pattern, a commit message). The deny reason: "Pattern
kills hit every agent on this machine (incident 2026-11-01). Kill only what you started: keep $! in a pidfile and kill that PID
or its process group."

Tests for every deny and allow case above, including the exact incident command. Install: the repo's own target that writes
`~/.claude/settings.json` from the template and links the hook (find it in the `Makefile`, around the `settings.template.json`
lines); run it after merge, and check the hook fires with a dry-run input (`echo '<json>' | ~/.claude/hooks/broad-kill-guard.ts`).

Work in a worktree of fetched `origin/master` (`rd fan` made it). **Gate:** the hooks' tests green (`bun test hooks/`), `/review`
with findings fixed, one more `/review` pass on the fix commits. **Wait for every review run in the foreground** (`agw run wait
<runId>`). dotfiles is direct-to-master: rebase onto `origin/master`, push to master, then `git -C ~/SourceRoot/dotfiles pull
--ff-only` (that checkout is clean and no agent works in it tonight) and run the install target. Report: done / deferred, and
whether a running Claude Code session picks up the new hook entry or only new sessions do (test it: a session started before
the install, a denied command).
