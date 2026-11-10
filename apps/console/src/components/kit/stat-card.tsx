import { ArrowDownRightIcon, ArrowUpRightIcon, type Icon, MinusIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { CardLink, type CardLinkProps, isLinked, LINKED_CARD } from './card-link'
import { InfoHint, type InfoWord } from './info-hint'
import { MenuButton } from './menu-button'
import { MiniBars } from './mini-bars'
import { Sparkline } from './sparkline'
import { TONE_TEXT, TONE_TINT, type Tone } from './tone'

/** A footer pair; a `null` value is a dash with `note` as its reason. `hint` is the domain word its value carries an InfoHint for. */
export interface FooterPair {
  label: string
  value: string | null
  note?: string
  hint?: InfoWord
}

export interface StatCardProps extends CardLinkProps {
  icon: Icon
  title: string
  /** A domain word the title carries an InfoHint for, after the title (above a stretched link). */
  hint?: InfoWord
  /** Names the comparison: "Against the last 7 days". */
  subtitle: string
  /** The large figure; `null` is a value nobody counted, drawn as a dash with `valueNote` as the reason. */
  value: string | number | null
  /** Why the figure is a dash: its title, its screen-reader text, and the sub line when there is none. */
  valueNote?: string
  /** The change against the comparison: a number (signed by the pill) or a ready string. */
  delta?: {
    value: number | string
    higherIsBetter?: boolean
    /** Overrides the tone read from the sign (a KPI's tone comes from its target). */
    tone?: Tone
    /** Overrides the arrow read from the sign: 1 up, -1 down, 0 flat. */
    direction?: -1 | 0 | 1
  }
  /** One line under the figure. */
  sub?: string
  /** A line chart from props. */
  series?: { values: number[]; labels?: string[]; futureFrom?: number; target?: number }
  /** Bars from props, the last one in the accent. */
  bars?: number[]
  barLabels?: string[]
  /** Replaces the chart; `null` removes it. */
  chart?: ReactNode
  /** Start, now, end. The end one is dashed-underlined when the series runs into the future. */
  xLabels?: [string, string, string]
  /** Two key-value pairs on the shell surface. */
  footer?: [FooterPair, FooterPair]
  /** The ⋯ menu: a node, or a handler for a bare ⋯ button. Omitted: no button. */
  menu?: ReactNode
  onMenu?: () => void
  className?: string
}

/** The en dash an uncounted figure shows. */
const DASH = '–'

/** The tone of a delta: direction times `higherIsBetter`; neutral at 0, unknown or text. */
export function deltaTone(delta: StatCardProps['delta']): Tone {
  if (delta?.tone) return delta.tone
  if (!delta || typeof delta.value === 'string') {
    const sign = typeof delta?.value === 'string' ? Math.sign(Number.parseFloat(delta.value)) : 0
    return toneOf(sign, delta?.higherIsBetter)
  }
  return toneOf(Math.sign(delta.value), delta.higherIsBetter)
}

function toneOf(sign: number, higherIsBetter = true): Tone {
  if (!Number.isFinite(sign) || sign === 0) return 'neutral'
  return sign > 0 === higherIsBetter ? 'good' : 'bad'
}

function DeltaPill({ delta }: { delta: NonNullable<StatCardProps['delta']> }) {
  const tone = deltaTone(delta)
  const text = typeof delta.value === 'number' ? `${delta.value > 0 ? '+' : ''}${delta.value}` : delta.value
  const sign =
    delta.direction ??
    (typeof delta.value === 'number' ? Math.sign(delta.value) : Math.sign(Number.parseFloat(delta.value)))
  const Arrow = sign > 0 ? ArrowUpRightIcon : sign < 0 ? ArrowDownRightIcon : MinusIcon
  return (
    <span
      data-tone={tone}
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs font-medium tabular-nums',
        TONE_TINT[tone],
        TONE_TEXT[tone],
      )}
    >
      <Arrow className="size-3.5" weight="bold" aria-hidden="true" />
      {text}
    </span>
  )
}

/**
 * A figure with its trend. The shell (`bg-card`) holds the header and the footer; the body sits one surface step
 * below it, no border. With `href` or `as` the whole card is a link.
 */
