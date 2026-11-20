# Research: published procedures for cleaning up a fast-iterated, agent-written backend

Run 2026-11-20 through `agw research --depth deep`; 26 of 27 citations grounded against fetched pages. Vendor claims and the items under "Uncertain or open" are leads, not facts.

## Bottom line

- Published tooling for this job falls into four kinds. (a) Diff-scoped deslop prompts and skills that clean the branch diff: lucasb-eyer's original Codex prompt, chrisliu298/deslop, J7Forge Slop-Popper, steveclarke's eight-pass deslop, and Claude Code's bundled /simplify. (b) Taxonomy-driven review skills: boudra/unslop (11 reference categories), the FasalZein/desloppify CLI and skill, and the peteromallet/desloppify harness with a score. (c) An architecture-deepening review skill: mattpocock's improve-codebase-architecture plus codebase-design. (d) Deterministic analyzers that produce the evidence: knip and fallow. fallow also checks hexagonal layer rules.
- For a hexagonal TypeScript modular monolith, the procedure I would adopt: deterministic detection first (knip, fallow), then one-category-per-pass agent cleanup inside a test-locked, save-pointed, size-capped loop, then architecture deepening as a separate, human-gated track. Section 2 gives the steps.
- Evidence: I found no independent study that tests a named slop skill on a production backend for behaviour preservation. The best controlled evidence is a 2026 paired experiment on single-file competitive-programming code. Giving the agent static-analysis feedback raised the rate of effective refactorings by 21 to 26 percentage points. It also shifted failures toward logical test failures, added coupling smells, and cost 3 to 5 times the tokens. Behaviour safety in the published skills comes from their procedures (tests before edits, no new failures against a baseline, size caps, held risky changes). It is not demonstrated by results.
- Naming caveat: 'unslop' is used by several unrelated skills. The code one is boudra/unslop. OPSHARP/unslop, Agusttin-0/unslop-skill and SalvatoreCampagnese/unslop-skill are prose or UI tools.

## 1. The tools and skills

### 1.1 Deslop family (diff-scoped cleanup prompts)

