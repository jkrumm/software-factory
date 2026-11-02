.DEFAULT_GOAL := help
.PHONY: help check deploy verify

# Production lives outside the repo, whatever checkout or worktree deploys.
DEPLOY_DIR ?= $(HOME)/.local/share/factory/gameday-deploys/factory-gameday-bug

help:
	@echo "make check   the tests"
	@echo "make deploy  copy bin/ and deploy/limits.conf to the production directory (HEAD must be origin/master)"
	@echo "make verify  run the deployed copy against its own config; its revision must be origin/master"

check:
	@bash test/run.sh

deploy:
	@head=$$(git rev-parse HEAD); want=$$(git ls-remote origin master | cut -f1); \
	if [ "$$head" != "$$want" ]; then echo "deploy: FAIL HEAD $$head is not origin/master $$want"; exit 1; fi; \
	mkdir -p "$(DEPLOY_DIR)/bin" "$(DEPLOY_DIR)/config"; \
	cp bin/wordstat "$(DEPLOY_DIR)/bin/wordstat"; cp deploy/limits.conf "$(DEPLOY_DIR)/config/limits.conf"; \
	echo "$$head" > "$(DEPLOY_DIR)/REVISION"; echo "deploy: ok $$head"

verify:
	@want=$$(git ls-remote origin master | cut -f1); have=$$(cat "$(DEPLOY_DIR)/REVISION" 2>/dev/null || echo none); \
	if [ "$$have" != "$$want" ]; then echo "verify: FAIL deployed $$have, origin/master $$want"; exit 1; fi; \
	if ! out=$$("$(DEPLOY_DIR)/bin/wordstat" --self-test 2>&1); then echo "verify: FAIL the deployed copy: $$out"; exit 1; fi; \
	echo "verify: ok $$have ($$out)"
