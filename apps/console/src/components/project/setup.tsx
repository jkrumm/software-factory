import type { ProjectHygieneModel, ProjectSetupField, ProjectSetupModel } from '@software-factory/contract'
import { useState } from 'react'
import { Fold, Lozenge, Section } from '@/components/kit'
import { Ago } from '@/components/issue/ago'
import {
  FINDING_TONES,
  FINDING_WHY,
  FINDING_WORDS,
  PASS_TONES,
  PASS_WORDS,
  PROBE_TONES,
  PROBE_WORDS,
} from '@/lib/project'
import { cn } from '@/lib/utils'
import { Mono, None, NUM, Table, TD, TH } from './parts'

const ALERT =
  'rounded-lg bg-[color-mix(in_srgb,var(--vx-bad-solid)_12%,transparent)] px-3 py-2 text-[length:var(--vx-text-sm)] text-[color:var(--vx-bad-text)]'

/** A key of the file: its path (the child keys indented), what the schema says it means, and the value in force. */
function FieldRow({ field, parent }: { field: ProjectSetupField; parent: boolean }) {
  const depth = field.path.split('.').length - 1
  const key = field.path.split('.').pop() ?? field.path
  const empty = field.value === ''
  return (
    <div
      role="row"
      className={cn(
        'grid gap-x-6 gap-y-1 px-4 py-2.5 not-first:border-t min-[40rem]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]',
        depth === 0 && 'bg-card',
      )}
    >
      <div role="rowheader" className="min-w-0" style={{ paddingLeft: `${depth * 1.25}rem` }}>
        <Mono className={cn(depth === 0 && 'font-semibold')}>{key}</Mono>
        <p className="text-[length:var(--vx-text-sm)] text-muted-foreground">{field.description}</p>
      </div>
      <div role="cell" className="min-w-0 text-[length:var(--vx-text-sm)]">
        {empty ? (
          !parent ? (
            <span className="text-muted-foreground">Not set</span>
          ) : null
        ) : (
          <pre className="font-mono text-xs wrap-anywhere whitespace-pre-wrap">{field.value}</pre>
        )}
        {!empty && field.isDefault ? <span className="text-xs text-muted-foreground">The default</span> : null}
      </div>
    </div>
  )
}

const SEGMENT =
  'inline-flex h-7 cursor-pointer items-center rounded-md px-2.5 text-[length:var(--vx-text-sm)] outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:bg-muted aria-pressed:font-medium'

/** The `project.yaml` in force as a form, each key with the meaning the schema gives it, and the file itself behind a toggle. */
export function SetupForm({ model }: { model: ProjectSetupModel }) {
  const [raw, setRaw] = useState(false)
  return (
    <Section
      title="project.yaml"
      aside={
        <span className="inline-flex gap-1" role="group" aria-label="View">
          <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)} className={SEGMENT}>
            Form
          </button>
          <button type="button" aria-pressed={raw} onClick={() => setRaw(true)} className={SEGMENT}>
            Raw file
          </button>
        </span>
      }
    >
      {model.projectError ? (
        <p role="alert" className={cn(ALERT, 'mb-4')}>
          The project.yaml on the default branch does not parse; this is the last valid one. {model.projectError}
        </p>
      ) : null}
      {model.source === 'defaults' ? (
        <p className="mb-4 text-[length:var(--vx-text-sm)] text-muted-foreground">
          This project has no project.yaml of its own: every key is its default.
        </p>
      ) : null}
      {raw ? (
        <pre
          aria-label="project.yaml, defaults filled in"
          className="overflow-x-auto rounded-xl bg-card p-4 font-mono text-xs"
          style={{ boxShadow: 'var(--vx-shadow-card)' }}
        >
          {model.yaml}
        </pre>
      ) : (
        <div
          role="table"
          aria-label="project.yaml keys"
          className="overflow-hidden rounded-xl bg-background"
          style={{ boxShadow: 'var(--vx-shadow-card)' }}
        >
          {model.fields.map((field) => (
            <FieldRow
              key={field.path}
              field={field}
              parent={model.fields.some((other) => other.path.startsWith(`${field.path}.`))}
            />
          ))}
        </div>
      )}
    </Section>
  )
}

