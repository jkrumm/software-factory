import { createFileRoute, Link } from '@tanstack/react-router'
import {
  CheckCircleIcon,
  HourglassIcon,
  ProhibitIcon,
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
  KindIcon,
  LOZENGE_STATES,
  Lozenge,
  Meter,
  PropertyList,
  Section,
  SinceRow,
  Skeleton,
  Sparkline,
  StackedBars,
  StatCard,
  StepRail,
} from '@/components/kit'
import { Button } from '@/components/ui/button'
import {
  KIT_FIX_BARS,
  KIT_FIX_SERIES,
  KIT_ISSUES,
  KIT_KPI_HISTORY,
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
    number: i.number,
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

      <Section title="Stacked bars and the gap line">
        <Note>
          Improve's charts. The line breaks at a window with nothing counted instead of dropping to zero, and a target
          range is two dashed lines with a faint band. The stacked bars hold one segment per class in a fixed order,
          each class always the same colour, with the legend and totals beside them.
        </Note>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(22rem,1fr))] gap-4">
          <StatCard
            icon={WarningCircleIcon}
            title="Avoidable touches"
            subtitle="Last 7 days against the 7 before"
            value="0.06"
            delta={{ value: '-0.03', direction: -1, tone: 'good' }}
            sub="Met: 0.05 to 0.07"
            chart={
              <Sparkline
                values={KIT_KPI_HISTORY}
                target={{ min: 0.05, max: 0.07 }}
                tone="good"
                name="Avoidable touches"
                format={(v) => v.toFixed(2)}
              />
            }
            xLabels={['Oct 1', '7-day windows', 'Nov 9']}
            footer={[
              { label: 'Target', value: '0.05 to 0.07' },
              { label: 'Counted', value: '9 Issues' },
            ]}
          />
          <StatCard
            icon={WarningCircleIcon}
            title="Fix commits per week"
            subtitle="This week against the one before"
            value={4}
            delta={{ value: '-1', direction: -1, tone: 'good' }}
            sub="Falling is the target"
            chart={
              <StackedBars series={KIT_FIX_SERIES} bars={KIT_FIX_BARS} unit="fix commits" name="Fix commits per week" />
            }
            footer={[
              { label: 'Total', value: '23' },
              { label: 'Busiest', value: 'logic' },
            ]}
          />
          <StatCard
            icon={WarningCircleIcon}
            title="Tokens out"
            subtitle="This attempt"
            value={null}
            valueNote="The factory has not counted tokens for this Issue yet."
            chart={null}
            footer={[
              { label: 'Tokens in', value: null, note: 'The factory has not counted tokens for this Issue yet.' },
              { label: 'Cache write', value: null, note: 'The factory has not counted tokens for this Issue yet.' },
            ]}
          />
        </div>
      </Section>

      <Section title="Issue cards and rows">
        <Note>
          The whole card is the link: hover it, tab to it, press the three dots that show on hover (they swap with the
          Lozenge). It is built like a StatCard: the header holds the kind as an icon (its name is the tooltip), the
          project, the Issue number and the origin word; the title sits alone in the inset body, 13 px and clamped to
          three lines; the footer holds the reason and the age. A card in a column that names the state (the working
          ones here) leaves the Lozenge out. After them come a long title, a plan row (no number, no age) and a compact
          card (the Chain's node: two-line title, one-line reason). The origin word is shown only where it is not You.
          The row is the dense variant for lists, hairlines between rows and no box.
        </Note>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-3">
          {KIT_ISSUES.map((i) => (
            <IssueCard
              key={i.key}
              {...view(i)}
              origin={KIT_ORIGIN[i.key]}
              showState={i.state !== 'working'}
              className={i.number === null ? 'border border-dashed border-muted-foreground/50' : undefined}
              as={i.key === 'export-time' ? (p) => <Link to="/flow" {...p} /> : undefined}
              href={i.key === 'export-time' ? undefined : `#${i.key}`}
              onMenu={() => undefined}
            />
          ))}
          <IssueCard
            project="argo"
            kind="bug"
            number={642}
            state="waiting"
            since={KIT_ISSUES[1]?.since ?? null}
            now={KIT_NOW}
            title="Compact: a title that runs to a second line to show where the clamp falls and what it cuts off"
            reason="Waiting for the answer to a Decision: which session store to keep, and why the old one goes"
            compact
            raised
            href="#compact"
          />
        </div>
        <div className="mt-8 flex w-full flex-col">
          {KIT_ISSUES.flatMap((i) =>
            i.since === null
              ? []
              : [<IssueRow key={i.key} {...view(i)} since={i.since} href={`#${i.key}`} onMenu={() => undefined} />],
          )}
          <div aria-hidden="true" className="flex min-h-9 items-center gap-3 border-t px-3 py-1.5">
            <Skeleton height={16} width={16} rounded="rounded-sm" className="shrink-0" />
            <Skeleton height={12} width={32} className="shrink-0" />
            <Skeleton height={14} width="30%" />
            <Skeleton height={14} width="10%" className="ml-auto" />
            <Skeleton height={14} width={64} className="shrink-0" />
          </div>
        </div>
      </Section>

      <Section title="SinceRow">
        <Note>
          One thing that happened, as a compact line with no box: an icon for what happened, the number, the title
          clamped to one line, the project and the age. Hover it or reach it with the keyboard and a popover opens to
          its side with the full title, what happened, the outcome and the links; a tap opens it on a touch screen.
        </Note>
        <div className="grid max-w-md">
          <SinceRow
            icon={RocketLaunchIcon}
            tone="good"
            outcome="Shipped and verified"
            happened="It was deployed and the watch after the deploy passed."
            title="Show the retention banner on the dashboard for accounts that cancelled in the last thirty days"
            number="24"
            project="orion"
            at={new Date(KIT_NOW - 125 * 60_000).toISOString()}
            now={KIT_NOW}
          >
            <a href="#since" className="text-[length:var(--vx-text-sm)] underline underline-offset-4">
              Open the Issue
            </a>
          </SinceRow>
          <SinceRow
            icon={ProhibitIcon}
            tone="neutral"
            outcome="Dropped"
            happened="Its lead gave it up, with a reason; nothing shipped."
            title="Drop the legacy importer"
            number="27"
            project="orion"
            at={new Date(KIT_NOW - 40 * 60_000).toISOString()}
            now={KIT_NOW}
          />
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
          <Note>
            The Issue's kind as an outline badge with its icon. KindIcon: the same icon alone, its name as a tooltip.
          </Note>
          <div className="flex flex-wrap gap-2">
            {ISSUE_KINDS.map((kind) => (
              <KindBadge key={kind} kind={kind} />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {ISSUE_KINDS.map((kind) => (
              <KindIcon key={kind} kind={kind} />
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
          <Note>Graphite below 75 %, warn from 75 %, bad from 90 %. Hover or focus a bar for its value.</Note>
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
