import { FILING, PLAN_LIMITS } from '@software-factory/contract'
import type { OperationExtension } from './operation.ts'

const POINTER = 'factory issue schema'

const WHERE = [
  'On the mini (the owner path): `rd issue <repo> <title> --facts @file [--after <id>] [--key <key>]`; rd carries the token.',
  'rd has no --text flag: put prose into facts.what and facts.why.',
  'A direct `factory issue new` needs FACTORY_TOKEN (the owner token); without it the server answers 401.',
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
const pointerHint = `the filing contract (facts keys, flags, example): ${POINTER}`

const planLimitsHelp = `docs/plan.yaml limits: at most ${PLAN_LIMITS.maxBytes / 1024} KiB, at most ${PLAN_LIMITS.maxAliases} YAML aliases (a plan over either is broken; format in docs/plan.md)`

/** What a command says beyond its generated contract: help text, hints for a rejected field, hints per status. */
export const OPERATION_EXTENSIONS: Readonly<Record<string, OperationExtension>> = {
  'project.show': { help: planLimitsHelp },
  'issue.new': {
    help: filingGuide(),
    jsonObjectFields: { facts: factsHint },
    statusHints: {
      400: pointerHint,
      401: 'a direct factory call needs FACTORY_TOKEN (the owner token; FACTORY_READ_TOKEN reads only). On the mini file with: rd issue <repo> <title> --facts @file — rd carries the token',
      422: pointerHint,
    },
  },
}
