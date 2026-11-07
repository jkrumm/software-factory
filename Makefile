.DEFAULT_GOAL := help
.PHONY: help check test fmt deploy rollback verify version rehearse

help:
	@echo "make check   install, format, lint, shellcheck, tsc, boundaries, retired words, Issue diagram, generated CLI, tests, scenarios (the merge gate)"
	@echo "make test    the unit tests and the scenarios"
	@echo "make fmt     apply formatting"
	@echo "make deploy  deploy origin/master (or FACTORY_REF=<branch>) on the mini: release, LaunchAgent, health check, rollback (DRY_RUN=1 prints the plan)"
	@echo "make rollback swap back to the previous release (data/previous-sha): service, /health at the old sha, current, CLI, door (DRY_RUN=1 prints the plan)"
	@echo "make version print the deployed commit sha (one line; what the hold checks the shipped commits against)"
	@echo "make rehearse the cutover rehearsal on a copy of the live data in a private cluster (read-only dump; REHEARSE_ARGS='--keep --skip-old --dump <file>')"
	@echo "make verify  prove the deployment: /health at the deployed sha, which is origin/master (or FACTORY_REF; behind it only by docs/tests is fine), and the factory CLI against it"

# Tests start a private Postgres cluster (initdb) in a temp dir: PG_BIN_DIR points at the binaries when they are not on PATH.
# `legacy/` is the old core, kept as a read-only reference until the cutover: no step reads it.
check:
	@echo "==> install (bun install --frozen-lockfile)"
	@bun install --frozen-lockfile
	@echo "==> format (oxfmt --check)"
	@bunx --no-install oxfmt --check .
	@echo "==> lint (oxlint --type-aware)"
	@bunx --no-install oxlint -c .oxlintrc.json --type-aware apps packages tests scripts
	@echo "==> shellcheck"
	@shellcheck scripts/*.sh scripts/gameday/*.sh
	@echo "==> typecheck (tsc --noEmit)"
	@bunx --no-install tsc --noEmit
	@echo "==> boundaries (scripts/boundaries.ts)"
	@bun scripts/boundaries.ts
	@echo "==> retired words (scripts/retired-words.ts)"
	@bun scripts/retired-words.ts
	@echo "==> Issue diagram is current (apps/server/scripts/issue-diagram.ts --check)"
	@bun apps/server/scripts/issue-diagram.ts --check
	@echo "==> generated CLI is current (apps/cli/scripts/generate.ts --check)"
	@bun apps/cli/scripts/generate.ts --check
	@$(MAKE) --no-print-directory test
	@echo "==> check passed"

# The tests run in one of the host's test slots (FL7) when `factory` is installed, so parallel checks do not pile their
# load onto each other; without it (CI) the bare command. That is the installed CLI of the running core until the
# cutover. It fails open: a server that is down or a full house runs the tests anyway.
SLOT = $(if $(shell command -v factory 2>/dev/null),factory slot run --name "$(notdir $(CURDIR)) test" --,)

test:
	@echo "==> unit tests (bun test apps packages scripts)"
	@$(SLOT) bun test ./apps ./packages ./scripts
	@echo "==> scenarios (bun test tests)"
	@$(SLOT) bun test ./tests

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
