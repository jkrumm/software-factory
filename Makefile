.DEFAULT_GOAL := help
.PHONY: help docs-check check check-fast check-steps check-fast-steps check-static guide-check accounts-bundle test test-unit test-unit-changed test-scenarios merge-guard e2e fmt deploy rollback verify version hygiene-tools

help:
	@echo "make check   install, format, lint, shellcheck, tsc, Console tsc, tokens, artifact templates and InfoHint definitions, e2e tsc, dead code the change introduces (fallow audit), boundaries, retired words, state words on screens, public scan, Issue diagram, generated CLI, tests, scenarios, Console build and Playwright (the merge gate)"
	@echo "make check-fast  the lead's local check (project.yaml checks.fast): everything of make check up to the tests, then the unit tests of the files the branch changed (CHECK_FAST_ALL=1: all of them); CI runs the full gate sharded"
	@echo "make merge-guard  run right before merging a PR: refuses unless the branch contains origin/master, its migration numbers are free, the head's CI finished green and master's last finished CI run is not red (MERGE_GUARD_ARGS=--wait waits for the head's CI; --allow-red only for the change that fixes a red master)"
	@echo "make docs-check  the README's counts and lists (event kinds, callers, tokens, screens, domains, states, Console port and writes) against the code, docs/settings.md against the settings loaders, the loops table of docs/architecture.md against the loop code; also this repo's hygiene probe \`readme\`"
	@echo "make hygiene-tools  install the host tools of the hygiene probes that Homebrew provides (osv-scanner, for the advisories probe)"
	@echo "make accounts-bundle  build packages/accounts into one file (packages/accounts/dist/claude-account, ACCOUNTS_OUT=<path>) that runs with bun alone: the claude-account for a machine without the factory"
	@echo "make guide-check  the guide (docs/guide): its own install, Basalt tokens current, pages, links into master and the code the pages quote (scripts/guide-links.ts), the VitePress build"
	@echo "make test    the unit tests and the scenarios"
	@echo "make e2e     build the Console and run its Playwright suite against a seeded server (tests/e2e; screenshots land in tests/e2e/out/screenshots)"
	@echo "make fmt     apply formatting"
	@echo "make deploy  deploy origin/master (or FACTORY_REF=<branch>) on the mini: release, LaunchAgent, health check, rollback (DRY_RUN=1 prints the plan)"
	@echo "make rollback swap back to the previous release (data/previous-sha): service, /health at the old sha, current, CLI, door (DRY_RUN=1 prints the plan)"
	@echo "make version print the deployed commit sha (one line; what the hold checks the shipped commits against)"
	@echo "make verify  prove the deployment: /health at the deployed sha, which is origin/master (or FACTORY_REF; behind it only by docs/tests, or by a merge younger than FACTORY_VERIFY_DEPLOY_GRACE_S=1800 whose deploy is pending, is fine), and the factory CLI against it"

# Tests start a private Postgres cluster (initdb) in a temp dir: PG_BIN_DIR points at the binaries when they are not on PATH.
check:
	@$(call slot,check) $(MAKE) --no-print-directory check-steps

