import { FILING, PLAN_LIMITS, SPEC_BUILD_LINES, SPEC_VISIBLE_MAX } from '@software-factory/contract'
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
  'A signal filed with a wrong title or text: `factory issue withdraw <issue> --from agent:<repo> --reason <why>` takes back the Issue it made, while no lead has it (an Issue the owner or another source also reported, or one a lead started, is refused: 409). File the corrected signal afterwards.',
  'When the factory itself surprises you (a refusal --help did not predict, a hidden limit, an id format, a wrong state, a help text that misleads): report it once as a signal, `factory signal file --from agent:<your repo> --repo software-factory --title <what happened> --text <the command, the answer, what you expected>`. Triage merges duplicates into one Issue. Never file that Issue yourself with `factory issue new`, and never work around it silently.',
  'Elsewhere, FACTORY_TOKEN must be set, else the server answers 401.',
  'A lead (its session holds the agent token) cannot file an Issue: `factory issue new` answers 403 for it. It files a signal, `factory signal file --repo <repo> ...`, and triage makes the Issue. A work repo hears the owner only, so a signal there is dropped (`work_repo`), except the follow-up of a lead whose own Issue the owner filed: that signal is held for the owner to promote (Needs you).',
  'Something only for the owner to read and comment on, with no work for a lead (a report, a research page, a specification several Issues build from) is not an Issue: `factory artifact new --repo <repo> --title <title> --content @file [--content-format html] [--issue <id>]...` stores a Report no Issue owns (an HTML one starts from `apps/console/templates/artifact.html` in the factory repo and declares color-scheme); it shows on the Artifacts screen, takes his comments and revisions (`factory artifact revise <id> --content @file`) and links to the Issues it concerns (`factory artifact link <id> --issue <id>`). Never file an Issue and cancel it to carry one.',
  '`issue new` answers `{"issue": "issue_N", "id": "issue_N", "state", "filed"}` (and `seatCost`, one line, when a seat was filed): read `.id`. Other verbs answer `issue` as an object.',
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
const seatHint = `seat is one JSON object: {"role": "lead", "moveUp": true} or {"tier": "opus", "effort": "high", "why": "<one sentence>"} (a tier above the lead row's needs the why), or none at all; print the full contract with: ${POINTER}`
const pointerHint = `the filing contract (facts keys, flags, example): ${POINTER}`

const planLimitsHelp = `docs/plan.yaml limits: at most ${PLAN_LIMITS.maxBytes / 1024} KiB, at most ${PLAN_LIMITS.maxAliases} YAML aliases, at most ${PLAN_LIMITS.maxAfter} "after" keys per row (a plan over any is broken; format in docs/plan.md)`

