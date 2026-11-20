import {
  MAX_EVIDENCE_LINES,
  type Probe,
  type ProbeFinding,
  type ProbeRun,
} from '../../../domains/hygiene/hygiene-model.ts'

const MAX_LINE = 240

/** What one probe hands back: how it ended and what it found. */
export interface Outcome {
  outcome: ProbeRun['outcome']
  detail: string
  findings: ProbeFinding[]
  /** exact keys this run did not judge, or `*` for all of them: see `unjudging` */
  unjudged?: string[]
}

/**
 * Finding keys a run could not judge although it ended clean or found (a part of the probe failed, a tool was missing): the
 * lifecycle never heals them on this run's word.
 */
export const unjudging = (outcome: Outcome, keys: readonly string[]): Outcome =>
  keys.length ? { ...outcome, unjudged: [...keys] } : outcome

export const clean = (detail: string): Outcome => ({ outcome: 'clean', detail, findings: [] })
export const skipped = (detail: string): Outcome => ({ outcome: 'skipped', detail, findings: [] })
export const failed = (detail: string): Outcome => ({ outcome: 'failed', detail, findings: [] })
export const found = (detail: string, findings: ProbeFinding[]): Outcome => ({ outcome: 'found', detail, findings })

/** A single line of evidence: no line breaks, at most 240 characters. */
const oneLine = (text: string): string => {
  const flat = text.replace(/[\r\n\u2028\u2029]+/g, ' ').trim()
  return flat.length > MAX_LINE ? `${flat.slice(0, MAX_LINE - 1)}…` : flat
}

export function finding(probe: Probe, key: string, title: string, lines: string[], count: number): ProbeFinding {
  return { probe, key, title, lines: lines.slice(0, MAX_EVIDENCE_LINES).map(oneLine), count }
}