# The lead's check after each change (project.yaml `checks.fast`): its own slot name, so the ledger learns its peak apart from the whole gate's.
# Two parts: the home part below edits the worktree (oxfmt --write) and always runs on the mini; the slot's part
# (check-fast-steps: static checks, the changed files' unit tests) edits nothing and is project.yaml `steps.check-fast`, `remote: true`:
# when the mini's line is long it runs on the step host (docs/architecture.md "Steps off the mini"), over the tree as formatted here.
# The slot's command is a bare `make`, not $(MAKE): that is the mini's absolute path (an Xcode make), which the step host lacks (exit 127).
#
# A lead's tree is formatted first, outside the slot (oxfmt --write takes ~50 ms): a format-only red used to cost a whole
# slot wait (up to 12 min measured) plus a rerun, and 11 of 21 steps of a day exited non-zero (#1639). CI ($$CI set) keeps
# the read-only `oxfmt --check` of check-static, so an unformatted head still fails there.
check-fast:
	@if [ -z "$$CI" ]; then before=$$(git diff | cksum); bunx --no-install oxfmt --write . >/dev/null; \
	  [ "$$before" = "$$(git diff | cksum)" ] || echo "==> oxfmt reformatted files in this tree: commit them"; fi
	@$(call slot,check-fast) make --no-print-directory check-fast-steps

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
	@echo "==> typecheck accounts (packages/accounts: the ported picker keeps its own index access rule)"
	@bunx --no-install tsc -p packages/accounts/tsconfig.json --noEmit
	@echo "==> typecheck console (apps/console)"
	@bun run --cwd apps/console typecheck
	@echo "==> console tokens are current (basalt-ui tokens:check)"
	@bun run --cwd apps/console tokens:check
	@echo "==> console artifact templates are current (scripts/templates.ts)"
	@bun run --cwd apps/console templates:check
	@echo "==> console InfoHint definitions are current (scripts/language.ts)"
	@bun run --cwd apps/console language:check
	@echo "==> console copy follows the voice rules (apps/console/scripts/copy.ts)"
	@bun run --cwd apps/console copy
	@echo "==> typecheck e2e (tests/e2e)"
	@bunx --no-install tsc -p tests/e2e/tsconfig.json --noEmit
	@echo "==> shard weights name no missing test file (scripts/shard.ts --check)"
	@bun scripts/shard.ts --check
	@echo "==> dead code the change introduces (fallow audit, against the merge base; .fallowrc.json)"
	@bunx --no-install fallow audit --only dead-code $(if $(UNIT_BASE),--base $(UNIT_BASE)) --quiet
	@echo "==> boundaries (scripts/boundaries.ts)"
	@bun scripts/boundaries.ts
	@echo "==> retired words (scripts/retired-words.ts)"
	@bun scripts/retired-words.ts
	@echo "==> retired words in README.md (every visitor reads it; CI's unit shard checks it too)"
	@bun scripts/retired-words.ts --files README.md
	@echo "==> README agrees with the code (make docs-check)"
	@$(MAKE) --no-print-directory docs-check
	@echo "==> state words on screens (scripts/vocabulary.ts)"
	@bun scripts/vocabulary.ts
	@echo "==> public hygiene (scripts/public-scan.ts)"
	@bun scripts/public-scan.ts
	@echo "==> guide pages, links into master and quoted code (scripts/guide-links.ts)"
	@bun scripts/guide-links.ts
	@echo "==> Issue diagram is current (apps/server/scripts/issue-diagram.ts --check)"
	@bun apps/server/scripts/issue-diagram.ts --check
	@echo "==> project.yaml schema and key reference are current (scripts/project-schema.ts --check)"
	@bun scripts/project-schema.ts --check
	@echo "==> docs/hygiene.md is current (scripts/hygiene-doc.ts --check)"
	@bun scripts/hygiene-doc.ts --check
	@echo "==> generated CLI is current (apps/cli/scripts/generate.ts --check)"
	@bun apps/cli/scripts/generate.ts --check
	@echo "==> KPI table of docs/product.md is the catalog (scripts/kpi-table.ts --check)"
	@bun scripts/kpi-table.ts --check
	@echo "==> next free migration number (scripts/merge-guard.ts): $$(bun scripts/merge-guard.ts --next-migration)"

# The self-contained claude-account for a machine without the factory (packages/accounts/docs/accounts.md): one file, runs with bun alone. ACCOUNTS_OUT overrides the path.
accounts-bundle:
	@bun packages/accounts/scripts/build.ts $(ACCOUNTS_OUT)

# The guide (docs/guide) has its own package and lockfile, outside the workspace: only this target and CI's `guide` job install it.
guide-check:
	@echo "==> guide install (bun install --frozen-lockfile in docs/guide)"
	@bun install --cwd docs/guide --frozen-lockfile
	@echo "==> guide tokens are current (basalt-ui tokens:check)"
	@bun run --cwd docs/guide tokens:check
	@echo "==> guide pages, links into master and quoted code (scripts/guide-links.ts)"
	@bun scripts/guide-links.ts
	@echo "==> guide build (vitepress build)"
	@bun run --cwd docs/guide build

# The tests run in one of the host's test slots (FL7) when `factory` is installed, so parallel checks do not pile their
# load onto each other; without it (CI) the bare command. That is the installed CLI of the running core until the
# cutover. A server that is down is waited for like a restart, then the tests run under a host-local slot.
# Not the checkout directory: every lead works in its own worktree (factory-719-1 ...), and the ledger and the grant rule
# learn a step's peak by its exact name, so a name per directory would never carry a peak from one lead to the next.
SLOT_PROJECT = software-factory
slot = $(if $(shell command -v factory 2>/dev/null),factory slot run --name "$(SLOT_PROJECT) $(1)" --,)
SLOT = $(call slot,test)
# The unit tests are a step of their own (project.yaml `steps.unit`): each file starts its own Postgres and touches nothing of the host.
SLOT_UNIT = $(call slot,unit)

# `factory slot run` sets FACTORY_JUNIT_DIR for the command it runs and posts the *.xml files left there beside the step's cost
# (test results per run: flake rate, failed-run minutes). Unset (CI, a run without a slot): no JUnit file.
JUNIT = $(if $(FACTORY_JUNIT_DIR),--reporter=junit --reporter-outfile=$(FACTORY_JUNIT_DIR)/$(1).xml)

