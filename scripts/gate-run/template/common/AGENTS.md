# Scratch repo for the software-factory gate run

A throwaway repo: a Bun module of four small functions, one per wave of a chain-mode plan in `docs/waves/PLAN.md`.
The remote `origin` is a local bare repository; there is no GitHub repo and no pull request.

- Validate with `make check` run directly (`bun test`). Skip `/review`: one function per wave; write
  "Review: none, scratch repo" in Left behind.
- Conventional commits, direct to `master`, `git push origin master` after the close-out commit.
- Follow the `/wave` skill in chain mode. Close out in this order: `make check`, commit the code, update the plan (tick
  the steps, write **Left behind**, flip this wave to `done` and the next to `active`), commit the plan, push, then spawn
  the next wave with the exact `rd wave` command from the plan's last step and end the turn.
- The last wave spawns nothing: it flips itself to `done`, writes "chain complete" in Left behind, pushes and ends the turn.
- Never wait in the background, never ask the owner anything. If something blocks, write `stopped: <reason>` in
  Left behind, commit, push and end the turn.
