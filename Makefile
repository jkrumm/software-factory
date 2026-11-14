.DEFAULT_GOAL := help
.PHONY: help check check-fast check-steps check-fast-steps check-static test test-unit test-unit-changed test-scenarios merge-guard e2e fmt deploy rollback verify version rehearse

help:
	@echo "make check   install, format, lint, shellcheck, tsc, Console tsc, tokens, artifact templates and InfoHint definitions, e2e tsc, boundaries, retired words, public scan, Issue diagram, generated CLI, tests, scenarios, Console build and Playwright (the merge gate)"
	@echo "make check-fast  the lead's local check (project.yaml checks.fast): everything of make check up to the tests, then the unit tests of the files the branch changed (CHECK_FAST_ALL=1: all of them); CI runs the full gate sharded"
	@echo "make merge-guard  run right before merging a PR: refuses unless the branch contains origin/master, its migration numbers are free, the head's CI finished green and master's last finished CI run is not red (MERGE_GUARD_ARGS=--wait waits for the head's CI; --allow-red only for the change that fixes a red master)"
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
	@$(call slot,check) $(MAKE) --no-print-directory check-steps

# The lead's check after each change (project.yaml `checks.fast`): its own slot name, so the ledger learns its peak apart from the whole gate's.
check-fast:
	@$(call slot,check-fast) $(MAKE) --no-print-directory check-fast-steps

# The whole check is one lease on a test slot (a lead sees "queued for a test slot" and waits, it does not poll the load);
# the test steps below it run inside that lease (FACTORY_SLOT_ACTIVE) and do not queue again.
check-steps: check-static
	@$(MAKE) --no-print-directory test
	@$(MAKE) --no-print-directory e2e
	@echo "==> check passed"

check-fast-steps: check-static
	@$(MAKE) --no-print-directory test-unit-changed
	@echo "==> check-fast passed (CI runs the scenarios and the Console suite)"

# Everything that is not a test run: CI's `static` job runs these through check-fast.
check-static:
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

# The tests run in one of the host's test slots (FL7) when `factory` is installed, so parallel checks do not pile their
# load onto each other; without it (CI) the bare command. That is the installed CLI of the running core until the
# cutover. It fails open: a server that is down or a full house runs the tests anyway.
# Not the checkout directory: every lead works in its own worktree (factory-719-1 ...), and the ledger and the grant rule
# learn a step's peak by its exact name, so a name per directory would never carry a peak from one lead to the next.
SLOT_PROJECT = software-factory
slot = $(if $(shell command -v factory 2>/dev/null),factory slot run --name "$(SLOT_PROJECT) $(1)" --,)
SLOT = $(call slot,test)

# `factory slot run` sets FACTORY_JUNIT_DIR for the command it runs and posts the *.xml files left there beside the step's cost
# (test results per run: flake rate, failed-run minutes). Unset (CI, a run without a slot): no JUnit file.
JUNIT = $(if $(FACTORY_JUNIT_DIR),--reporter=junit --reporter-outfile=$(FACTORY_JUNIT_DIR)/$(1).xml)

# Every test file may start a private Postgres cluster in beforeAll and a scenario drives real processes; initdb alone takes seconds
# on a loaded runner. Bun 1.4 ignores `timeout` in bunfig.toml (tests ran at 5 s on CI), so the flag carries it.
# The per-test limit stretches with the host's load per core (up to 6x): at load 40 a test that takes 3 s idle takes minutes (Issue 719).
TEST_TIMEOUT = --timeout $(shell bun -e 'import {cpus,loadavg} from "node:os"; console.log(Math.round(30000*Math.min(6,Math.max(1,loadavg()[0]/cpus().length))))')

test: test-unit test-scenarios

test-unit:
	@echo "==> unit tests (bun test apps packages scripts integrations)"
	@$(SLOT) bun test $(call JUNIT,unit) $(TEST_TIMEOUT) ./apps ./packages ./scripts ./integrations

# The unit tests of what the branch changed (bun follows the imports from each changed file; committed and uncommitted
# changes against the merge base with origin/master). CHECK_FAST_ALL=1 (CI's `static` job) runs every unit test.
UNIT_BASE = $(shell git merge-base HEAD origin/master 2>/dev/null)
test-unit-changed:
	@if [ -n "$(CHECK_FAST_ALL)" ] || [ -z "$(UNIT_BASE)" ]; then $(MAKE) --no-print-directory test-unit; else \
	  echo "==> unit tests of the changed files (bun test --changed=$(UNIT_BASE))"; \
	  $(SLOT) bun test $(call JUNIT,unit-changed) $(TEST_TIMEOUT) --changed=$(UNIT_BASE) --pass-with-no-tests ./apps ./packages ./scripts ./integrations; fi

# SHARD=1/2 runs the first of two shards of the scenarios (CI's matrix); unset, all of them.
test-scenarios:
	@echo "==> scenarios (bun test tests$(if $(SHARD), --shard=$(SHARD)))"
	@$(SLOT) bun test $(call JUNIT,scenarios) $(TEST_TIMEOUT) $(if $(SHARD),--shard=$(SHARD)) ./tests

# The Console is built first (the global setup serves apps/console/dist); `bun test` never collects tests/e2e (*.e2e.ts). Playwright runs under Bun.
e2e:
	@echo "==> console build (apps/console/dist)"
	@bun run --cwd apps/console build
	@echo "==> e2e (playwright, tests/e2e$(if $(E2E_SHARD), --shard=$(E2E_SHARD)))"
	@$(SLOT) bunx --bun playwright test -c tests/e2e/playwright.config.ts $(if $(E2E_SHARD),--shard=$(E2E_SHARD))

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
