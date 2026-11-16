import type { ProjectHygieneModel, ProjectPageModel } from '@software-factory/contract'
import { Fold, InfoHint, Lozenge, PropertyList, Section } from '@/components/kit'
import { Ago } from '@/components/issue/ago'
import {
  FINDING_TONES,
  FINDING_WHY,
  FINDING_WORDS,
  laneWords,
  PASS_TONES,
  PASS_WORDS,
  PROBE_TONES,
  PROBE_WORDS,
} from '@/lib/project'
import { cn } from '@/lib/utils'
import { Mono, None, NUM, Table, TD, TH } from './parts'

/** How the project is set up, from its `project.yaml`: leads, lanes, checks and the deploy with its probes. */
export function SetupSection({
  setup,
  source,
}: {
  setup: ProjectPageModel['setup']
  source: ProjectPageModel['source']
}) {
  const lanes = laneWords(setup.lanes)
  const { deploy } = setup
  return (
    <Section title="Setup" aside={source === 'file' ? 'project.yaml' : 'No project.yaml: the defaults'}>
      <PropertyList
        className="min-[40rem]:grid-cols-2 xl:grid-cols-3"
        items={[
          { label: 'Leads at once', value: setup.leads },
          {
            label: (
              <span className="inline-flex items-center gap-1">
                Lanes <InfoHint word="lane" />
              </span>
            ),
            value: lanes.length === 0 ? null : lanes.join('; '),
          },
          { label: 'Test slot run limit', value: setup.slotRun ?? 'Default' },
          {
            label: 'Checks',
            value: setup.checks ? (
              <span>
                <Mono>{setup.checks.fast}</Mono> locally, <Mono>{setup.checks.full}</Mono>
                {setup.checks.ci ? ' in CI' : ''}
              </span>
            ) : (
              <Mono>make check</Mono>
            ),
          },
          { label: 'Doctor', value: setup.doctor ? <Mono>{setup.doctor}</Mono> : null },
          { label: 'Alert sources', value: setup.signals.length === 0 ? null : setup.signals.join(', ') },
          { label: 'Deploy', value: deploy.mode },
          { label: 'Watch after a ship', value: deploy.hold },
          {
            label: 'Verified by',
            value:
              deploy.targets.length === 0 ? null : (
                <ul className="grid gap-0.5">
                  {deploy.targets.map((target) => (
                    <li key={target.name}>
                      {target.name}: <Mono>{target.verify}</Mono>
                    </li>
                  ))}
                </ul>
              ),
          },
          {
            label: 'HTTP probes',
            value:
              deploy.probes.length === 0 ? null : (
                <ul className="grid gap-0.5">
                  {deploy.probes.map((probe) => (
                    <li key={probe.name}>
                      {probe.name}: <Mono>{probe.http}</Mono> expects {probe.expect}
                    </li>
                  ))}
                </ul>
              ),
          },
        ]}
      />
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
