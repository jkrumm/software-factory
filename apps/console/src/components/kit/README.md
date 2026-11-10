# Kit

The Console's components, each depending only on Basalt tokens (`--vx-*` through the bridge in `src/styles/index.css`),
`cn()`, Phosphor icons and Base UI or `components/ui/` primitives, so they can move to basalt-ui. One file per component;
`index.ts` is the barrel; `fixtures.ts` is the data `/kit` shows them on. The anatomy and the rules are `DESIGN.md`.

- **Tone** is chosen by the caller or by an explicit map (`LOZENGE_TONES`), never derived from a word. A tone paints a
  tint, an icon or a mark; text beside a chart stays in the text tokens.
- **Charts** (`Sparkline`, `MiniBars`, `Meter`) are hand-drawn SVG with no animation, a tooltip on hover and on keyboard
  focus (arrow keys, Home, End), and the numbers as an accessible name plus a visually hidden table. Their colours are the
  semantic tones (accent, good, warn, bad, the quiet line; a `Meter` is graphite and takes warn from 75 % and bad from
  90 %, `meterTone`), not a categorical palette, so the `dataviz` skill's palette
  validator does not apply: each chart holds one series and carries no legend.
- **`Sparkline`** takes `(number | null)[]` (a `null` breaks the line, never a zero; the tooltip says `emptyText`) and a `target`
  that is a number (one dashed line) or `{min, max}` (two dashed lines and a faint band). **`StackedBars`** stacks one
  segment per series in the series' fixed order, a 2 px surface gap between them, with a legend of totals, a tooltip per bar
  that lists the series (`ChartRow.lines`) and the hidden table. Its series colours are `--vx-series-1` to `-9` from
  `src/styles/series.css` (the dataviz skill's palette, validated in dark and light; slot 9 is the quiet "Other"): a series
  keeps its `slot` whatever else is shown. `no-raw-colour.test.ts` lets that one file hold literals.
- **StatCard `value: null`** is a figure nobody counted: an en dash in the figure, `valueNote` as its title, its screen-reader
  text and the sub line when there is no `sub`, and no delta pill. A footer pair takes `value: null` and `note` the same
  way. A zero is only ever a counted zero.
- **StatCard `delta`** may carry `tone` and `direction` when the sign does not say which way is good (a KPI's tone comes from
  its target). **`MenuPopover`** is the ⋯ button that opens a popover of words (Improve's "What is counted").
- **A card that is a link** puts the link on its title, stretched over the card, so a button inside (the three dots)
  never nests in an `<a>`. `href` makes an `<a>`; `as` takes a router link: `as={(p) => <Link to="/flow" {...p} />}`.
- **InfoHint** reads `src/lib/language.gen.ts`, generated from `docs/language.md` by `scripts/language.ts`.
- **StatCard** takes `hint` (after its title) and a `hint` on a footer pair.
- **IssueCard** is a StatCard-shaped card: the shell holds the header (`KindIcon`, project chip, the `number` as `#657` in
  mono, the origin word, which Flow passes only when it is not You, the Lozenge) and the footer (reason, age in mono); the title sits alone in the inset body, 13 px
  clamped to 3 lines. It takes `compact` (the Chain's node: 2-line title, 1-line reason, for a fixed shorter card), `number` (none for a plan row), `since: null` for a card with no age (a plan row: none shown), `stateLabel` for the
  Lozenge's words, `reasonIcon` and `reasonTitle` where the reason line's icon or hover text is not the state's, and
  `projectAs`, a router link that turns the project chip into a link above the stretched card link.
- **SinceRow** is a button that opens a Base UI popover to its side (`side`: `right`, or `bottom` on a phone) on hover, on
  keyboard focus (Escape closes it and the focus it gets back does not reopen it) and on a tap. Its `children` are the
  popover's links; it takes `outcome` (also the icon's accessible name), `happened`, `number` (none for a signal), and
  hides the project below a 20 rem row (a container query).