/** The hygiene loop's view of the project: each probe with its last run, the newest pass and what it found. */
export function HygieneSection({ model, now }: { model: ProjectHygieneModel; now: number }) {
  const { lastPass } = model
  return (
    <Section
      title="Hygiene"
      hint="probe"
      aside={lastPass ? <Ago iso={lastPass.at} now={now} /> : 'Never swept'}
      className="min-w-0"
    >
      {lastPass ? (
        <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--vx-text-sm)] text-muted-foreground">
          <Lozenge tone={PASS_TONES[lastPass.judgment.outcome]}>{PASS_WORDS[lastPass.judgment.outcome]}</Lozenge>
          <span>
            Commit <Mono>{lastPass.ref.slice(0, 8) || 'none'}</Mono>
          </span>
          <span className="tabular-nums">
            {model.documents.stale} stale and {model.documents.slop} recently edited documents read
          </span>
          {lastPass.judgment.reason ? <span className="wrap-anywhere">{lastPass.judgment.reason}</span> : null}
        </p>
      ) : (
        <p className="mb-3 text-[length:var(--vx-text-sm)] text-muted-foreground">
          No pass has swept this project yet. The probes below run in its first pass.
        </p>
      )}
      <Table
        label="Probes"
        head={
          <>
            <th className={TH}>Probe</th>
            <th className={TH}>Last run</th>
            <th className={TH}>Detail</th>
            <th className={cn(TH, NUM)}>Findings</th>
          </>
        }
      >
        {model.probes.map((probe) => (
          <tr key={`${probe.declared ? 'declared' : 'built-in'}:${probe.name}`}>
            <td className={TD}>
              <Mono>{probe.name}</Mono>
              {probe.declared ? <span className="ml-2 text-xs text-muted-foreground">the project's own</span> : null}
            </td>
            <td className={TD}>
              <Lozenge tone={PROBE_TONES[probe.status]}>{PROBE_WORDS[probe.status]}</Lozenge>
            </td>
            <td className={cn(TD, 'text-muted-foreground wrap-anywhere')}>{probe.detail}</td>
            <td className={cn(TD, NUM)}>{probe.findings}</td>
          </tr>
        ))}
      </Table>
      <h3 className="mt-6 mb-2 text-sm font-medium text-muted-foreground">
        Findings of the newest pass <span className="tabular-nums">{model.findings.length}</span>
      </h3>
      {model.findings.length === 0 ? (
        <None>{lastPass ? 'The newest pass found nothing.' : 'Nothing found yet.'}</None>
      ) : (
        <Table
          label="Findings"
          head={
            <>
              <th className={TH}>Finding</th>
              <th className={TH}>Probe</th>
              <th className={TH}>How it ended</th>
            </>
          }
        >
          {model.findings.map((finding) => (
            <tr key={finding.key}>
              <td className={cn(TD, 'wrap-anywhere')}>
                {finding.title}
                {finding.count > 1 ? (
                  <span className="ml-2 text-xs text-muted-foreground tabular-nums">{finding.count} items</span>
                ) : null}
                <div>
                  <Mono className="text-muted-foreground">{finding.key}</Mono>
                </div>
              </td>
              <td className={TD}>
                <Mono>{finding.probe}</Mono>
              </td>
              <td className={TD} title={FINDING_WHY[finding.status]}>
                <Lozenge tone={FINDING_TONES[finding.status]}>{FINDING_WORDS[finding.status]}</Lozenge>
                {finding.reason ? <span className="ml-2 text-muted-foreground">{finding.reason}</span> : null}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {model.passes.length > 1 ? (
        <Fold title="Earlier passes" count={model.passes.length - 1} className="mt-4">
          <div className="pt-3">
            <Table
              label="Passes"
              head={
                <>
                  <th className={TH}>Swept</th>
                  <th className={TH}>Commit</th>
                  <th className={TH}>Judgment</th>
                  <th className={cn(TH, NUM)}>Findings</th>
                  <th className={cn(TH, NUM)}>Filed</th>
                </>
              }
            >
              {model.passes.slice(1).map((pass) => (
                <tr key={pass.id}>
                  <td className={TD}>
                    <Ago iso={pass.at} now={now} />
                  </td>
                  <td className={TD}>
                    <Mono>{pass.ref.slice(0, 8) || 'none'}</Mono>
                  </td>
                  <td className={TD}>
                    <Lozenge tone={PASS_TONES[pass.judgment.outcome]}>{PASS_WORDS[pass.judgment.outcome]}</Lozenge>
                  </td>
                  <td className={cn(TD, NUM)}>{pass.findings}</td>
                  <td className={cn(TD, NUM)}>{pass.filed}</td>
                </tr>
              ))}
            </Table>
          </div>
        </Fold>
      ) : null}
    </Section>
  )
}
