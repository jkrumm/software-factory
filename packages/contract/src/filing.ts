import { NEW_ISSUE_TEXT_MAX } from './issues.ts'
import { EFFORTS, TIERS } from './roles.ts'

/**
 * The filing contract: what a caller of `issue new` puts in an Issue so its lead can build from it alone. The one copy
 * of the facts keys; the CLI prints it (`factory issue schema`, `issue new --help`) and a plan row's `facts` follow it.
 */
export const FACTS_KEYS = [
  { key: 'why', need: 'recommended', meaning: 'what motivates the change' },
  { key: 'what', need: 'recommended', meaning: 'the exact files or area in scope' },
  { key: 'change', need: 'recommended', meaning: 'what to build, with exact paths' },
  {
    key: 'acceptance',
    need: 'recommended',
    meaning: 'the checks that prove it, one verifiable statement; the lead ships stating each line met or not met',
  },
] as const

export const FACTS_EXAMPLE: Readonly<Record<(typeof FACTS_KEYS)[number]['key'], string>> = {
  why: 'The export button times out on large accounts, so support exports them by hand.',
  what: 'src/export/stream.ts and its test; nothing in the UI.',
  change: 'Write the export in pages of 500 rows in src/export/stream.ts instead of one query.',
  acceptance: 'Exporting a 100k-row fixture in test/export.test.ts finishes in under 5 s and make check passes.',
}

export const FILING = {
  facts: {
    shape:
      'one JSON object; the lead cannot see the filer session, so it carries the ask and why, exact paths, scope limits and research already verified',
    keys: FACTS_KEYS,
    example: FACTS_EXAMPLE,
    notes: [
      'Nothing enforces the four keys; they are the convention.',
      'Any other key is passed to the lead as `name: value`.',
    ],
  },
  seat: {
    shape:
      'optional; the tier and effort the Issue\'s lead starts on, one JSON object in one of two forms: {"tier", "effort"} or {"role"}; omitted, the lead starts on the role table\'s lead row',
    tiers: TIERS,
    efforts: EFFORTS,
    notes: [
      'Never a model id: the tier is a word, the launcher maps it to a model.',
      'A role is looked up in the role table when the Issue is filed and the result is kept; an unknown role is refused (422, seat.role).',
      'Not both forms at once; any other key is refused by name.',
    ],
    example: { tier: 'opus', effort: 'high' } as const,
    roleExample: { role: 'lead' } as const,
  },
  text: {
    maxChars: NEW_ISSUE_TEXT_MAX,
    meaning: 'optional prose shown to the lead before the facts',
  },
  flags: [
    { flag: '--repo', meaning: 'an absolute path in a source root, or a repo directory name' },
    { flag: '--title', meaning: 'the Issue title' },
    { flag: '--facts', meaning: 'the facts object as JSON; @file reads a file, - reads stdin' },
    { flag: '--seat', meaning: 'optional lead seat as JSON: {"tier":"opus","effort":"high"} or {"role":"lead"}' },
    { flag: '--text', meaning: `optional prose before the facts, up to ${NEW_ISSUE_TEXT_MAX} characters` },
    {
      flag: '--after',
      meaning:
        'an Issue id, repeatable; held until those Issues close (each must exist and be open). Stated edges are final: settling asks the model for none and adds none (and, with no triage call, does not refine the kind)',
    },
    {
      flag: '--alone',
      meaning:
        'the Issue waits for nothing, and says so: settling adds no edge (not with --after). Without --after or --alone the edges are unstated and settling may chain the Issue after open ones; file with --alone when later edges (an Issue after this one) are yours to add',
    },
    { flag: '--key', meaning: 'a stable key: a replay returns the stored Issue and ignores --after' },
    { flag: '--source', meaning: 'request (a person asking; the default) or alert (something broke)' },
  ],
} as const
