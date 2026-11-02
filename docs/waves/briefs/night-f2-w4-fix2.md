Branch: f2-w4-fix2
Title: fix(issues): the second review round of Wave 4
Owned files: `packages/server/src/issues/{effects,archive,origin,finalize,verbs}.ts`, `packages/server/test/**`. Never: `docs/waves/PLAN.md`, `docs/program.md`, `docs/evidence/**`, migrations.

# Brief: F2 Wave 4, the last fix round

**First:** your worktree is cut from master, the work is PR #27. Run `git fetch origin && git reset --hard origin/f2-w4-evidence`, work there, and at the end `git push origin HEAD:f2-w4-evidence` (no force unless the rebase below needs it). Do not open a PR: #27 is it. Read `packages/server/src/issues/effects.ts`, `origin.ts`, `finalize.ts`, `archive.ts`, `verbs.ts` and `docs/design.md` §5 ("Done means evidence") first.

The lead's review of the fix commits found five things. Verify each against the code; if one is wrong, say so and leave it.

1. `effects.ts:62`: the outer `ORDER BY kind = 'verify', attempts, id LIMIT budget` puts every verify behind all other rows. 20 Issues whose head keeps failing or waiting fill the batch, no hold check ever runs. Keep notes ahead of a verify, but a verify must not be starved: a reserved share of the batch, or order by `attempts` first. The simplest correct rule.
2. `archive.ts:93`: `projectsDir` (`readRegistry` throws `RunnerError`) and `resolved` (rethrows EACCES, ENOTDIR) are not turned into `transcript_missing`, so an unreadable registry makes every finalize throw before the worktree removal and `issue_finalized`. A transcript that cannot be archived never stops a finalize. Read the registry once per archive.
3. `origin.ts:639`: `landedAs` accepts any reported commit that is an ancestor of the base, also one older than the branch's fork point. A branch whose net change deletes or reverts a path "equals" the old commit, and finalize then runs `branch -D` on unmerged work. A reported commit must be a descendant of the fork point (strictly newer). Test it with a deleting branch and a commit older than the fork.
4. `finalize.ts:92`: the squash proof reads the raw `payload->'commits'` strings, which can be short shas or `master`, re-resolved at finalize. Use the full shas resolved at ship (`derived`).
5. `verbs.ts:72`: a re-derived retry after a refused ship stores inline `--evidence` again under a new key. Key the evidence by content or by the original row, so a repeated call adds no row.

Left as answered, don't touch: the migration rename (nothing applied the old name), the backoff map (one entry per abandoned key), a verify starting in the pass its Issue's note failed.

**Gate:** `make check` green, one `/review` pass on your commits with findings fixed or answered. **Wait for every review run in the foreground** (`agw run wait <runId>`): never end a turn while a background shell runs, the factory reads your idle prompt as finished and wakes the lead. Push as above, don't merge or deploy. End with one line per item.
