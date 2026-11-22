/**
 * The sign of a move-up, read back from its `why` (`moveUpWhy` in `apps/server/src/domains/leads/light.ts` writes it): the
 * light lead's words for the light step, `the lead`'s for the lead row's, with an optional `: detail` after. Null for any
 * other text, and for a move-up written before the signs were.
 */
export type MoveSign = 'outOfDepth' | 'regressed' | 'stalled' | 'refusedShips'

const SIGNS: readonly (readonly [RegExp, MoveSign])[] = [
  [/^the (?:light )?lead said the work is beyond its seat(?::|$)/, 'outOfDepth'],
  [/^the (?:light )?lead’s change regressed on its first watch(?::|$)/, 'regressed'],
  [/^the (?:light )?lead stalled \d+ times(?::|$)/, 'stalled'],
  [/^the (?:light )?lead’s ship was refused \d+ times(?::|$)/, 'refusedShips'],
]

/** The sign a move-up's `why` names, or null for any other text. */
export function moveSignOf(why: string): MoveSign | null {
  return SIGNS.find(([pattern]) => pattern.test(why))?.[1] ?? null
}
