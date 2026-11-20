/**
 * The signal budget of every loop that files work (friction, hygiene, selfwatch, throughput): one pass files at most this
 * many signals (hygiene: per project); what is left out is named in the pass record and taken by a later pass.
 */
export const MAX_SIGNALS_PER_PASS = 5
