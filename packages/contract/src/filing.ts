import { NEW_ISSUE_TEXT_MAX } from './issues.ts'
import { SPEC_BUILD_LINES, SPEC_VISIBLE_MAX } from './checkpoints.ts'
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
      'optional, and omitted is the default: file no seat. One JSON object, one of two forms, {"tier", "effort"} or {"role"}, either with "moveUp": true and "why": "<one sentence>". Omitted, the lead starts on the role table\'s light row when the light rule names the Issue (a hygiene finding, kind docs, an unrouted monitor alert, or triage\'s size small with no design checkpoint and none of the words that keep it off), else on the lead row',
    tiers: TIERS,
    efforts: EFFORTS,
    notes: [
      'Never a model id: the tier is a word, the launcher maps it to a model.',
      'Three choices, in this order. 1. No seat (the default): the light rule decides at the lead\'s start, and `factory issue show` reports it before then (leadSeat, planned, with the rule\'s name). 2. In doubt whether the lead row is enough: `{"role": "lead", "moveUp": true}` starts on the lead row, and if its lead struggles (a second stall, a second refused ship, a regression of its first watch, or `issue block --out-of-depth`) a new lead takes over on the `strong` row (opus, high) from the first lead\'s handover. 3. Work that needs the strongest lead from the first minute (novel hard logic, a design that must hold): `{"tier": "opus", "effort": "high", "why": "<one sentence>"}`; a tier above the lead row\'s is refused (422, seat.why) without the why, and the refusal names choice 2. Opus costs several times the lead row per Issue: the answer of `issue new` and `issue seat` carries one line (`seatCost`) with what Issues on that tier cost over the last 7 days beside the lead row\'s.',
      'Any other filed seat always wins and is never moved up. `{"role": "light", "moveUp": true}` starts light, and a lead that struggles there is moved up to the lead row as the light rule\'s seat is; a light step ends on the lead row and takes no second step.',
      'A role is looked up in the role table when the Issue is filed and the result is kept; an unknown role is refused (422, seat.role).',
      'Not both forms at once; `moveUp` and `why` are the keys either form may add, any other key is refused by name. `why` is one line of at most 300 characters.',
    ],
    example: { tier: 'opus', effort: 'high', why: 'a schema the next Issues build on' } as const,
    roleExample: { role: 'lead', moveUp: true } as const,
  },
  lane: {
    shape:
      "optional; a resource inside the repo, a lowercase word like `apple`; the repo's `project.yaml` `lanes: {apple: 1}` caps how many leads of that lane run at once",
    notes: [
      'A lane the repo does not declare is unlimited within `leads`; an Issue in a full lane stays queued and the queue order names the lane and the Issue holding it.',
      'Use it when work inside one repo is not equally heavy (Apple builds next to cheap server rows); never as a fake `after` edge.',
    ],
    example: 'apple',
  },
  checkpoint: {
    shape:
      "optional; `spec` makes the lead write its plan as a Spec before it builds, and the ship is refused without one; nobody waits on it. `gate` is an owner gate, the one way a filer makes the owner read: the same Spec, and only the owner's own verdict ends the wait",
    notes: [
      "Set `spec` for a new public surface (an API, a CLI verb, a contract), a new data model or a migration that changes meaning, or a new dependency of weight, and only for work of a session or more. Never for an hour's change (a constant, a limit, a config line) or a change inside an existing surface: its lead decides those.",
      "The lead's Spec is its plan: it opens with Build and Decided, the lead submits it and builds at once, and it reaches no one's Needs you. The owner may comment on it at any time, and the comment reaches the lead as a note. What in it is the owner's (product direction, an unseen look with real variants, spend, security policy, other people's data, a change that cannot be undone) the lead raises beside it as a Decision.",
      "It is not Spec material, so never set it for these: research and then build (the lead researches, then builds, with no page between); a name, a file path, a subpath or an export layout; a direction the owner already stated (quote him in the facts, and the lead builds on it); a choice the repo's own standards rank.",
      '`gate` is for an Issue whose rows must not start until the owner has said so (a product gate): no default is taken, no rule settles it, and every Issue `after` it waits for his own verdict. It costs a waiting lead and a held chain for as long as he takes: never use it for a choice the lead can make.',
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
      `A Spec fits a page: it opens with a "## Build" section (what will be built, at most ${SPEC_BUILD_LINES} lines) and a "## Decided" section (each choice and why, a line each), and its text outside <details> blocks, fenced code and images is at most ${SPEC_VISIBLE_MAX} characters. \`issue new --spec\` refuses (422) a longer one, or one without the two sections, with the count and two ways out: move detail into a collapsed <details><summary>one line</summary>...</details> block, or file a document several Issues build from as a Report (\`factory artifact new\`) and link it.`,
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
    { flag: '--lane', meaning: "optional resource, capped by the repo's `lanes:` in project.yaml (`apple`)" },
    {
      flag: '--checkpoint',
      meaning:
        "optional: `spec` makes the lead submit its plan as a Spec before it builds, and nobody waits on it; `gate` the same, and the Issue waits for the owner's own verdict with no default",
    },
    {
      flag: '--spec',
      meaning: `optional Spec you wrote, markdown (\`@file\` reads a file): Build and Decided, at most ${SPEC_VISIBLE_MAX} characters outside <details> blocks, code fences and images (refused with the count otherwise); stored with the Issue, which the queue holds until the owner gives a verdict (24 hours at most); implies \`--checkpoint spec\``,
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