const decisionHelp = [
  'A Decision is one question with its case, refused as a whole with every violation named at once; nothing is raised.',
  "  --class is why the choice is his, one of: direction (what a product does for its users where no direction is stated), look (a look he has not seen where real variants exist), own_surface (a new step or surface for him himself), spend (money, or a platform that locks in), security (who is trusted or let in), people (other people's or company data), irreversible (a change that cannot be undone), owner_fact (a fact only he holds). A choice in none of them is yours: take the default a revert undoes and write it under Decided in your Spec.",
  '  --why-yours is one line of at most 140 characters: why this is his and not yours.',
  '  --question is one sentence of at most 200 characters that ends in a question mark: he answers it in ten seconds. "Is this plan right?" is not a question.',
  '  --options is a JSON array of 2 to 4 objects {"label","leadsTo","cost","reversible"}: label at most 80, leadsTo what gets built if it is chosen (at most 160), cost what changing it later costs (at most 160), reversible true or false; every label different.',
  '  --recommendation is the label of one option (case ignored), not a sentence about it.',
  '  --checked is what you looked at before asking: at most three lines of 160 characters.',
  '  --no-answer is {"consequence","default","waitMinutes"}: the default is the label of a reversible option and needs waitMinutes (1 to 10080); with neither, nothing is taken without an answer.',
  '  --artifact is the Spec this question belongs to (its id): the card shows its Build and Decided under the question, and the Judge reads them.',
  '  --exhibit is one optional JSON object that shows the change where prose would narrate it; prose is not an exhibit. A look takes pictures, a flow or a structure a diagram, a trade-off a table, spend numbers:',
  '    {"kind":"before_after","today":[<1 to 3 lines>],"after":[<1 to 3 lines>]}  lines of at most 160 characters',
  '    {"kind":"pictures","pictures":[{"option":<label>,"image":<https link as written in the Spec>}]}  one per option, same viewport and crop; needs --artifact, and each link must be in the Spec\'s latest revision',
  '    {"kind":"diagram","caption":<one line>,"mermaid":<source>}  at most 12 nodes and 2000 characters; the figure `apps/console/scripts/diagram.ts` draws for an artifact',
  '    {"kind":"table","criteria":[<1 to 4, at most 40 characters each>],"rows":[{"option":<label>,"cells":[<one per criterion, at most 80 characters>]}]}  one row per option',
  '    {"kind":"numbers","figures":[{"label","value","unit"}]}  1 to 3 figures, each with its unit',
  '  --call <id> makes a repeated call one Decision.',
  "And only when the answer changes what you build. Architecture, names, an API or schema shape, a library, a layout the design guide covers are the lead's: write them under Decided in your Spec, never as a Decision. A person's chore (approve a pull request, rotate a key, click in a UI) is an Errand (`factory errand raise`), and a Decision whose recommendation or default is to keep waiting is refused with that pointer.",
  "The card he reads is the question, why it is his, the exhibit, and the options as buttons with what each leads to; what you checked, the Spec's Build and Decided and what waits behind the answer are closed under it. The Judge sees the same form, the Issue as filed and the Spec's head before he does, and it reaches him only if the Judge passes it on. Asking again on a question still open amends the open Decision. The answer comes back to you as a note.",
  "What in your Spec is the owner's is a Decision raised beside it, before or after you submit it. Raised after a Spec that waits for his verdict (an owner gate), it waits together with the review, and you hear the verdict and the answers in one note.",
  'A Decision that names a default and that you already went on with is settled by you, not waited out: `factory decision take-default <decision id>` closes it as the default taken and ends the wait, so `ship` is not refused for the time it would have run.',
  'The Judge may send your Decision back once, with a note: it is yours to decide, or not ready for the owner. Settle it with `take-default` (its default, or with none its reversible recommendation), or ask again with what was missing.',
].join('\n')

const errandHelp = [
  "An Errand is a person's hands (a device, a portal, a physical step) and nothing a token can do. --tried says what you ran first.",
  '--need secret|hands|place is required: secret is 1Password, a biometric, a password or a passphrase; hands is a device, a portal, a physical step or a look; place is a command that must run on his MacBook and holds no secret (give it with --cmd). Without it the raise is refused.',
  "The factory decides some Errands before they reach the owner, and says why. A command that runs wholly on the mini or over keyless ssh (an `ssh` to the mini or to a server such as the homelab or the vps) is refused: run it yourself (only a reboot, a core update, the deploy gate's release or a recursive delete stays his yes). A MacBook command that runs a mini-only CLI (`factory`, `secrets-run`) is refused too: run it yourself. A need he turned back in the last 3 days is refused with his note. A MacBook command that is exactly one of the fixed read-only reports (`mount | grep smbfs`, `ntfy-mac update --check`) or `git -C ~/SourceRoot/<repo> pull --ff-only` runs through the MacBook's gate with no dialog, and its output comes back to you as a note. A bot check on a page is not an Errand: report the page as blocked and go on with other sources.",
  "Never raise an Errand to approve or merge a pull request, or to bypass a review rule: it is turned back and the Issue waits on the review anyway. A pull request from the owner's own account cannot be approved by him; a review by someone else is waited on with `factory issue defer <id> --review <pull request>`.",
  'The host does these for you, so an Errand that asks for one is refused with the route:',
  '  a door token: `factory door token new <source>`; a door route into your own repo: `factory door route-set`; into another repo: `factory signal file --repo <that repo>`',
  '  an install (exiftool, ImageMagick): add a Makefile target of the repo that runs `brew install` and run it with `make -C <worktree> <target>`',
  "  a secret read: `secrets-run read op://...` or `secrets-run run --env-file=<tpl> -- <cmd>`, never `op` (it hangs on the mini); a sudo step (say in --tried what you looked for): a way without root first, else the owner's MacBook command (`--cmd`, `--host macbook`, `sudo -S` with the password piped in, never `ssh -t`); the mini's sudo password is MacBook-only, never read it",
  '  a Report that does not show in Needs you: a signal on software-factory',
  "A step on the owner's MacBook (a sudo prompt, a Touch ID, a `hc run`): `--cmd '<the command he runs>' --host macbook`. The factory pushes it to the MacBook as a dialog as soon as it reaches him, one at a time, and the answer closes the Errand. The dialog has no terminal: `ssh -t` and `sudo` without `-S` are refused (pipe the password into `sudo -S`). Never queue an `ask-human.sh` request beside an Errand: an Errand with no command beside your queued request is refused.",
  "The Errand's need is set from its shape, not from your wording: a command addressed to the mini (`ssh <the mini's alias> '...'`) or the deploy gate's release is an `approval` (Needs you shows an Approve button, the server runs it, no MacBook dialog); a secret word (1Password, a biometric, sudo) is a `secret`; another MacBook command with no secret is a `place` (shown to copy; a dialog only on his button); the rest is `hands`. An open Errand of the repo with the same command, the same check, the same one-line `summary` or the same `needKey` (your own short lowercase name for the need, e.g. `census-ua-contact`, a field of the `--body` JSON) as yours is joined: you wait on that one, he is paged once, and you hear the one answer. State a `needKey` when the same need may be worded differently by another Issue. A command that came back unsuccessful twice ends the Errand with a note: raise it again with a corrected command and a new `--call` id.",
  'Raise the Errand as the last step of a turn and end the turn: `ship`, `defer` and `close` are taken again after the note that it is done.',
  'The Errand\'s `--cmd` must be idempotent (look before create): the owner clicks Run, and a second click repeats it. A command that ran and exited 0 is never pushed again; if its check still says needed, the Errand is turned back to its lead with the check\'s output. The `--check` exits 0 only on positive evidence that the step is missing, never `! <cmd>`: that reads any error (a duplicate, a timeout, a missing tool) as "needed".',
  "An Errand with a `--check` closes itself when the check exits 1..125 (at the owner's return or every 6 hours); `factory errand check <id>` runs it now, and `factory issue show` lists `errands` with when it last ran and runs next.",
].join('\n')