- **Origin: lucasb-eyer's Codex prompt 'deslop'.** It checks the diff against main in this order: staged, unstaged, then main..HEAD. It removes extra comments a human would not write or that clash with the file, defensive checks or try/catch that are abnormal for the area (especially behind validated call paths), variables or functions used once right after declaration, redundant checks and casts the caller already covers, and style inconsistent with the file. Rules: do not remove the feature, do not stage, and report in 1 to 3 sentences.
- **chrisliu298/deslop** (Claude Code and Codex). It reads the full file first and treats the existing code as the style guide. It keeps why-comments, security-rationale comments, and defensive code at real boundaries (API endpoints, user input, external I/O). Its stated rule: when in doubt, leave it in.
- **steveclarke/dotfiles 'deslop'** (originally brianlovin/agent-config, based on a pattern from Shaw). Eight passes, each run by a fresh subagent with a narrow mandate: DRY and dedupe; consolidate shared types; remove dead code using stack-appropriate tools; untangle circular dependencies; replace weak types (any, unknown, T.untyped, interface{}); remove defensive try/catch that swallows errors; collapse legacy, deprecated and fallback code to one current path; remove AI-slop comments.
- **J7Forge Slop-Popper v3** (MIT). The most fully specified procedure I read. Commands: /deslop (staged changes, pre-commit), /deslop-full [path], /deslop-since <ref>, /deslop-review, /deslop-approve, /deslop-reject, plus --dry-run and --classic. A catalog of categories 01 to 13 is applied in pass order: dead code, duplication, needless abstraction, boundary violations, defensive slop, error handling, naming, type and import, logging and debug, placeholder content, comment noise, missing tests, UI defaults. Careful mode (the default) applies automatically: deleting dead or duplicate code, renaming vague names with their callers, removing pass-through wrappers, moving code to the right module, removing comments and debug output. It holds for review: signature changes, logic changes, whole-file reformats, library swaps, config values, public renames, and deletion of test-only code. Safety rules: save-point patches under .git/deslop, lock behaviour with the narrowest tests first, no new test failures against the baseline, lint and type checks no worse, one category per pass, a size cap of about 10 files or 300 changed lines before asking, never commit, and a keep list (KEEP.md or .deslopkeep) that wins over everything.
- **boudra/unslop** (MIT; Claude Code and Codex slash command). The entry point is skills/unslop/SKILL.md, which loads category reference docs on demand: noise, structure, module, bolt-on, unconfident, density, types, errors, tests, naming, react. Two modes: retroactive (code exists) and forward (unslop the plan before code is written). Procedure: determine scope; read the full file and its conventions; load the category docs; record each finding with file and lines, category, one-sentence problem, one-sentence fix, and severity high, medium or low; fix high first; after each file run typecheck, lint and format; then run the relevant test suite; summarise. Its judgment test: would a senior engineer on this team flag this in code review? It also recommends splitting the work into focused audits run by separate agents.
- **Claude Code /simplify (bundled).** Anthropic's help article confirms that /simplify is a bundled skill that ships with the CLI. A third-party reconstruction of its prompt says it reviews the git diff with three parallel subagents (code reuse, code quality, efficiency), deduplicates findings, skips false positives, applies fixes automatically, and reads CLAUDE.md for standards. The official source is not public, so treat the reconstruction as approximate.
- **Cursor and Codex.** A cursor-deslop skill exists on skills.sh (theangrypit): check the diff against main and remove AI slop. I have only its search snippet. Codex has no built-in equivalent that I found; the Codex-side tools are the lucasb-eyer prompt and the skill-folder installs of chrisliu298/deslop and Slop-Popper.
- **Seen in search only, not read:** anolilab/skills deslop (mock-heavy tests, Tailwind classes), lootlog/monorepo deslop, michael-denyer/pstack-claude deslop, mdsmithaustin/pstack deslop, kirankunapuli/stop-ai-slop, MammadovEshgin/clean-code-skill, whoisalibtw/senior-codebase-cleanup, rohitg00/pro-workflow deslop.

### 1.2 Desloppify (two different projects with the same name)

- **FasalZein/desloppify** (agent-agnostic CLI, MIT). Its README says 10 categories, 36 rules, 4 safety tiers, with packs for js-ts, python, rust, go and ruby. Detected categories include AI slop (banner comments, narration, hedging, placeholder names such as data2, console.log of placeholders), complexity (god files, barrel exports, deep nesting), security, test quality (empty tests, weak assertions, sleepy tests, skipped tests), async (forEach(async), sequential independent awaits), dead code, weak types (any, as any, @ts-ignore), unvalidated input (req.body, JSON.parse casts), and naming. Commands: scan with --pack js-ts, score, report, delta with --fail-on added,worsened, and fix with --safe, --confident (AST-validated) or --all. install-hooks sets a pre-commit hook that scans staged changes and a pre-push hook that scans changed files; by default they block only on HIGH or CRITICAL findings. Fixes run in isolated git worktrees, followed by a formatter pass (biome, oxfmt). Its js-ts pack wraps knip, tsc, ast-grep, eslint, biome and oxlint, with madge opt-in for cycles. Workflow: scan, triage each item as fix, skip or flag, fix in worktrees, merge, re-scan, and confirm the score improved. Scoring: each issue deducts points by severity and category weight, with a per-category cap. Grades run from A+ (95 to 100) to F (0 to 29).
- **peteromallet/desloppify** (Python, about 4.1k stars). Mechanical detectors (dead code, duplication, complexity, test gaps, naming) plus LLM subjective review of naming, abstractions, error handling and module boundaries. Loop: scan, score, review, triage, execute (next, fix, resolve), rescan. State persists in .desloppify/ across sessions. Its internals README says findings are weighted by tier (T4 counts 4x, T1 counts 1x), the strict score penalises both open and wontfix items, and a suspect guard holds resolution when a detector drops from 5 or more findings to 0 (bypass: --force-resolve). CI uses scan --profile ci followed by status --json. The README claims a score above 98 should correlate with a codebase a seasoned engineer would call beautiful. That is an unvalidated claim. A third-party index summarises the weighting as 25% mechanical and 75% subjective; I could not read scoring.md, so that split is unverified.

