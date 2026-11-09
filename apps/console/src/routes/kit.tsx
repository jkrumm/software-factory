import { createFileRoute, Link } from '@tanstack/react-router'
import {
  CheckCircleIcon,
  HourglassIcon,
  QueueIcon,
  RocketLaunchIcon,
  TrayIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import { useState } from 'react'
import {
  EmptyState,
  Fold,
  InfoHint,
  type InfoHintProps,
  IssueCard,
  IssueRow,
  ISSUE_KINDS,
  KindBadge,
  LOZENGE_STATES,
  Lozenge,
  Meter,
  PropertyList,
  Section,
  Skeleton,
  StatCard,
  StepRail,
} from '@/components/kit'
import { Button } from '@/components/ui/button'
import {
  KIT_ISSUES,
  KIT_ORIGIN,
  KIT_METERS,
  KIT_NOW,
  KIT_PROPERTIES,
  KIT_STATS,
  KIT_STEPS,
} from '@/components/kit/fixtures'

/** The component kit on fixtures: reachable by URL only (no nav entry, no palette command), no queries. */
export const Route = createFileRoute('/kit')({ component: Kit })

function Note({ children }: { children: string }) {
  return <p className="mb-4 max-w-prose text-[length:var(--vx-text-sm)] text-muted-foreground">{children}</p>
}

function Word({ word, children }: { word: InfoHintProps['word']; children: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[length:var(--vx-text-sm)]">
      {children}
      <InfoHint word={word} />
    </span>
  )
}

function Kit() {
  const [folded, setFolded] = useState(true)
  const view = (i: (typeof KIT_ISSUES)[number]) => ({
    title: i.title,
    project: i.project,
    kind: i.kind,
    state: i.state,
    reason: i.reason,
    since: i.since,
    now: KIT_NOW,
  })
  return (
    <div className="flex w-full flex-col gap-10 px-4 py-6 md:px-8 md:py-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Kit</h1>
        <p className="text-sm text-muted-foreground">
          The Console's components on fixtures, built on Basalt tokens only. Reachable by this address.
        </p>
      </header>

      <Section title="StatCard">
        <Note>
          A figure with its trend. The shell holds the header and the footer, the body is one surface step below, no
          border. The first card links to Flow; the dashed part of its line is the future, the dashed rule its target.
        </Note>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(22rem,1fr))] gap-4">
          <StatCard
            icon={RocketLaunchIcon}
            {...KIT_STATS.working}
            as={(p) => <Link to="/flow" {...p} />}
            onMenu={() => undefined}
          />
          <StatCard icon={HourglassIcon} {...KIT_STATS.waiting} onMenu={() => undefined} />
          <StatCard icon={QueueIcon} {...KIT_STATS.queued} onMenu={() => undefined} />
          <StatCard icon={CheckCircleIcon} {...KIT_STATS.shipped} onMenu={() => undefined} />
        </div>
      </Section>

      <Section title="Issue cards and rows">
        <Note>
          The whole card is the link: hover it, tab to it, press the three dots that show on hover. The kind is a badge
          in the chip row, the origin a muted word; a card in a column that names the state (the working ones here)
          leaves the Lozenge out. The row is the dense variant for lists, hairlines between rows and no box.
        </Note>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-3">
          {KIT_ISSUES.map((i) => (
            <IssueCard
              key={i.key}
              {...view(i)}
              origin={KIT_ORIGIN[i.key]}
              showState={i.state !== 'working'}
              as={i.key === 'export-time' ? (p) => <Link to="/flow" {...p} /> : undefined}
              href={i.key === 'export-time' ? undefined : `#${i.key}`}
              onMenu={() => undefined}
            />
          ))}
        </div>
        <div className="mt-8 flex w-full flex-col">
          {KIT_ISSUES.map((i) => (
            <IssueRow key={i.key} {...view(i)} href={`#${i.key}`} onMenu={() => undefined} />
          ))}
          <div aria-hidden="true" className="flex min-h-9 items-center gap-3 border-t px-3 py-1.5">
            <Skeleton height={16} width={16} rounded="rounded-sm" className="shrink-0" />
            <Skeleton height={14} width="30%" />
            <Skeleton height={14} width="10%" className="ml-auto" />
            <Skeleton height={14} width={64} className="shrink-0" />
          </div>
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-10 min-[1500px]:grid-cols-2">
        <Section title="Lozenge">
          <Note>
            A state as text on a 12 % tint of its tone. The tone comes from an explicit map, not from the word.
          </Note>
          <div className="flex flex-wrap gap-2">
            {LOZENGE_STATES.map((state) => (
              <Lozenge key={state} state={state} />
            ))}
          </div>
        </Section>

        <Section title="KindBadge">
          <Note>The Issue's kind as an outline badge with its icon.</Note>
          <div className="flex flex-wrap gap-2">
            {ISSUE_KINDS.map((kind) => (
              <KindBadge key={kind} kind={kind} />
            ))}
          </div>
        </Section>

        <Section title="PropertyList">
          <Note>A label above its value, three columns from 40 rem. A missing value reads None.</Note>
          <PropertyList items={KIT_PROPERTIES} />
        </Section>

        <Section title="InfoHint">
          <Note>
            A small icon beside a domain word. Its text is that word's definition, generated from docs/language.md.
          </Note>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Word word="Errand">Errand</Word>
            <Word word="Decision">Decision</Word>
            <Word word="Judge">Judge</Word>
            <Word word="Settling">Settling</Word>
            <Word word="Watching">Watching</Word>
          </div>
        </Section>

        <Section title="Section and Fold" hint="State" aside="aside slot">
          <Note>A section is a heading, a rule and space. A fold is a full-width header button with a count.</Note>
          <div className="flex flex-col gap-3">
            <Fold title="Checkpoints" count={3} defaultOpen>
              <p className="text-[length:var(--vx-text-sm)] text-muted-foreground">
                Open by default, uncontrolled. Two Decisions and one Errand.
              </p>
            </Fold>
            <Fold title="History" count={14} open={folded} onOpenChange={setFolded}>
              <p className="text-[length:var(--vx-text-sm)] text-muted-foreground">
                Controlled by the page: {folded ? 'open' : 'closed'}.
              </p>
            </Fold>
            <Fold title="Evidence" count={0}>
              <p className="text-[length:var(--vx-text-sm)] text-muted-foreground">Closed until pressed.</p>
            </Fold>
          </div>
        </Section>

        <Section title="StepRail">
          <Note>One row per step with a duration bar scaled to the longest. A failed step carries its line.</Note>
          <StepRail steps={KIT_STEPS} />
        </Section>

        <Section title="Meter">
          <Note>Accent below 70 %, warn from 70 %, bad from 90 %. Hover or focus a bar for its value.</Note>
          <div className="flex flex-col gap-1">
            {KIT_METERS.map((m) => (
              <Meter key={m.label} {...m} />
            ))}
          </div>
        </Section>

        <Section title="EmptyState and Skeleton">
          <Note>One sentence and an icon tile. A skeleton has the height of what replaces it.</Note>
          <EmptyState icon={TrayIcon} title="Nothing waits for you">
            New Decisions and Errands show up here.
          </EmptyState>
          <div className="mt-4 flex flex-col gap-2">
            <Skeleton height={20} width="60%" />
            <Skeleton height={14} />
            <Skeleton height={56} rounded="rounded-xl" />
          </div>
          <EmptyState
            className="mt-4"
            icon={WarningCircleIcon}
            title="Could not load Flow"
            action={
              <Button variant="outline" onClick={() => undefined}>
                Retry
              </Button>
            }
          >
            The server did not answer in time.
          </EmptyState>
        </Section>
      </div>
    </div>
  )
}