const htmlHelp =
  'An HTML artifact (--content-format html) starts from apps/console/templates/artifact.html in the factory repo and declares color-scheme: the Console shows it in its own theme (light or dark, set as data-theme on <html>), keeps the text and every heading in one centred column, gives a picture wider than the column the pane and opens it in a lightbox on a click; one that declares no scheme gets a generic dark base. A diagram is a figure: write Mermaid and run `bun <factory repo>/apps/console/scripts/diagram.ts <file.mmd> --caption "..." [--width 960]`, which prints a `<figure>` themed by the tokens (Pele draws it); paste it into the page. The figure leaves the text column for the pane when it is wider than the column. The template lists the rules in its head.'

const refusedPicturesHelp =
  "`factory artifact submit` and `revise` refuse a Markdown picture from any other host, over http or with an expired presigned link, and an HTML artifact's `<img>` that is not a `data:` URL; the refusal names each one."

const imagesHelp =
  'Images: a Markdown artifact shows an https image only from a host the owner lists for the Console (his image bucket); any other host, such as raw.githubusercontent.com, shows its alt text. Put a shot there with `imgcli private <file> --json` (prints a presigned `url`, valid 7 days; it refuses .svg; a diagram is not an image to upload but a figure in an HTML artifact) and link that url as `![alt](url)`; an HTML artifact inlines it as a `data:` URL.'