### 1.3 improve-codebase-architecture (mattpocock/skills)

- **Process** (SKILL.md, read). Step 1, explore. Scope first (YAGNI): if no direction is given, walk git log --oneline for hot spots and weight recently changed areas. Read GLOSSARY.md and any ADRs in the area. Spawn a sub-agent with a fresh context to walk the code and note friction: understanding one concept requires bouncing across many small modules; shallow modules whose interface is nearly as complex as the implementation; pure functions extracted only for testability while bugs hide at call sites; tight coupling across seams; untested or hard-to-test areas. Apply the deletion test to each suspect. Step 2, present candidates as a self-contained HTML report in the temp directory. Each candidate has files, problem, solution, benefits (locality and leverage), a before and after diagram, and a strength of Strong, Worth exploring or Speculative, ending with a top recommendation. It must not propose interfaces yet; it asks which candidate to explore. Step 3, grilling: walk the decision tree with the user, update GLOSSARY.md inline, and offer an ADR only when a rejection reason would be needed later. disable-model-invocation is true, so a user must invoke it.
- **Vocabulary** (codebase-design SKILL.md, read). Module, interface (including invariants, ordering, error modes), depth, seam, adapter, leverage, locality. Deletion test: if deleting a module makes complexity vanish, it was a pass-through; if complexity reappears across N callers, it earns its keep. The interface is the test surface. One adapter means a hypothetical seam; two means a real one. It explicitly rejects measuring depth as the ratio of implementation lines to interface lines.
- **Caveat:** this is a recommendation generator. It has no verification step and it changes nothing by itself. I found no published evaluation of it.

### 1.4 Deterministic analyzers

