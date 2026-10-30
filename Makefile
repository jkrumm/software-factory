.DEFAULT_GOAL := help
.PHONY: help check test fmt deploy verify

help:
	@echo "make check   install, format, lint, shellcheck, tsc, tests (the merge gate)"
	@echo "make test    the tests only"
	@echo "make fmt     apply formatting"
	@echo "make deploy  deploy origin/master (or FACTORY_REF=<branch>) on the mini: release, LaunchAgent, health check, rollback (DRY_RUN=1 prints the plan)"
	@echo "make verify  prove the deployment: /health at the deployed sha, which is origin/master (or FACTORY_REF), and the factory CLI against it"

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
	@bun test
	@echo "==> check passed"

test:
	@bun test

fmt:
	@bunx --no-install oxfmt --write .

# A release (~/.software-factory/releases/<sha>, live via `current`) is what runs, never this checkout; scripts/deploy.sh owns the steps.
deploy:
	@DRY_RUN="$(DRY_RUN)" /bin/bash scripts/deploy.sh

verify:
	@/bin/bash scripts/verify.sh