# Every test file may start a private Postgres cluster in beforeAll and a scenario drives real processes; initdb alone takes seconds
# on a loaded runner. Bun 1.4 ignores `timeout` in bunfig.toml (tests ran at 5 s on CI), so the flag carries it.
# The per-test limit stretches with the host's load per core (up to 6x): at load 40 a test that takes 3 s idle takes minutes (Issue 719).
TEST_TIMEOUT = --timeout $(shell bun -e 'import {cpus,loadavg} from "node:os"; console.log(Math.round(30000*Math.min(6,Math.max(1,loadavg()[0]/cpus().length))))')

test: test-unit test-scenarios

# UNIT_SHARD=1/2 runs the first of two shards (CI: `static` runs the first beside the checks, `unit (2/2)` the second); unset, all of them.
test-unit:
	@echo "==> unit tests (bun test apps packages scripts integrations$(if $(UNIT_SHARD), --shard=$(UNIT_SHARD)))"
	@$(SLOT_UNIT) bun test $(call JUNIT,unit) $(TEST_TIMEOUT) $(if $(UNIT_SHARD),--shard=$(UNIT_SHARD)) ./apps ./packages ./scripts ./integrations

# The unit tests of what the branch changed (bun follows the imports from each changed file; committed and uncommitted
# changes against the merge base with origin/master). CHECK_FAST_ALL=1 (CI's `static` job) runs every unit test.
# The lead's run stops at the first failing test (UNIT_BAIL=--bail): a red run used to go on through every remaining file, and
# its minutes were a third of the slot time of failed software-factory runs (Issue 2375; the failing test itself takes seconds).
# `make check-fast UNIT_BAIL=` lists every failure in one run, as CI does.
UNIT_BAIL ?= --bail
UNIT_BASE = $(shell git merge-base HEAD origin/master 2>/dev/null)
test-unit-changed:
	@if [ -n "$(CHECK_FAST_ALL)" ] || [ -z "$(UNIT_BASE)" ]; then $(MAKE) --no-print-directory test-unit; else \
	  echo "==> unit tests of the changed files (bun test --changed=$(UNIT_BASE))"; \
	  $(SLOT) bun test $(call JUNIT,unit-changed) $(TEST_TIMEOUT) $(UNIT_BAIL) --changed=$(UNIT_BASE) --pass-with-no-tests ./apps ./packages ./scripts ./integrations; fi

# SHARD=1/3 runs the files scripts/shard.ts plans for the first of three shards of the scenarios (CI's matrix; seconds per file in
# tests/scenarios/shard-weights.json); unset, all of them.
test-scenarios:
	@echo "==> scenarios (bun test tests$(if $(SHARD), shard $(SHARD)))"
	@$(if $(SHARD),files=$$(bun scripts/shard.ts scenarios $(SHARD)) || exit 1;) \
	  $(SLOT) bun test $(call JUNIT,scenarios) $(TEST_TIMEOUT) $(if $(SHARD),$$files,./tests)

# The Console is built first (the global setup serves apps/console/dist); `bun test` never collects tests/e2e (*.e2e.ts). Playwright runs under Bun.
# E2E_SHARD=2/3 runs the files scripts/shard.ts plans for that shard (seconds per file in tests/e2e/shard-weights.json); unset, all of them.
e2e:
	@echo "==> console build (apps/console/dist)"
	@bun run --cwd apps/console build
	@echo "==> e2e (playwright, tests/e2e$(if $(E2E_SHARD), shard $(E2E_SHARD)))"
	@$(if $(E2E_SHARD),files=$$(bun scripts/shard.ts e2e $(E2E_SHARD)) || exit 1;) \
	  $(SLOT) bunx --bun playwright test -c tests/e2e/playwright.config.ts $$files

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

# A lead runs this right before it merges its pull request (AGENTS.md "Merging"): rebased, free migration number, green master.
merge-guard:
	@bun scripts/merge-guard.ts $(MERGE_GUARD_ARGS)

# Host tools of the hygiene probes: osv-scanner is for the hygiene `advisories` probe (Cargo, Python and Swift lockfiles); idempotent.
hygiene-tools:
	@brew list osv-scanner >/dev/null 2>&1 || brew install osv-scanner
	@osv-scanner --version

# The README states counts and lists (event kinds, callers, tokens, screens, domains, states, the Console's port and writes): this reads them
# from the code and fails on a README that disagrees. docs/settings.md is generated from the settings loaders (scripts/settings-table.ts) and fails
# when it is not what they say; so is the loops table of docs/architecture.md (scripts/loops-table.ts). A step of check-static and this repo's hygiene probe `readme` (project.yaml `hygiene.probes`).
docs-check:
	@bun scripts/readme-check.ts
	@bun scripts/settings-table.ts --check
	@bun scripts/loops-table.ts --check
