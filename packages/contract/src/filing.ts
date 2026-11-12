import { NEW_ISSUE_TEXT_MAX } from './issues.ts'
import { SPEC_WAIT_HOURS } from './lane.ts'
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
  lane: {
    shape:
      "optional; a resource class inside the repo, a lowercase word like `apple`; the repo's `project.yaml` `lanes: {apple: 1}` caps how many leads of that lane run at once",
    notes: [
      'A lane the repo does not declare is unlimited within `leads`; an Issue in a full lane stays queued and the queue order names the lane and the Issue holding it.',
      'Use it when work inside one repo is not equally heavy (Apple builds next to cheap server rows); never as a fake `after` edge.',
    ],
    example: 'apple',
  },
  checkpoint: {
    shape:
      'optional; `spec` makes the lead hand over a one-page Spec before it builds, and the ship is refused without one',
    notes: [
      'Set it for a new public surface (an API, a CLI verb, a contract), a new data model or a migration that changes meaning, a new dependency of weight, or a UI screen the owner has not seen.',
      `The Spec has at most three open choices, each with the lead's default; with no verdict in ${SPEC_WAIT_HOURS} hours the lead goes on with its defaults, so the queue never waits on the owner.`,
    ],
    example: 'spec',
  },
  spec: {
    shape:
      'optional; a Spec you already wrote (markdown), handed over with the Issue: `--spec @docs/v2/spec.md`; it implies `--checkpoint spec`',
    notes: [
      'The Spec is stored with the Issue and shown to the owner as a Spec with a verdict; no lead copies it. The Issue is filed and settled as always, and the queue holds it (reason `spec`) until the Spec has a verdict.',
      `With no verdict in ${SPEC_WAIT_HOURS} hours the factory records a looks_good for you and the lead starts on the defaults the Spec names, so the queue never waits on the owner. The lead reads the verdict and builds; it does not submit another Spec.`,
      'The title is the first `# ` heading of the file, else the Issue title; `--spec-title` sets it. Keep the open choices (at most three, each with a default and what changing it later costs) in the file: that is what the owner answers.',
    ],
    example: '@docs/v2/spec.md',
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
    { flag: '--lane', meaning: "optional resource class, capped by the repo's `lanes:` in project.yaml (`apple`)" },
    { flag: '--checkpoint', meaning: 'optional gate: `spec` makes the lead submit a one-page Spec before it builds' },
    {
      flag: '--spec',
      meaning:
        'optional Spec you wrote, markdown (`@file` reads a file): stored with the Issue, which the queue holds until the owner gives a verdict (24 hours at most); implies `--checkpoint spec`',
    },
    {
      flag: '--spec-title',
      meaning: 'optional title of that Spec; default: its first `# ` heading, else the Issue title',
    },
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
