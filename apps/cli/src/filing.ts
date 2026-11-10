import { FILING, PLAN_LIMITS } from '@software-factory/contract'
import type { OperationExtension } from './operation.ts'
import { issueListPlain, projectShowPlain } from './plain-forms.ts'

const POINTER = 'factory issue schema'

const WHERE = [
  'On the mini (the owner path): `factory issue new --repo <repo> --title <title> --facts @file [--after <id>] [--key <key>]`; with no token set the CLI resolves the owner token from the deployed release itself.',
  'List what is filed with `factory issue list [--repo <name>] [--state open|closed|all] --format plain` (one line per Issue); file a finding for another repo with `factory signal file --from agent:<repo> --title <title> --text <text>`.',
  'Elsewhere, or as a lead (which keeps its own agent token): FACTORY_TOKEN must be set, else the server answers 401.',
  'Several Issues that depend on each other, or that are filed over time: do not file them one by one. Write rows into the repo `docs/plan.yaml` (the server files each row as an Issue once its `after` rows are done).',
  'Format: `factory plan schema` (docs/plan.md); check before pushing: `factory plan check docs/plan.yaml`; read back after pushing: `factory project sync --fetch true`, then `factory project show <repo> --format plain`.',
]

const factsShape = `{${FILING.facts.keys.map((k) => `"${k.key}": "..."`).join(', ')}}`

/** `factory issue schema`, and the end of `factory issue new --help`: everything a first-time filer needs. */
export function filingGuide(): string {
  const keyWidth = Math.max(...FILING.facts.keys.map((k) => k.key.length))
  const flagWidth = Math.max(...FILING.flags.map((f) => f.flag.length))
  return [
    'Filing an Issue: factory issue new --repo <repo> --title <title> --facts @file',
    '',
    `facts is ${FILING.facts.shape}.`,
    'Recommended keys:',
    ...FILING.facts.keys.map((k) => `  ${k.key.padEnd(keyWidth)}  ${k.meaning}`),
    ...FILING.facts.notes,
    '',
    'Example facts:',
    JSON.stringify(FILING.facts.example, null, 2),
    '',
    `seat is ${FILING.seat.shape}.`,
    `  tier: ${FILING.seat.tiers.join(', ')}; effort: ${FILING.seat.efforts.join(', ')}`,
    ...FILING.seat.notes.map((line) => `  ${line}`),
    `  --seat '${JSON.stringify(FILING.seat.example)}'   --seat '${JSON.stringify(FILING.seat.roleExample)}'`,
    '',
    `lane is ${FILING.lane.shape}.`,
    ...FILING.lane.notes.map((line) => `  ${line}`),
    `  --lane ${FILING.lane.example}`,
    '',
    '--facts @file reads the file, - reads stdin; the file must be JSON, not markdown.',
    '',
    'Flags:',
    ...FILING.flags.map((f) => `  ${f.flag.padEnd(flagWidth)}  ${f.meaning}`),
    '',
    'When to use what:',
    ...WHERE.map((line) => `  ${line}`),
  ].join('\n')
}

/** The same contract for `--format json`. */
export const filingContract = () => ({ ...FILING, where: WHERE })

const factsHint = `facts is one JSON object: ${factsShape} (markdown is not JSON); print the full contract with: ${POINTER}`
const seatHint = `seat is one JSON object: {"tier": "opus", "effort": "high"} or {"role": "lead"}; print the full contract with: ${POINTER}`
const pointerHint = `the filing contract (facts keys, flags, example): ${POINTER}`

const planLimitsHelp = `docs/plan.yaml limits: at most ${PLAN_LIMITS.maxBytes / 1024} KiB, at most ${PLAN_LIMITS.maxAliases} YAML aliases, at most ${PLAN_LIMITS.maxAfter} "after" keys per row (a plan over any is broken; format in docs/plan.md)`

/** What a command says beyond its generated contract: help text, hints for a rejected field, hints per status. */
export const OPERATION_EXTENSIONS: Readonly<Record<string, OperationExtension>> = {
  'project.show': { help: planLimitsHelp, plain: projectShowPlain },
  'issue.list': { plain: issueListPlain },
  'issue.new': {
    help: filingGuide(),
    jsonObjectFields: { facts: factsHint, seat: seatHint },
    statusHints: {
      400: pointerHint,
      401: 'filing needs the owner token. On the mini the CLI resolves it from the deployed release through secrets-run when FACTORY_TOKEN and FACTORY_READ_TOKEN are unset (a read token files nothing); elsewhere set FACTORY_TOKEN',
      422: pointerHint,
    },
  },
}
