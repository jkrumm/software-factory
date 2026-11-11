import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { send } from '@software-factory/client'
import { RetroModel } from '@software-factory/contract'
import { authHint, credentialOf } from './credentials.ts'
import { EXIT, FactoryError, kindForStatus, usage } from './exit.ts'
import { DEFAULT_URL, type Io } from './operation.ts'
import { type Format, plain, render } from './output.ts'
import { type TranscriptReport, transcriptPass } from './retro-transcripts.ts'

const USAGE = 'usage: retro [--days <1-90>] [--digests <dir>] [--no-transcripts] [--format json|plain]'

/** The transcript pass reads every lead transcript of the window: tens of MB each. The server's answer is quick. */
const READ_TIMEOUT_MS = 60_000

export interface RetroBundle extends RetroModel {
  transcripts:
    | (TranscriptReport & { read: boolean; withoutTranscript: number; digests: { issue: string; file: string }[] })
    | null
}

/** The Issues of every sample: the ones whose transcripts are worth a digest. */
export const sampledIssues = (samples: RetroModel['samples']): string[] => [
  ...new Set(Object.values(samples).flatMap((list) => list.map((sample) => sample.issue))),
]

/**
 * The server's retro model (the database half) plus the transcript pass (the files half) as one bundle. A session whose
 * hook reported no transcript is counted, never guessed at. No model is called: every figure is a count over the data.
 */
export function bundleOf(model: RetroModel, options: { transcripts: boolean; digestDir?: string }): RetroBundle {
  if (!options.transcripts) return { ...model, transcripts: null }
  const sessions = model.sessions.flatMap((s) =>
    s.transcriptPath === null ? [] : [{ ...s, transcriptPath: s.transcriptPath }],
  )
  const digestIssues = sampledIssues(model.samples)
  // a digest is appended per attempt, so a second run into the same directory would double it
  if (options.digestDir)
    for (const issue of digestIssues) rmSync(join(options.digestDir, `${issue}.txt`), { force: true })
  const report = transcriptPass(sessions, { digestDir: options.digestDir, digestIssues })
  const digests = options.digestDir
    ? digestIssues.flatMap((issue) => {
        const file = join(options.digestDir ?? '', `${issue}.txt`)
        return existsSync(file) ? [{ issue, file }] : []
      })
    : []
  return {
    ...model,
    transcripts: { ...report, read: true, withoutTranscript: model.sessions.length - sessions.length, digests },
  }
}

/** `factory retro [--days n] [--digests dir]`: everything the weekly retro reads, as one JSON document. */
export async function retroVerb(argv: readonly string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parseRetro>
  try {
    parsed = parseRetro(argv)
  } catch (error) {
    throw usage(`retro: ${error instanceof Error ? error.message : String(error)}`, USAGE)
  }
  const { values, positionals } = parsed
  if (values.help) {
    io.out(
      `${USAGE}\n\nThe weekly retro's bundle: GET /v1/retro (KPIs with history, friction, sessions, samples, the ledger of earlier retro signals) plus a pass over every lead transcript of the window (seconds by tool category, idle gaps, tool-error classes, make check runs). --digests <dir> writes one text digest per sampled Issue. --no-transcripts skips the pass. No model is called.\n`,
    )
    return EXIT.ok
  }
  if (positionals.length) throw usage(`retro takes no argument, got: ${positionals.join(' ')}`, USAGE)
  const format: Format = values.format === undefined ? 'json' : (values.format as Format)
  if (format !== 'json' && format !== 'plain') throw usage(`--format must be json or plain, got: ${values.format}`)
  const days = values.days === undefined ? 7 : Number(values.days)
  if (!Number.isInteger(days) || days < 1 || days > 90) throw usage('--days must be a whole number from 1 to 90', USAGE)

  const base = io.env.FACTORY_URL || DEFAULT_URL
  const credential = await credentialOf(io.env)
  const answer = await send({
    base,
    method: 'GET',
    path: '/v1/retro',
    query: { days: String(days) },
    token: credential.token,
    timeoutMs: READ_TIMEOUT_MS,
  })
  if (!answer.reached) {
    throw new FactoryError('network', `server unreachable at ${base}: ${answer.reason}`, {
      hint: 'is the server up? make verify checks the deployment',
    })
  }
  if (answer.status !== 200) {
    throw new FactoryError(kindForStatus(answer.status), `/v1/retro answered ${answer.status}`, {
      ...(answer.status === 401 ? { hint: authHint(credential.failure) } : {}),
      details: { status: answer.status },
    })
  }
  const model = RetroModel.safeParse(answer.json)
  if (!model.success) {
    throw new FactoryError(
      'contract_mismatch',
      `/v1/retro did not answer the shape this CLI expects: ${model.error.issues[0]?.message ?? 'unparseable body'}`,
      {
        hint: 'the server and the CLI are from different releases',
      },
    )
  }
  const bundle = bundleOf(model.data, { transcripts: values['no-transcripts'] !== true, digestDir: values.digests })
  io.out(render(format, bundle, plain(bundle)))
  return EXIT.ok
}

function parseRetro(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: {
      days: { type: 'string' },
      digests: { type: 'string' },
      'no-transcripts': { type: 'boolean' },
      format: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  })
}
