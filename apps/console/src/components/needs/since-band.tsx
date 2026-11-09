import type { SinceItem } from '@software-factory/contract'
import { Link } from '@tanstack/react-router'
import { Fold, InfoHint, Section, Skeleton } from '@/components/kit'
import { TONE_TEXT, TONE_TINT } from '@/components/kit/tone'
import { useMediaQuery } from '@/lib/media'
import { issueNumber } from '@/lib/needs'
import { useSince } from '@/lib/queries'
import { agoWords, isQuiet, type SinceRow, sinceRows, visitWords } from '@/lib/since'
import { cn } from '@/lib/utils'

const absolute = (iso: string): string => new Date(iso).toLocaleString()

function Items({ items, now }: { items: SinceItem[]; now: number }) {
  return (
    <ul className="grid gap-2">
      {items.map((item) => (
        <li key={`${item.issue ?? 'none'}-${item.at}-${item.title}`} className="grid min-w-0 gap-0.5">
          {item.issue ? (
            <Link
              to="/issues/$id"
              params={{ id: issueNumber(item.issue) }}
              className="line-clamp-2 rounded-sm text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {item.title}
            </Link>
          ) : (
            <span className="line-clamp-2 text-sm">{item.title}</span>
          )}
          <span className="flex min-w-0 gap-1 text-xs text-muted-foreground">
            {item.repo ? <span className="truncate">{item.repo} &middot;</span> : null}
            <time dateTime={item.at} title={absolute(item.at)} className="shrink-0 font-mono tabular-nums">
              {agoWords(now - Date.parse(item.at))}
            </time>
          </span>
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
      {row.shown.length > 0 ? <Items items={row.shown} now={now} /> : null}
      {row.folded.length > 0 ? (
        <Fold title={`${row.folded.length} more`}>
          <Items items={row.folded} now={now} />
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
                <Items items={[...row.shown, ...row.folded]} now={now} />
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
  if (isPending) {
    return (
      <Section title="Since you were here" className="mb-8">
        <Skeleton height={wide ? 112 : 168} />
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
      {wide ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-6 gap-y-6">
          {rows.map((row) => (
            <Category key={row.key} row={row} now={now} />
          ))}
        </div>
      ) : (
        <CompactBand rows={rows} now={now} />
      )}
    </Section>
  )
}
