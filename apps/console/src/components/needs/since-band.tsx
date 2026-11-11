import type { SinceItem } from '@software-factory/contract'
import {
  ArrowCounterClockwiseIcon,
  FunnelIcon,
  type Icon,
  PlusCircleIcon,
  ProhibitIcon,
  RocketLaunchIcon,
  ScalesIcon,
  SirenIcon,
} from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { Fold, InfoHint, Section, SinceRow as SinceRowView, Skeleton } from '@/components/kit'
import { TONE_TEXT, TONE_TINT } from '@/components/kit/tone'
import { useMediaQuery } from '@/lib/media'
import { issueNumber } from '@/lib/needs'
import { useSince } from '@/lib/queries'
import { isQuiet, SINCE_HAPPENED, type SinceKey, type SinceRow, sinceRows, visitWords } from '@/lib/since'
import { cn } from '@/lib/utils'

/** The band's height depends on what happened, so its skeleton takes the height the band had on the last visit (and a typical one before the first). */
const HEIGHT_KEY = (wide: boolean) => `console-since-height-${wide ? 'wide' : 'compact'}`
const FALLBACK_HEIGHT = { wide: 310, compact: 392 }

function rememberedHeight(wide: boolean): number {
  const stored = Number(window.localStorage.getItem(HEIGHT_KEY(wide)))
  return stored >= 48 ? stored : wide ? FALLBACK_HEIGHT.wide : FALLBACK_HEIGHT.compact
}

const absolute = (iso: string): string => new Date(iso).toLocaleString()

/** What happened, as an icon, per category. */
const SINCE_ICON: Record<SinceKey, Icon> = {
  shipped: RocketLaunchIcon,
  failed: ArrowCounterClockwiseIcon,
  dropped: ProhibitIcon,
  judge: ScalesIcon,
  screen: FunnelIcon,
  filed: PlusCircleIcon,
  incidents: SirenIcon,
}

/** The categories whose Issue has verification evidence worth a link of its own. */
const HAS_EVIDENCE: ReadonlySet<SinceKey> = new Set(['shipped', 'failed'])

const POPOVER_LINK =
  'inline-flex items-center gap-1 rounded-sm text-[length:var(--vx-text-sm)] underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50'

/** One compact row per item; the popover beside it holds the full title, the facts and the links. */
function Items({ row, items, now }: { row: SinceRow; items: SinceItem[]; now: number }) {
  const wide = useMediaQuery('(min-width: 768px)')
  return (
    <ul className="grid">
      {items.map((item) => (
        <li key={`${item.issue ?? 'none'}-${item.at}-${item.title}`} className="min-w-0">
          <SinceRowView
            icon={SINCE_ICON[row.key]}
            tone={row.tone}
            outcome={row.label}
            happened={SINCE_HAPPENED[row.key]}
            title={item.title}
            number={item.issue ? issueNumber(item.issue) : null}
            project={item.repo}
            at={item.at}
            now={now}
            side={wide ? 'right' : 'bottom'}
          >
            {item.issue ? (
              <>
                <Link to="/issues/$id" params={{ id: issueNumber(item.issue) }} className={POPOVER_LINK}>
                  Open the Issue
                </Link>
                {HAS_EVIDENCE.has(row.key) ? (
                  <Link
                    to="/issues/$id"
                    params={{ id: issueNumber(item.issue) }}
                    search={{ tab: 'evidence' }}
                    className={POPOVER_LINK}
                  >
                    Verification evidence
                  </Link>
                ) : null}
              </>
            ) : null}
          </SinceRowView>
        </li>
      ))}
    </ul>
  )
}

/** The figure on top and the label beneath it, the InfoHint right after the label's text. */
function Figure({ row }: { row: SinceRow }) {
  const quiet = row.count === 0
  return (
    <>
      <span
        data-tone={quiet ? 'quiet' : row.tone}
        className={cn(
          'w-fit rounded-md px-1.5 text-2xl font-semibold tracking-tight tabular-nums',
          quiet ? 'text-muted-foreground' : [TONE_TINT[row.tone], TONE_TEXT[row.tone]],
        )}
      >
        {row.count}
      </span>
      <p className={cn('text-sm whitespace-nowrap', quiet && 'text-muted-foreground')}>
        {row.label}
        {row.hint ? <InfoHint word={row.hint} className="-my-1 ml-0.5 align-middle" /> : null}
      </p>
      {row.breakdown ? <p className="text-xs text-muted-foreground">{row.breakdown}</p> : null}
    </>
  )
}

function Category({ row, now }: { row: SinceRow; now: number }) {
  return (
    <div className="grid min-w-0 content-start gap-2" data-category={row.key}>
      <div className="grid gap-0.5">
        <Figure row={row} />
      </div>
      {row.shown.length > 0 ? <Items row={row} items={row.shown} now={now} /> : null}
      {row.folded.length > 0 ? (
        <Fold title={`${row.folded.length} more`}>
          <Items row={row} items={row.folded} now={now} />
        </Fold>
      ) : null}
      {row.more > 0 ? <p className="text-xs text-muted-foreground">and {row.more} more</p> : null}
    </div>
  )
}

/** The phone: figure and label per category in two columns, and every item in one Fold below, grouped by category. */
function CompactBand({ rows, now }: { rows: SinceRow[]; now: number }) {
  const listed = rows.filter((row) => row.shown.length + row.folded.length > 0)
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 [&>:last-child:nth-child(odd)]:col-span-2">
        {rows.map((row) => (
          <div key={row.key} className="grid min-w-0 content-start gap-0.5" data-category={row.key}>
            <Figure row={row} />
          </div>
        ))}
      </div>
      {listed.length > 0 ? (
        <Fold title="Show what changed">
          <div className="grid gap-5">
            {listed.map((row) => (
              <div key={row.key} className="grid gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">{row.label}</h3>
                <Items row={row} items={[...row.shown, ...row.folded]} now={now} />
                {row.more > 0 ? <p className="text-xs text-muted-foreground">and {row.more} more</p> : null}
              </div>
            ))}
          </div>
        </Fold>
      ) : null}
    </div>
  )
}

/**
 * What happened since the owner was last here. Reading it moves the server's visit marker, so only this screen mounts
 * it. While loading it holds the band's height; on an error it leaves the band out (the checkpoints are below).
 */
export function SinceBand({ now }: { now: number }) {
  const { data, isPending } = useSince()
  const wide = useMediaQuery('(min-width: 768px)')
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (body.current) window.localStorage.setItem(HEIGHT_KEY(wide), String(Math.round(body.current.offsetHeight)))
  }, [data, wide])
  if (isPending) {
    return (
      <Section title="Since you were here" className="mb-8">
        <Skeleton height={rememberedHeight(wide)} rounded="rounded-xl" />
      </Section>
    )
  }
  if (!data) return null
  const rows = sinceRows(data)
  const visit = (
    <time dateTime={data.since} title={absolute(data.since)}>
      {visitWords(data.since, now)}
    </time>
  )
  if (isQuiet(rows)) {
    return (
      <p className="mb-8 text-sm">
        Nothing changed since you were here <span className="text-muted-foreground">{visit}</span>
      </p>
    )
  }
  return (
    <Section title="Since you were here" aside={visit} className="mb-8">
      <div ref={body}>
        {wide ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] gap-x-6 gap-y-6">
            {rows.map((row) => (
              <Category key={row.key} row={row} now={now} />
            ))}
          </div>
        ) : (
          <CompactBand rows={rows} now={now} />
        )}
      </div>
    </Section>
  )
}