const specHelp = [
  'A Spec is your plan, not a question. Write one before the code it governs when the Issue carries the checkpoint `spec` or `gate` (the ship is refused without one), and when the change is a new public surface (an API route, a CLI verb, a contract or schema others call or read), a new data model or a migration that changes meaning, a dependency of weight, or an architecture or look-and-feel choice later Issues build on. A choice that a look at the repo settles, or that the repo\'s own standards (AGENTS.md, its design guide, its lint and type rules) rank, is yours to take without a Spec or a Decision: the owner\'s standing instruction is "the best outcome and best design".',
  `It opens with a "## Build" section (what you will build, at most ${SPEC_BUILD_LINES} lines) and a "## Decided" section (each choice and why, a line each), and fits a page: its text outside <details> blocks, fenced code and images is at most ${SPEC_VISIBLE_MAX} characters (an HTML Spec: its visible text outside details). \`artifact submit\`, \`artifact revise\` and \`issue new --spec\` refuse a longer one, or one without the two sections, with the count and two ways out: move detail into a collapsed <details><summary>one line</summary>...</details> block (a diagram or a screenshot where it says it shorter), or file a document several Issues build from as a Report (\`factory artifact new\`) and link it. It states the smallest design that solves the stated problem first (an MVP whose learnings are kept) and names what it leaves out on purpose. It adds no new instance, tier, isolation layer, budget, guardrail, cap, fixed limit or slot count without a measured need it cites; the extras go in one line as later work, and a number it fixes is replaced by a rule that reads what is free now, or cites the measurement that sets it. Where it weighs keeping history, old runs, copies or a legacy path against dropping them, its default is to drop and keep only what a named KPI or use needs (users' data is another matter). When it proposes a mechanism of its own (an updater, a release feed, a pipeline, a docs framework), it first names what the field standard tools do, from research and not memory, and why they do not fit, measured where it can be.`,
  'It is written for a reader with no context, in plain prose with a short diagram or table where a structure helps (a diagram is an SVG figure in an HTML artifact, see below, never ASCII art in a fenced block); the investigation states what was checked, not only the conclusion.',
  "Submit it before you write the code it governs, and build at once: it does not wait and pages no one. The owner may comment on it at any time; a comment or a verdict reaches you as a note, and you apply it. What in it is the owner's is a Decision raised beside it (`factory issue ask --help`). Four Specs wait for his verdict: an owner gate's (no default: never build before it), a Spec its filer attached, your revision after his verdict of Changes, and a Replan that changes a plan row or cancels an Issue; the answer's `issue` shows the wait.",
].join(' ')

const submitHelp = [
  specHelp,
  'Limits: --title at most 200 characters, --content at most 1000000 characters. A Concept waits for its verdict (end the turn); a Spec does not wait unless it is one of the four above; a Report never waits.',
  imagesHelp,
  refusedPicturesHelp,
  htmlHelp,
].join(' ')

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
  'issue.ship': {
    help: "One --acceptance per acceptance line of the Issue, each starting `met: ` or `not met: `; over 500 characters is cut, and a refusal prints the line it wants. A `not met` with its why is allowed and honest; a ship stating nothing is counted as friction, like one without a /review at standard or deep (the factory never refuses a ship for a review). The factory finds what your branch, or an earlier attempt's, landed on the default branch: you type no commit. `--call` names this ship (`ship-<attempt>`, then `ship-<attempt>-2` after a regression): the same name twice is one ship.",
    notice: shipNotice,
  },
  'issue.defer': {
    help: "A deferral is for a short, named event, and it gives up your place until it ends; never defer to watch something over time. --review <pull request URL or #number> waits on someone else's review (a required review by a team or another person, work repos above all): the factory polls it every 15 minutes through `gh` or `glab` and wakes you when it is approved, gets changes requested or a new review comment, merges or closes; it shows as waiting on others, never in Needs you. A /review that agw answers `held` is deferred --until the reset time it prints.",
  },
  'decision.take-default': {
    help: 'Settles your own open Decision with the default it names, once you built on it: it closes as the default taken and ends the wait, so `ship` is not refused for the time it would have run.',
  },
  'artifact.annotation-reply': {
    help: "The owner's annotations are comments, often wider than the page: answer each one. A deferral's --note names the Issue or signal you filed for it, a decline's its reason. `factory issue ship` and `factory issue close --outcome done` are refused while one is unanswered.",
  },
  'issue.ask': { help: decisionHelp },
  'errand.raise': { help: errandHelp },
  'artifact.submit': { help: submitHelp },
  'artifact.new': { help: [imagesHelp, htmlHelp].join(' ') },
  'artifact.revise': {
    help: [
      "A verdict of `changes` is answered by a revision, not only by a push. A revision of your plan that answers no Changes does not wait; one that answers Changes (and a revision of a Concept, an owner gate's Spec or a filed Spec) opens a new verdict wait in which `ship`, `close` and `defer` are refused (409): ship or close what is already done before you revise, and if the revision is needed first, end the turn and ship from the verdict note.",
      'A Concept or Spec a lead submitted needs --attempt (your attempt number); a Spec filed with an Issue that no lead works yet (`issue new --spec`) is revised without one, and the screen then passes the new revision to the owner. A Report never needs it.',
      `A Spec revision is held to the Spec's form: Build and Decided, and at most ${SPEC_VISIBLE_MAX} characters of text outside <details> blocks, fenced code and images; a longer one is refused with the count and the two ways out (move detail into a details block, or file a Report and link it).`,
      imagesHelp,
      refusedPicturesHelp,
      htmlHelp,
    ].join(' '),
  },
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