export function StatCard({
  icon: CardIcon,
  title,
  hint,
  subtitle,
  value,
  valueNote,
  delta,
  sub,
  series,
  bars,
  barLabels,
  chart,
  xLabels,
  footer,
  menu,
  onMenu,
  href,
  as,
  className,
}: StatCardProps) {
  const linked = isLinked({ href, as })
  const picture =
    chart !== undefined ? (
      chart
    ) : series ? (
      <Sparkline {...series} name={title} />
    ) : bars ? (
      <MiniBars values={bars} labels={barLabels} name={title} />
    ) : null
  const uncounted = value === null
  const subLine = sub ?? (uncounted ? valueNote : undefined)
  const future = series?.futureFrom !== undefined
  /** The x of the end-of-past dot as a fraction of the plotted width (Sparkline pads 8 px each side). */
  const nowFraction =
    series?.futureFrom !== undefined && series.futureFrom > 1 && series.values.length > 1
      ? (Math.min(series.futureFrom, series.values.length) - 1) / (series.values.length - 1)
      : null
  return (
    <article
      className={cn(
        'group relative flex min-w-0 flex-col gap-1 rounded-xl bg-card p-1 text-card-foreground',
        // nothing to plot: the card is as tall as its figure and footer, not as its taller neighbour in a grid row
        picture === null && !xLabels && 'self-start',
        linked && LINKED_CARD,
        className,
      )}
      style={{ boxShadow: 'var(--vx-shadow-card)' }}
    >
      <header className="flex items-center gap-3 px-2.5 pt-2 pb-1">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <CardIcon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-0.5">
            <h3
              title={title}
              className="min-w-0 line-clamp-2 text-[length:var(--vx-text-md)] leading-tight font-semibold tracking-tight"
            >
              <CardLink href={href} as={as}>
                {title}
              </CardLink>
            </h3>
            {hint ? <InfoHint word={hint} className="relative z-10 -my-1" /> : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
        {menu ?? (onMenu ? <MenuButton onClick={onMenu} label={`${title} options`} /> : null)}
      </header>
      <div className="flex flex-1 flex-col gap-2 rounded-lg bg-background px-4 py-3.5">
        <div className="flex items-center gap-3">
          <span
            title={uncounted ? valueNote : undefined}
            className="text-[length:var(--vx-text-display)] leading-none font-semibold tracking-tight tabular-nums"
          >
            {uncounted ? (
              <>
                <span aria-hidden="true">{DASH}</span>
                {valueNote ? (
                  <span className="sr-only">{valueNote}</span>
                ) : (
                  <span className="sr-only">Not counted</span>
                )}
              </>
            ) : (
              value
            )}
          </span>
          {delta && !uncounted ? <DeltaPill delta={delta} /> : null}
        </div>
        {subLine ? <p className="text-[length:var(--vx-text-sm)] text-muted-foreground">{subLine}</p> : null}
        {picture}
        {xLabels ? (
          <div className="relative flex h-4 justify-between text-xs text-muted-foreground tabular-nums">
            <span>{xLabels[0]}</span>
            <span
              className={cn(nowFraction !== null && 'absolute -translate-x-1/2')}
              style={nowFraction === null ? undefined : { left: `calc(8px + ${nowFraction} * (100% - 16px))` }}
            >
              {xLabels[1]}
            </span>
            <span className={cn(future && 'underline decoration-dashed decoration-1 underline-offset-4')}>
              {xLabels[2]}
            </span>
          </div>
        ) : null}
      </div>
      {footer ? (
        <dl className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-2.5 pt-1.5 pb-2 text-[length:var(--vx-text-sm)]">
          {footer.map((pair) => (
            <div key={pair.label} className="flex min-w-0 items-baseline gap-2">
              <dt className="truncate text-muted-foreground">{pair.label}</dt>
              <dd
                title={pair.value === null ? pair.note : undefined}
                className="min-w-0 text-[length:var(--vx-text-md)] font-semibold tabular-nums"
              >
                {pair.value === null ? (
                  <>
                    <span aria-hidden="true">{DASH}</span>
                    <span className="sr-only">{pair.note ?? 'Not counted'}</span>
                  </>
                ) : (
                  pair.value
                )}
                {pair.hint ? <InfoHint word={pair.hint} className="relative z-10 -my-1 ml-0.5 align-middle" /> : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </article>
  )
}
