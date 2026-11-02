# wordstat

A small shell program that counts the words and lines on stdin. A throwaway repo for the factory's F2 gamedays; the remote `origin` is a
local bare repository, there is no GitHub repo and no pull request.

- `bin/wordstat` is the program, `test/run.sh` its tests, `test/limits.conf` the config the tests use.
- `make check` runs the tests. `make deploy` copies `bin/` and `deploy/limits.conf` to the production directory outside this repo, and
  only from a HEAD that is `origin/master`. `make verify` runs the deployed copy against its own config and compares its revision to
  `origin/master`.
- Direct to `master`: rebase on `origin/master`, `git push origin HEAD:master`, then `make deploy` and `make verify`.
- Conventional commits. Keep the change small.
