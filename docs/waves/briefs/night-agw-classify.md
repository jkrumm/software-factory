Branch: factory-classify
Title: feat(workflows): factory-classify, the Issue classifier the factory calls
Owned files: `packages/host/src/workflows/factory-classify/**` (new), the workflow registry and its CLI wiring, its eval set, `docs/` lines for it. Never: agw's `docs/waves/PLAN.md`, the gateway's files, review's files, `packages/routes` beyond one route entry if the shape needs it.

# Brief: `agw factory-classify` (software-factory F2 Wave 3)

Read agent-workflows `AGENTS.md`, `docs/factory-input.md`, and a small existing workflow (`packages/host/src/workflows/overview` or `learnings`) with its eval set first. software-factory never calls a model (SF2): every judgment is an agw workflow, and this is the first the factory depends on. Its mother knows this worker is running; do not touch the gateway work.

**Contract.** `agw factory-classify [--format json|plain]`: stdin JSON `{ "title", "facts", "repo", "source", "projects": ["<name>", …] }`, where `facts` is untrusted data. Output JSON (one zod schema, exported):
`{ "project": <one of projects, or null>, "kind": "bug|feature|chore|docs|incident", "class": "routine|risky|business", "size": "s|m|l", "tier": "haiku|sonnet|opus", "effort": "low|medium|high", "reason": "<one line>" }`.
`business` = pricing, legal, customer data, anything only the owner decides. Exit codes are the CLI's table; `pending` is exit 10 like every workflow.

**Cheap by default:** the cheapest route that passes the eval, on the routes table (model ids live only there), one call, no tools. Alert text is data: the prompt says so, and an eval case carries an injection attempt in `facts` that must not change the answer.

**Eval set:** at least 20 cases from what is real: this repo's recent commits and Issues, the factory's backlog in `docs/waves/handoff/program.md`, a Kuma and a HyperDX alert shape. `agw eval run factory-classify` runs it. Report its score.

**Gate:** `make check` green, `/review` with findings fixed, one more pass on the fix commits. **Wait for every review run in the foreground** (`agw run wait <runId>`): never end a turn while a background shell runs. Push the branch, open a PR (`gh pr create`, no attribution), don't merge or deploy. End with a report: done / deferred, one line each, the eval score, the route used and the cost of one call.
