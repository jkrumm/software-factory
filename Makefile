.DEFAULT_GOAL := help
.PHONY: help check test fmt deploy rollback verify version

help:
	@echo "make check   install, format, lint, shellcheck, tsc, tests (the merge gate)"
	@echo "make test    the tests only"
	@echo "make fmt     apply formatting"
	@echo "make deploy  deploy origin/master (or FACTORY_REF=<branch>) on the mini: release, LaunchAgent, health check, rollback (DRY_RUN=1 prints the plan)"
	@echo "make rollback swap back to the previous release (data/previous-sha): service, /health at the old sha, current, CLI, door (DRY_RUN=1 prints the plan)"
	@echo "make version print the deployed commit sha (one line; what the hold checks the shipped commits against)"
	@echo "make verify  prove the deployment: /health at the deployed sha, which is origin/master (or FACTORY_REF; behind it only by docs/tests is fine), and the factory CLI against it"

# Tests start a private Postgres cluster (initdb) in a temp dir: PG_BIN_DIR points at the binaries when they are not on PATH.
check:
	@echo "==> install (bun install --frozen-lockfile)"
	@bun install --frozen-lockfile
	@echo "==> format (oxfmt --check)"
	@bunx --no-install oxfmt --check .
	@echo "==> lint (oxlint --type-aware)"
	@bunx --no-install oxlint -c .oxlintrc.json --type-aware packages
	@echo "==> shellcheck"
	@shellcheck scripts/*.sh
	@echo "==> typecheck (tsc --noEmit)"
	@bunx --no-install tsc --noEmit
	@echo "==> test (bun test)"
	@$(MAKE) --no-print-directory test
	@echo "==> check passed"

# The tests run in one of the host's test slots (FL7) when `factory` is installed, so parallel checks do not pile their
# load onto each other; without it (CI) the bare command. The checkout's own CLI is the one that takes the slot. It fails
# open: a server that is down or a full house runs the tests anyway.
test:
	@if command -v factory >/dev/null 2>&1; then bun packages/cli/bin/factory.ts slot run --name "$$(basename "$$PWD") test" -- bun test; else bun test; fi

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
