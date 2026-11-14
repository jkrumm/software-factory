import { FILING, PLAN_LIMITS } from '@software-factory/contract'
import type { OperationExtension } from './operation.ts'
import {
  artifactListPlain,
  issueListPlain,
  projectPlanPlain,
  projectShowPlain,
  shipNotice,
  syncNotice,
} from './plain-forms.ts'

const POINTER = 'factory issue schema'

const WHERE = [
  'On the mini (the owner path): `factory issue new --repo <repo> --title <title> --facts @file [--after <id>] [--key <key>]`; with no token set the CLI resolves the owner token from the deployed release itself.',
  'List what is filed with `factory issue list [--repo <name>] [--state open|closed|all] --format plain` (one line per Issue); file a finding for another repo with `factory signal file --from agent:<your repo> --repo <that repo> --title <title> --text <text>` (without --repo the finding goes to the repo named in --from).',
  'When the factory itself surprises you (a refusal --help did not predict, a hidden limit, an id format, a wrong state, a help text that misleads): report it once as a signal, `factory signal file --from agent:<your repo> --repo software-factory --title <what happened> --text <the command, the answer, what you expected>`. Triage merges duplicates into one Issue. Never file that Issue yourself with `factory issue new`, and never work around it silently.',
  'Elsewhere, FACTORY_TOKEN must be set, else the server answers 401.',
  'A lead (its session holds the agent token) cannot file an Issue: `factory issue new` answers 403 for it. It files a signal, `factory signal file --repo <repo> ...`, and triage makes the Issue. A work repo hears the owner only, so a signal there is dropped (`work_repo`), except the follow-up of a lead whose own Issue the owner filed: that signal is held for the owner to promote (Needs you).',
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
    `checkpoint is ${FILING.checkpoint.shape}.`,
    ...FILING.checkpoint.notes.map((line) => `  ${line}`),
    `  --checkpoint ${FILING.checkpoint.example}`,
    '',
    `spec is ${FILING.spec.shape}.`,
    ...FILING.spec.notes.map((line) => `  ${line}`),
    `  --spec ${FILING.spec.example}`,
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

const decisionHelp = [
  'A Decision is refused as a whole, every violation named at once, and nothing is raised.',
  '  --recommendation is the label of one option (case ignored), not a sentence about it',
  '  --options is a JSON array of 2 to 10 objects {"label","reversible","cost"}: every label different, reversible true or false',
  '  --no-answer is {"consequence","default","waitMinutes"}: the default is the label of a reversible option and needs waitMinutes (1 to 10080); with neither, nothing is taken without an answer',
  '  each text at most 4000 characters; --call <id> makes a repeated call one Decision',
].join('\n')

const errandHelp = [
  "An Errand is a person's hands (a device, a portal, a physical step) and nothing a token can do. --tried says what you ran first.",
  'The host does these for you, so an Errand that asks for one is refused with the route:',
  '  a door token: `factory door token new <source>`; a door route into your own repo: `factory door route-set`; into another repo: `factory signal file --repo <that repo>`',
  '  an install: a Makefile target of the repo (`brew install` through it)',
  "  a secret read: `secrets-run`; a sudo step: a way without root first, else the owner's MacBook command (`--cmd`, `--host macbook`); the mini's sudo password is MacBook-only, never read it",
  '  a Report that does not show in Needs you: a signal on software-factory',
  "A step on the owner's MacBook (a sudo prompt, a Touch ID, a `hc run`): `--cmd '<the command he runs>' --host macbook`. The factory pushes it to the MacBook as a dialog when he is back, one at a time, and the answer closes the Errand. Never queue an `ask-human.sh` request beside an Errand: an Errand with no command beside your queued request is refused.",
  "The Errand's need is set from its shape, not from your wording: a command addressed to the mini (`ssh <the mini's alias> '...'`) or the deploy gate's release is an `approval` (Needs you shows an Approve button, the server runs it, no MacBook dialog); a secret word (1Password, a biometric, sudo) is a `secret`; another MacBook command with no secret is a `place` (shown to copy; a dialog only on his button); the rest is `hands`. An open Errand with the same command or the same check as yours is joined: you wait on that one, and he is paged once. A command that came back unsuccessful twice ends the Errand with a note: raise it again with a corrected command and a new `--call` id.",
  'Raise the Errand as the last step of a turn and end the turn: `ship`, `defer` and `close` are taken again after the note that it is done.',
  "An Errand with a `--check` closes itself when the check exits 1..125 (at the owner's return or every 6 hours); `factory errand check <id>` runs it now, and `factory issue show` lists `errands` with when it last ran and runs next.",
].join('\n')

const submitHelp =
  'Limits: --title at most 200 characters, --content at most 1000000 characters. A Concept or Spec waits for its verdict (end the turn); a Report never waits.'

const signalKindHint =
  "a signal's kind is request, feedback or remark; bug, feature or chore is an Issue's kind, set by triage; to choose it yourself file the Issue: `factory issue new --kind bug|feature|chore`"

/** What a command says beyond its generated contract: help text, hints for a rejected field, hints per status. */
export const OPERATION_EXTENSIONS: Readonly<Record<string, OperationExtension>> = {
  'project.show': { help: planLimitsHelp, plain: projectShowPlain },
  'project.plan': { plain: projectPlanPlain },
  'project.sync': {
    help: "--fetch true asks every repo's remote for new commits first (the way to read a plan you just pushed); omitted or false, the default branch is read as last fetched. A fetching sync can take over 20 s. A project.yaml or docs/plan.yaml that does not parse is listed under `broken` on every sync until it is fixed, and named on stderr.",
    notice: syncNotice,
  },
  'issue.show': {
    help: "`edges.after` lists what the Issue waits on and `edges.before` the open Issues that wait on it: stored `after` edges (`via: edge`, what `factory issue replan` edits) and a lead's own dependency wait (`via: wait`). `factory read chain --format plain` shows the whole chain (`blocking.issue_<n>`). `errands` lists the Issue's Errands with `lastCheckedAt`, the check's `checkNote` and `nextCheckAt` (the desk pass runs the check then at the latest; `factory errand check <id>` runs it now).",
  },
  'errand.approve': {
    help: "The owner's yes on an `approval` Errand: an Errand whose command runs on the mini and asks only for his yes (the deploy gate's release of a colleague's commit is the example). The server runs the command itself, with its secrets left out, and records what it came to like a pushed run: exit 0 goes through his done, so the Errand's check decides whether it closes; a failure leaves it open, and the second failure ends it with a note that the command must be corrected. Answers at once (`started`); read the outcome on the Errand. Owner token only: an agent's or the orchestrator's token is refused. Needs you shows the same command with an Approve button.",
  },
  'errand.check': {
    help: "Runs the Errand's own check now (the shell command given to `errand raise --check`) instead of waiting for the desk pass. Exit 1..125 closes the Errand and ends the Issue's wait (you hear it as a note); exit 0 keeps it (`outcome: needed`); a check that could not run says why (`unrunnable`), and one whose command was not found is `broken` (its exit says nothing; the owner's done still closes the Errand). An Errand with no check answers `no_check`; one closed already answers `already_closed`.",
  },
  'issue.list': { plain: issueListPlain },
  'artifact.list': {
    help: 'Narrow it with --kind concept|spec|decision|report and --issue <id>; --format plain prints one line per artifact (id, issue, kind, date, title).',
    plain: artifactListPlain,
  },
  'issue.ship': { notice: shipNotice },
  'issue.ask': { help: decisionHelp },
  'errand.raise': { help: errandHelp },
  'artifact.submit': { help: submitHelp },
  'signal.file': { fieldHints: { kind: signalKindHint } },
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
