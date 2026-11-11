import {
  AlarmIcon,
  ArrowCounterClockwiseIcon,
  CheckCircleIcon,
  CircleIcon,
  FilePlusIcon,
  FlagCheckeredIcon,
  GavelIcon,
  HandIcon,
  HourglassIcon,
  type Icon,
  NoteIcon,
  PlayIcon,
  QuestionIcon,
  RocketIcon,
  SealIcon,
  SkullIcon,
  StopIcon,
  WrenchIcon,
  EyeIcon,
  ChatCircleIcon,
  PaperPlaneTiltIcon,
  SlidersIcon,
} from '@phosphor-icons/react'
import type { ReadIssueDetail } from '@software-factory/contract'
import { EmptyState } from '@/components/kit/empty-state'
import { Section } from '@/components/kit/section'
import { StepRail } from '@/components/kit/step-rail'
import { activityGroups } from '@/lib/issue-page'
import { spanWords } from '@/lib/needs'

/** The icon of each event kind (`domains/work/events.ts`); a kind not listed is a circle. */
const KIND_ICON: Record<string, Icon> = {
  filed: FilePlusIcon,
  settled: GavelIcon,
  admitted: PlayIcon,
  lead_started: PlayIcon,
  lead_gone: SkullIcon,
  seated: SlidersIcon,
  noted: NoteIcon,
  asked: QuestionIcon,
  answered: ChatCircleIcon,
  submitted: PaperPlaneTiltIcon,
  verdict_given: SealIcon,
  errand_raised: HandIcon,
  errand_done: CheckCircleIcon,
  deferred: HourglassIcon,
  stalled: StopIcon,
  woken: AlarmIcon,
  shipped: RocketIcon,
  watch_passed: EyeIcon,
  regressed: ArrowCounterClockwiseIcon,
  reopened: WrenchIcon,
  cancelled: StopIcon,
  closed: FlagCheckeredIcon,
}

export function Activity({ issue, now, narrow }: { issue: ReadIssueDetail; now: number; narrow?: boolean }) {
  if (issue.timeline.length === 0) return <EmptyState title="Nothing has happened to this Issue yet." />
  const groups = activityGroups({
    timeline: issue.timeline,
    sessions: issue.sessions,
    now,
    closed: issue.state === 'closed',
  })
  const first = Date.parse(issue.timeline[0]?.at ?? '')
  const last = Date.parse(issue.timeline.at(-1)?.at ?? '')
  const count = issue.timeline.length
  return (
    <div className="flex flex-col gap-8">
      <p className="text-[length:var(--vx-text-sm)] text-muted-foreground">
        <span className="tabular-nums">{count}</span> {count === 1 ? 'event' : 'events'} over{' '}
        <span className="tabular-nums">{spanWords(Math.max(0, last - first))}</span>
      </p>
      {groups.map((group) => (
        <Section key={group.key} title={group.title} level={3}>
          <StepRail
            wrap={narrow}
            steps={group.steps.map(({ kind, ...step }) => ({
              ...step,
              icon: step.failed ? undefined : (KIND_ICON[kind] ?? CircleIcon),
            }))}
          />
        </Section>
      ))}
    </div>
  )
}
