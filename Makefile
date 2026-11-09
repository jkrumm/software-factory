.DEFAULT_GOAL := help
.PHONY: help check merge-guard test e2e fmt deploy rollback verify version rehearse

help:
	@echo "make check   install, format, lint, shellcheck, tsc, Console tsc, tokens, artifact templates and InfoHint definitions, e2e tsc, boundaries, retired words, public scan, Issue diagram, generated CLI, tests, scenarios, Console build and Playwright (the merge gate)"
	@echo "make merge-guard  run right before merging a PR: refuses unless the branch contains origin/master, its migration numbers are free and master's last CI run is green (MERGE_GUARD_ARGS=--allow-red only for the change that fixes a red master)"
	@echo "make test    the unit tests and the scenarios"
	@echo "make e2e     build the Console and run its Playwright suite against a seeded server (tests/e2e; screenshots land in tests/e2e/out/screenshots)"
	@echo "make fmt     apply formatting"
	@echo "make deploy  deploy origin/master (or FACTORY_REF=<branch>) on the mini: release, LaunchAgent, health check, rollback (DRY_RUN=1 prints the plan)"
	@echo "make rollback swap back to the previous release (data/previous-sha): service, /health at the old sha, current, CLI, door (DRY_RUN=1 prints the plan)"
	@echo "make version print the deployed commit sha (one line; what the hold checks the shipped commits against)"
	@echo "make rehearse the cutover rehearsal on a copy of the live data in a private cluster (read-only dump; REHEARSE_ARGS='--keep --skip-old --dump <file>')"
	@echo "make verify  prove the deployment: /health at the deployed sha, which is origin/master (or FACTORY_REF; behind it only by docs/tests is fine), and the factory CLI against it"

# Tests start a private Postgres cluster (initdb) in a temp dir: PG_BIN_DIR points at the binaries when they are not on PATH.
check:
	@echo "==> install (bun install --frozen-lockfile)"
	@bun install --frozen-lockfile
	@echo "==> format (oxfmt --check)"
	@bunx --no-install oxfmt --check .
	@echo "==> lint (oxlint --type-aware)"
	@bunx --no-install oxlint -c .oxlintrc.json --type-aware apps packages tests scripts
	@echo "==> shellcheck"
	@shellcheck $$(git ls-files "scripts/*.sh")
	@echo "==> typecheck (tsc --noEmit)"
	@bunx --no-install tsc --noEmit
	@echo "==> typecheck console (apps/console)"
	@bun run --cwd apps/console typecheck
	@echo "==> console tokens are current (basalt-ui tokens:check)"
	@bun run --cwd apps/console tokens:check
	@echo "==> console artifact templates are current (scripts/templates.ts)"
	@bun run --cwd apps/console templates:check
	@echo "==> console InfoHint definitions are current (scripts/language.ts)"
	@bun run --cwd apps/console language:check
	@echo "==> typecheck e2e (tests/e2e)"
	@bunx --no-install tsc -p tests/e2e/tsconfig.json --noEmit
	@echo "==> boundaries (scripts/boundaries.ts)"
	@bun scripts/boundaries.ts
	@echo "==> retired words (scripts/retired-words.ts)"
	@bun scripts/retired-words.ts
	@echo "==> public hygiene (scripts/public-scan.ts)"
	@bun scripts/public-scan.ts
	@echo "==> Issue diagram is current (apps/server/scripts/issue-diagram.ts --check)"
	@bun apps/server/scripts/issue-diagram.ts --check
	@echo "==> generated CLI is current (apps/cli/scripts/generate.ts --check)"
	@bun apps/cli/scripts/generate.ts --check
	@echo "==> next free migration number (scripts/merge-guard.ts): $$(bun scripts/merge-guard.ts --next-migration)"
	@$(MAKE) --no-print-directory test
	@$(MAKE) --no-print-directory e2e
	@echo "==> check passed"

# The tests run in one of the host's test slots (FL7) when `factory` is installed, so parallel checks do not pile their
# load onto each other; without it (CI) the bare command. That is the installed CLI of the running core until the
# cutover. It fails open: a server that is down or a full house runs the tests anyway.
SLOT = $(if $(shell command -v factory 2>/dev/null),factory slot run --name "$(notdir $(CURDIR)) test" --,)

# Every test file may start a private Postgres cluster in beforeAll and a scenario drives real processes; initdb alone takes seconds
# on a loaded runner. Bun 1.4 ignores `timeout` in bunfig.toml (tests ran at 5 s on CI), so the flag carries it.
TEST_TIMEOUT = --timeout 30000

test:
	@echo "==> unit tests (bun test apps packages scripts integrations)"
	@$(SLOT) bun test $(TEST_TIMEOUT) ./apps ./packages ./scripts ./integrations
	@echo "==> scenarios (bun test tests)"
	@$(SLOT) bun test $(TEST_TIMEOUT) ./tests

# The Console is built first (the global setup serves apps/console/dist); `bun test` never collects tests/e2e (*.e2e.ts). Playwright runs under Bun.
e2e:
	@echo "==> console build (apps/console/dist)"
	@bun run --cwd apps/console build
	@echo "==> e2e (playwright, tests/e2e)"
	@$(SLOT) bunx --bun playwright test -c tests/e2e/playwright.config.ts

fmt:
	@bunx --no-install oxfmt --write .

# A release (~/.software-factory/releases/<sha>, live via `current`) is what runs, never this checkout; scripts/deploy.sh owns the steps.
deploy:
	@DRY_RUN="$(DRY_RUN)" /bin/bash scripts/deploy.sh

rollback:
	@DRY_RUN="$(DRY_RUN)" /bin/bash scripts/deploy.sh rollback

verify:
	@/bin/bash scripts/verify.sh

version:
	@/bin/bash scripts/version.sh

# A window on a copy of the live data: restore, rename, boot the new core, import, compare, scenarios, the way back, the next window.
rehearse:
	@bun scripts/rehearse.ts $(REHEARSE_ARGS)

# A lead runs this right before it merges its pull request (AGENTS.md "Merging"): rebased, free migration number, green master.
merge-guard:
	@bun scripts/merge-guard.ts $(MERGE_GUARD_ARGS)