- **knip** (knip.dev). Finds unused files, dependencies and exports. Over 200 plugins supply entry points for frameworks and tools. Options include --fix, --production, --strict, --trace, --watch, --cache, JSDoc tags to exclude exports, and a rules filter. The site cites 86M downloads a month and 21,000 public projects; those are vendor figures. Its feature list also shows the main risk: dynamic usage has to be covered by plugins, entry paths or config.
- **fallow** (fallow-rs/fallow, MIT, Rust on Oxc, about 5.4k stars). Commands: npx fallow (health, duplication, unused code); fallow audit, which compares against the base branch and fails only on findings the change introduces, with no baseline file; fallow dead-code --trace file:export, which shows where an export is used before you delete it; fallow fix --dry-run, then fix; fallow health, a 0 to 100 score with hotspots; fallow dupes; fallow architecture and fallow guard with bulletproof, layered, hexagonal and feature-sliced presets; fallow flags for feature-flag patterns; and opt-in fallow mutation, which runs the project's tests against small source changes to find changes no test detects. fallow agent install sets up Claude Code, Codex and Cursor with an AGENTS.md task map, skills, an MCP server and a git commit and push gate. The README's speed claims (for example 2.95s on next.js's 20,558 files, and 3 to 36 times faster than knip) are vendor measurements; I did not verify them.
- **Hexagonal preset** (fallow docs via Context7). Three zones: adapters, ports, domain. Allowed direction: adapters to ports, ports to domain; domain is isolated. You can replace a preset zone's pattern while keeping its rules, for example domain as src/core/**.
- **desloppify's js-ts pack wraps knip**, so the two can be used together.

## 2. Procedure to adopt (for a hexagonal TypeScript backend)

This merges the steps of Slop-Popper, unslop, steveclarke's deslop and desloppify. The ordering and gates are my synthesis from those sources.

**Phase 0, preconditions.** Use a git repo with a clean working tree on a branch. Save a point first: git diff --cached --binary and git diff --binary into .git/deslop, so the cleanup can be undone. If a target has no tests, write characterisation tests for the narrowest code you will touch, or write a verification plan before editing.

**Phase 1, baseline.** Run typecheck, lint, the test suite, knip or fallow dead-code, fallow dupes, and fallow architecture. Run checkers cache-free (for example ruff --no-cache, python -B). Record counts. Show only failing lines and counts, not full logs.

**Phase 2, detect deterministically.** fallow dead-code and knip for unused files, exports and dependencies. fallow dupes for duplication. fallow architecture with the hexagonal preset (or your module zones) for adapter, port and domain violations and wrong-direction imports. fallow flags for feature-flag accretion. Circular dependency checks. Treat every tool result as a lead, not an order. Before deleting, check reflection, dynamic dispatch, DI container registration, generated code, and test-only usage. Add missing entry points and exclude generated files in config.

**Phase 3, read conventions.** Read the nearby files' style, CLAUDE.md or AGENTS.md, lint configs, and the keep list (KEEP.md or .deslopkeep). If sources conflict, the keep list wins, then explicit user instructions, then repo docs, then the skill's defaults.

**Phase 4, plan and cap.** List findings by category with stable keys (file:symbol). If the whole plan touches more than about 10 files or 300 changed lines, show it and ask before editing. Batch the work to stay under the cap.

**Phase 5, passes, one category at a time, safest first.** Run targeted tests after each pass.
1. Dead code: delete unreferenced code. In the same pass, re-check callees, helpers and test fakes that lost their last caller. Test-only code goes to the review list, not the delete list.
2. Stale flags, config and commented-out code: remove only after confirming reachability. Config value changes are held for review.
3. Duplication and shared types: consolidate only where it reduces complexity; reuse existing helpers.
4. Needless abstraction: pass-through wrappers, single-use helpers and variables, single-implementation interfaces. Apply the deletion test before collapsing a module. Removing a parameter from public or external-facing code is held.
5. Boundaries: move misplaced code to the right module, fix wrong-direction imports, and check results against the fallow boundary rules.
6. Defensive code and impossible states: remove guards on values the types already guarantee, and guards that cannot fire. Keep validation at real boundaries (HTTP, queue messages, external I/O, DB rows). Parse once at the edge instead of threading uncertainty (unslop's 'unconfident-slop' category).
7. Error handling: remove swallowing catch-alls and log-and-rethrow; replace plain Error with typed domain errors where the codebase has them. Changing success flags into exceptions is held.
8. Types: remove any, unjustified casts and ts-ignore that hide a real mismatch. These are type-level edits but touch many files, so keep them in separate passes.
9. Comments and naming: delete narration, step comments, change-log residue and banners. Keep why-comments and security-rationale comments.
10. Tests: remove tests pinned to internals, weak assertions and mocks where real dependencies belong. Add missing tests as review items, not inside the cleanup pass (Slop-Popper's /deslop does this).

**Phase 6, gates after each pass.** No new test failures against the baseline (pre-existing failures may remain, but list them). Typecheck and lint no worse. fallow audit or desloppify delta --fail-on added. If a gate fails, fix the cause or back the change out. Never force it through.

**Phase 7, report.** Changed files, count per category, held items with IDs, baseline versus after numbers, kept items, and the save-point paths with undo commands. Do not commit; the user commits.

**Phase 8, architecture track (separate, human-gated).** Run improve-codebase-architecture. Choose one candidate. Grill it. Record rejections as ADRs when the reason is load-bearing. Implement behind the existing tests. One open question for hexagonal ports: the skill's rule 'one adapter means a hypothetical seam' does not settle whether a port with a production adapter and an in-memory test double counts as real. My reading is that it does, but decide explicitly and record the decision.

**Phase 9, prevent recurrence.** Pre-commit hook: desloppify install-hooks (staged scan) or fallow hooks install --target git. CI gate: fallow audit, which fails only on findings a change introduces. Add a CLAUDE.md or AGENTS.md rule after each correction (the Claude Code team's advice is to have the agent write the rule itself).

**Scoring notes.** The 0 to 100 grades (desloppify, fallow health) measure smells, not correctness. No published score I found predicts behaviour preservation. CodeScene's CodeHealth scale (1 to 10) was used in the paired study, and its break-even points were specific to that setup.

## 3. Slop categories and what covers them

| Category | Covered by | Notes |
|---|---|---|
| Dead code | knip, fallow dead-code, desloppify dead-code, Slop-Popper 01, steveclarke pass 3 | Tools produce leads; check dynamic usage and DI wiring first. Test-only code is flagged, not deleted (Slop-Popper). |
| Shallow modules, pass-through layers | codebase-design deletion test, improve-codebase-architecture, unslop module-slop and structure-slop, Slop-Popper 03 | No tool detects shallowness automatically. The judgement is agent-made and needs a human gate. |
| Duplicated concepts | fallow dupes, desloppify, Slop-Popper 02, steveclarke passes 1 and 2, unslop structure-slop | Duplicate code and duplicate types are different problems. Consolidate only when it reduces complexity. |
| Defensive code and impossible states | unslop unconfident-slop, Slop-Popper 05, lucasb-eyer prompt, chrisliu298/deslop, steveclarke pass 6 | Keep checks at real boundaries; remove the rest. Tools mostly do not detect this. |
| Comment slop | Slop-Popper 11, unslop noise-slop, steveclarke pass 8, chrisliu298/deslop | Keep why-comments and security rationale. |
| Test slop | unslop tests-slop, Slop-Popper 12, desloppify test-quality rules | Desloppify catches empty, skipped and weak-assertion tests; the rest is judgement. |
| Config and flag accretion | fallow flags, Slop-Popper 01 (stale flags), desloppify config overrides | I found no tool that checks flag lifecycle end to end. |
| Leftover migration scaffolding | steveclarke pass 7 (legacy, deprecated and fallback paths), Slop-Popper 01 (commented-out blocks) | No dedicated tool found. |

## 4. Evidence

### 4.1 Controlled studies

- **Paired experiment on metric-guided agentic refactoring** (Hagatulah, Borg, Söderberg, 2026). 24,620 single-file solutions in C++, Java and Python, 49,240 agent runs, the gptme agent with Qwen3-Coder-30B-A3B. In the Basic condition the agent judges maintainability itself. In the Guided condition it can query CodeScene's code_health_review tool. Guidance raised the effective refactoring rate by 21 to 26 percentage points, shifting agents from cosmetic edits toward structural ones. The benefit depends on starting code quality: below CodeHealth 4.9 (C++) to 7.1 (Python), guidance lowered the effective rate, driven by a lower test pass rate. Guided runs shifted failures toward logical test failures, introduced new coupling smells, and used about 3 to 5 times the tokens over about 2 times as many turns. The agent could not see the test suite. Its oracle was STDIN/STDOUT tests. The authors say the break-even points should not be read as general thresholds.
- **Agentic refactoring in Java PRs** (Horikawa et al., 2026, ACM TOSEM). 51,412 refactoring instances across 12,256 PRs from the AIDev dataset. Agents' refactorings are small but significant improvements in class size and complexity, and they do not consistently reduce the count of known design and implementation smells. The most frequent operations were Rename Variable (7.6%) and Change Variable Type (6.8%). The paper cites Cedrim et al. as finding that fewer than 10% of refactorings effectively remove code smells while over 30% introduce new ones. The paper also cites Szoke et al. as finding that only large, systematic bulk refactorings produce measurable quality gains. That is a tension with the small-diff caps in Slop-Popper and desloppify's per-category approach.
- **Agent PR revisions** (Watanabe et al., 2026, cited in the paired study). 45.1% of 567 merged Claude Code PRs needed later human revisions.
- **Reuse** (ACM 3793622, search snippet only). LLM agents frequently disregard code reuse opportunities. Read the paper before relying on this.

### 4.2 Tools

knip and fallow are deterministic. Their evidence is adoption figures and testimonials (knip.dev collects tweets; one quoted user warns that using knip plus code search to delete code 'works too well' and can produce unreviewable diffs). I found no independent false-positive rate for either tool. Their outputs are reproducible, and fallow states that the same input yields the same output.

### 4.3 What is missing

No independent evaluation of unslop, deslop, Slop-Popper, desloppify, /simplify or improve-codebase-architecture on production backends with behaviour checks. The only behaviour-preservation evidence is the Java PR study and the competitive-programming experiment above.

Practices the cited evidence supports: (a) give the agent measurable feedback rather than general style instructions; (b) treat tool findings as leads that must be verified (fallow --trace, Slop-Popper's 'confirm each finding'); (c) gate on newly introduced findings only (fallow audit, desloppify delta); (d) keep the test suite as the behaviour oracle and never let an agent change tests and code in the same unreviewed step; (e) keep risky changes (signatures, public API, logic) behind review, as Slop-Popper does.

## 5. Hexagonal and modular-monolith notes

- fallow's hexagonal preset enforces adapters to ports to domain, with domain isolated. Replace the zone patterns with your folder names. fallow's preset docs describe hexagonal, not modular monolith. desloppify's CLI lists an --architecture modular-monolith bundle, which I did not read. Check whether it covers your module boundaries.
- unslop's module-slop category (flat peer files, directory-as-namespace, tests only on extracted helpers, leaky internals) is the category closest to hexagonal shape problems.
- Deep-module reasoning favours fewer, deeper modules behind one interface. Ports with one adapter and no test double are the likeliest pass-through candidates. Keep ports whose adapters vary, such as real versus in-memory.

## 6. Uncertain or open

- desloppify's score weighting (25% mechanical, 75% subjective) comes from a third-party index. I could not read scoring.md.
- The /simplify prompt is a reconstruction, not the shipped source.
- The FasalZein desloppify SKILL.md body was not readable; its workflow is taken from the README.
- The desloppify.it site timed out and was not read.
- Vendor claims are unverified: knip's download and project counts, fallow's speed claims, and desloppify's 98-score claim.
- Migration-scaffolding and flag-lifecycle detection: no dedicated tool found.
- Cursor has no verified built-in cleanup command; cursor-deslop is known only from a search snippet.
- The paired experiment uses a 30B open-weight model on single files. Transfer to a backend with cross-file dependencies is unmeasured.

## Sources

- https://github.com/FasalZein/desloppify
- https://github.com/peteromallet/desloppify
- https://github.com/peteromallet/desloppify/blob/main/desloppify/README.md
- https://github.com/J7Forge/Slop-Popper
- https://github.com/J7Forge/Slop-Popper/blob/main/slop-popper/SKILL.md
- https://github.com/boudra/unslop
- https://github.com/boudra/unslop/blob/main/skills/unslop/SKILL.md
- https://github.com/mattpocock/skills/blob/main/skills/engineering/improve-codebase-architecture/SKILL.md
- https://github.com/mattpocock/skills/blob/main/skills/engineering/codebase-design/SKILL.md
- https://github.com/fallow-rs/fallow
- https://knip.dev/
- https://knip.dev/overview/features
- https://www.skills.sh/steveclarke/dotfiles/deslop
- https://github.com/noelzappy/claude-code-system-prompts/blob/main/prompts/19_simplify_skill.md
- https://support.claude.com/en/articles/14554000-claude-code-power-user-tips
- https://github.com/lucasb-eyer/dotfiles/blob/master/_codex/prompts/deslop.md
- https://github.com/chrisliu298/deslop/blob/main/README.md
- https://arxiv.org/html/2610.33343
- https://arxiv.org/pdf/2511.04824
- https://skillsmp.com/creators/peteromallet/desloppify/docs
- https://www.skills.sh/theangrypit/theangryskills/cursor-deslop
- https://dl.acm.org/doi/full/10.1145/3793302.3793622
- https://github.com/FasalZein/desloppify/tree/main/skills/desloppify
- https://context7.com/fallow-rs/docs
