# Kit

The Console's components, each depending only on Basalt tokens (`--vx-*` through the bridge in `src/styles/index.css`),
`cn()`, Phosphor icons and Base UI or `components/ui/` primitives, so they can move to basalt-ui. One file per component;
`index.ts` is the barrel; `fixtures.ts` is the data `/kit` shows them on. The anatomy and the rules are `DESIGN.md`.

- **Tone** is chosen by the caller or by an explicit map (`LOZENGE_TONES`), never derived from a word. A tone paints a
  tint, an icon or a mark; text beside a chart stays in the text tokens.
- **Charts** (`Sparkline`, `MiniBars`, `Meter`) are hand-drawn SVG with no animation, a tooltip on hover and on keyboard
  focus (arrow keys, Home, End), and the numbers as an accessible name plus a visually hidden table. Their colours are the
  semantic tones (accent, good, warn, bad, the quiet line), not a categorical palette, so the `dataviz` skill's palette
  validator does not apply: each chart holds one series and carries no legend.
- **A card that is a link** puts the link on its title, stretched over the card, so a button inside (the three dots)
  never nests in an `<a>`. `href` makes an `<a>`; `as` takes a router link: `as={(p) => <Link to="/flow" {...p} />}`.
- **InfoHint** reads `src/lib/language.gen.ts`, generated from `docs/language.md` by `scripts/language.ts`.
