# Console IssueCard v2: kind icon, project and number on top, the title in an inset body

Issue 657. The owner's review of Console v1: the title shared its line with "10h ago" and had no room, the card did not
look like the StatCards above the board, the Issue number was missing, and the kind could be a symbol. The card is one
kit component used on Flow, Chain and `/kit`, so it is fixed once.

Screenshots come from `tests/e2e/screenshots.e2e.ts` (`make e2e`), named `<viewport>-<theme>-<screen>.png`:
`desktop-xl` is 1800×1200 (the primary target), `desktop` 1280×800, `phone` 390×844. Screens touched: `flow`, `chain`
and `kit-tall` (the whole `/kit` route; its "Issue cards and rows" section holds every state). `kit-card-hover` and
`kit-card-focus` clip one card in the hovered state and after a real keyboard Tab (the focus ring is asserted in the test,
not only shot). `round1-` and `round2-` files are the same screens in the first two rounds, kept for the comparison.
Needs you, Improve and the Issue page render no IssueCard, so they are unchanged and not re-shot.

## What changed

- **Anatomy** follows the StatCard: a shell surface (`bg-card`) holding a header and a footer, the title alone in an
  inset body one surface step down (`bg-background`), no border for depth, no coloured bar.
- **Header:** the kind as an icon (`KindIcon`, its name the tooltip and the accessible name), the project chip, the Issue
  number in mono (`#12`), the origin as a muted word only where it is not You, the Lozenge at the right where the
  column does not name the state; ⋯ swaps with it on hover.
- **Body:** the title at 13 px (it was 15 px), clamped to three lines, never sharing a line with the age.
- **Footer:** the wait or queue reason with its icon on the left, the age in mono on the right.
- **Chain:** the node is the same card with `compact` (two-line title, one-line reason) at 320 × 144 (was 128).
- **Focus ring** (found in round 2): `IssueCard` and `StatCard` set `box-shadow` inline for their depth, which overrode the
  `ring-3` utility, so a keyboard-focused card showed no ring. `LINKED_CARD` now draws the ring as an `outline`.

## What I compared, and against what

The owner's reference images (`design-refs/console`) are **not on this machine**, so no screen was set beside them. The
in-product reference is the StatCard row on the same Flow screen and on `/kit`, which is built from his reference 03 and
reviewed against it in `docs/evidence/console-kit`. Each round a fresh reviewer subagent was briefed with
`basalt-design-reviewer.md` and `apps/console/DESIGN.md`, saw the round's shots (round 2 beside round 1) and was given
no target score. `basalt-ui shot` boards were not run (the Console has no `data-shot` anchors), so the checks that need
metrics were made by eye.

| Round | What the reviewer found | What changed |
|-|-|-|
| 1 | P1: the dark inset is nearly the shell's value. P1: a footer holding only an age wastes about 30 px on most Flow cards. P1: the Chain node (184 px) has a large empty inset where titles are short. P1: the phone Chain is a rail of cards with cut-off edges. P2: header crowded and the number as quiet as the origin word; "You" repeated on every card; title and header on different left edges; the kind icon low in contrast. P2: no hover or focus shot | Footer slimmed when there is no reason; the number set in foreground ink; the kind icon one step stronger; the body padded to the header's left edge; "You" dropped; the Chain node became a `compact` card at 144; hover and focus shots added |
| 2 | Every screen better than round 1 and nothing worse. P1: the focus state is not visible in the shot; the hover is faint in dark. P2: the dark inset still faint; the age-only footer; the compact reason truncates; Chain at 1280 unreadable | The focus ring was really missing (the inline box-shadow beat the ring utility): moved to an outline in `LINKED_CARD`, the test now keyboard-tabs to the card and asserts the outline before and after focus |
| 3 | I read the round's focus, hover, Flow, Chain and `/kit` shots in dark and light at 1800×1200 myself: the ring is drawn in both themes, the compact card, the long title (clamped with an ellipsis) and the plan row (dashed, no number, no age) read cleanly | Nothing further |

Judged and not changed:

- **The dark inset against the shell** uses exactly the StatCard's token pair. The StatCard's inset reads because it holds a
  chart; a one-line title strip is flatter. Raising it only for the card would put two different pairs on one screen.
- **The age-only footer** stays: the age sits in the same place on every card (the footer, right), and the footer with no
  reason is the slimmest line the anatomy allows. Moving it to the header would make its place depend on the reason.
- **Phone Chain and the Chain fit at 1280** are the graph's existing fit-to-view and phone layout, not the card.
- **The kit Row on a phone** wraps its reason under the title; no screen uses the row yet.

## Known gaps

- No comparison against the owner's reference images (not on this machine).
- Hover is a faint step in dark (the shell moves to `bg-accent`, as for the StatCard); the ⋯ is the visible cue.
- `IssueRow` is shown on `/kit` only; no list renders it yet.
