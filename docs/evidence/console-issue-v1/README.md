# Console v1: the Issue page

Screenshots from `tests/e2e/screenshots.e2e.ts` (`make e2e`), named `<viewport>-<theme>-<screen>.png`. `desktop-xl` is
1800×1200, `phone` 390×844 (the one 1280×800 shot is `desktop-dark-issue-overview.png`). Screens: `issue-overview`,
`issue-activity`, `issue-evidence`, `issue-checkpoints` (the seeded rich Issue: two attempts, two answered Decisions, a
Spec and a Concept with verdicts, a passed ship and a regressed one), `issue-working` (an Issue with a live lead) and
`issue-chain` (an Issue that waits on two others, one closed, and blocks a third).

## What I compared, and against what

The owner's reference images (`design-refs/console` in the factory's home directory) are **not on this machine**, so no
screen was compared against them. Each screen was judged against `apps/console/DESIGN.md` ("The screens: Issue", "Rules",
"The target"), by the lead looking at the shots, two rounds. No reviewer subagent ran on the boards and `basalt-ui shot` was
not run (the Console has no `data-shot` anchors yet); the code went through `/review`.

**Against "The screens: Issue".**
- Header: KindBadge, state Lozenge, a Regressed lozenge when a watch regressed, the project, the title, the summary, the
  owner's next moves as links (the Console only links), then a PropertyList of the facts.
- Tabs overview, activity, evidence, checkpoints with counts and the open checkpoints marked; the tab is `?tab=`, so a
  link opens it.
- Activity is a StepRail per attempt, in the factory's words, with the gap to the next event as the bar.
- A right panel with Properties and the chain around the Issue (what it waits on, what waits on it, each a link).
- Width: the main column and the 22 rem panel fill 1800; below `lg` they stack; 390 does not scroll sideways (asserted).

## Review rounds

| Round | Findings | What changed |
|-|-|-|
| 1 | No P0. P1: the summary and the phase were said three times (header, "What it is", the PropertyList); "What it is" repeated the title for an Issue filed with one. P2: a block of six raw evidence rows ("Commits 30 min ago") with no content; the Decision's "Recommendation" repeated the chip on its option; "Updated" twice in the header; the big working-time figure was a sentence ("under a minute") | Header keeps the summary and the facts only; "What it is" shows `about` only when it adds to the title; the evidence rows are a closed fold; the recommendation block shows only when it is not an option; one "Updated"; the figure is a compact duration |
| 2 | No P0, no P1. P3: a zero working time reads "0 ms" in the card and "under a minute" in the facts | Not changed |

Open, not chased: the seeded world has no usage rows, so the StatCards show zeros and empty bars here (the figures and the
bars per attempt are asserted against the API); hover and focus states are not in the shots; a `changes` verdict makes the
server write the artifact id into the note it files, and "Notes you sent" would print it (filed as a follow-up).
