# One live pass of the Judge (Issue 371)

2026-11-08, on the mini, `agw factory-ask` (the workflow the settle loop calls through the agw port) with a complete
Decision form as `judgeInputOf` builds it: the question is the one Issue 350's lead raised that night (a watch fault, not
a product choice), two reversible options, no precedents.

Input (fields as the Judge receives them): `question`, `recommendation`, `checked`, `options[{label,reversible,cost}]`,
`noAnswer`, `precedents: []`, `repo`, `issue`.

Reply (run `01a1b986-70a4-701f-a9b3-853e8ad339b0`, status `done`, cost $0.0004):

```json
{
  "verdict": "answer",
  "answer": "Change the probe: read the synced project.yaml",
  "reason": "Both options are reversible and no owner-class concern applies; the facts show project.yaml declares the verify target and the probe reads the Makefile wrongly, so the probe is the fault.",
  "source": "facts: project.yaml declares deploy mode auto and verify make verify; the watch reads the Makefile instead."
}
```

What it shows: a complete Decision is answerable by the Judge before the owner sees it. Issue 350's three Decisions were
the same kind; with this change they are judged first, and a repeat of the question amends the open one.
The factory's own pass (`settleDecision`) records the same verdict as the `judge` step of the Decision (`path` in
`factory decision list`, `judge` on the Decision view and the Needs you item).
