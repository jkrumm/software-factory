import type { ReactNode } from 'react'
import { useId } from 'react'
import { cn } from '@/lib/utils'
import { InfoHint, type InfoHintProps } from './info-hint'

export interface SectionProps {
  title: string
  /** A domain word whose definition sits beside the heading. */
  hint?: InfoHintProps['word']
  /** Right of the heading (a count, a link). */
  aside?: ReactNode
  /** The heading's level; default 2. */
  level?: 2 | 3
  children: ReactNode
  className?: string
}

/** A heading, a hairline rule and space; never a box. The heading names the region. */
export function Section({ title, hint, aside, level = 2, children, className }: SectionProps) {
  const id = useId()
  const Heading = level === 2 ? 'h2' : 'h3'
  return (
    <section aria-labelledby={id} className={cn('min-w-0', className)}>
      <div className="flex items-center gap-2 border-b pb-2">
        <Heading id={id} className="text-[length:var(--vx-text-md)] font-semibold tracking-tight">
          {title}
        </Heading>
        {hint ? <InfoHint word={hint} /> : null}
        {aside ? <div className="ml-auto text-[length:var(--vx-text-sm)] text-muted-foreground">{aside}</div> : null}
      </div>
      <div className="pt-4">{children}</div>
    </section>
  )
}
