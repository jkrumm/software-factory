/**
 * Commands of the old CLI that have no counterpart: asked for, they answer with the way to get the same thing instead of
 * "unknown command". The key is the first words of the command; the longest key that matches wins.
 */
const SPAWN =
  'a lead starts when the factory admits its Issue (see factory capacity get, factory queue get); put work in with factory signal file or factory issue new'

const RETIRED: Readonly<Record<string, string>> = {
  'spawn list': SPAWN,
  'spawn create': SPAWN,
  'spawn get': SPAWN,
  'spawn cancel': SPAWN,
  'spawn requeue': SPAWN,
  fleet: 'factory read overview',
  status: 'factory read overview',
  'session list': 'factory read sessions',
  'session get': 'factory read session <id>',
  'session wait': 'a lead stops with factory issue defer|block|ask; background work is seen by the Stop hook',
  'issue phase': "the phase is derived from the Issue's state, see factory issue show <id>",
  'issue wait': 'factory issue defer',
  'issue drop': 'factory issue close --outcome dropped',
  'issue evidence': "evidence is the merged commits and the lead's review, ship with factory issue ship",
  'issue facts': 'factory read kpis',
  'issue stop': 'factory issue cancel',
  'issue resume': 'not rebuilt',
  'notify list': 'factory page list',
  'notify test': 'not rebuilt',
  'quota get': 'factory capacity get',
  'quota refresh': 'factory capacity refresh',
  'door unrouted': 'factory door routes',
  'door route set': 'factory door route-set',
  'door route rm': 'factory door route-remove',
  'door route list': 'factory door routes',
}

/** What replaces a retired command, or nothing when the words are not one. */
export function retiredHint(words: readonly string[]): string | undefined {
  for (let length = Math.min(words.length, 3); length > 0; length--) {
    const hint = RETIRED[words.slice(0, length).join(' ')]
    if (hint) return hint
  }
  return undefined
}
