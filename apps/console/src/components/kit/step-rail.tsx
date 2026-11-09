import { CircleIcon, type Icon, WarningCircleIcon } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'

export interface Step {
  id: string
  /** Default: a circle, or a warning for a failed step. */
  icon?: Icon
  label: string
  /** The time as the screen reads it ("14:02:11"); shown on the right in mono. */
  at: string
  durationMs?: number
  failed?: boolean
  /** The failure's line, shown beneath a failed step. */
  detail?: string
}

export interface StepRailProps {
  steps: Step[]
  className?: string
}

/** "850 ms", "4.2 s", "3 min" */
export function durationWords(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.round(ms / 60_000)} min`
}

/** One row per step: icon, words, a duration bar scaled to the longest, time on the right. A failure is in the destructive text colour with its line. */
export function StepRail({ steps, className }: StepRailProps) {
  const longest = Math.max(1, ...steps.map((step) => step.durationMs ?? 0))
  return (
    <ol className={cn('flex flex-col', className)}>
      {steps.map((step) => {
        const StepIcon = step.icon ?? (step.failed ? WarningCircleIcon : CircleIcon)
        return (
          <li key={step.id} className="not-first:border-t py-2">
            <div
              className={cn(
                'flex items-center gap-3 text-[length:var(--vx-text-sm)]',
                step.failed && 'text-destructive',
              )}
            >
              <StepIcon className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-medium">{step.label}</span>
              {step.durationMs === undefined ? null : (
                <span className="hidden w-64 shrink-0 items-center gap-2 min-[40rem]:flex">
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <span
                      className={cn(
                        'block h-full rounded-full',
                        step.failed ? 'bg-destructive' : 'bg-muted-foreground',
                      )}
                      style={{ width: `${Math.max(2, (step.durationMs / longest) * 100)}%` }}
                    />
                  </span>
                  <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums">
                    {durationWords(step.durationMs)}
                  </span>
                </span>
              )}
              <span className="w-[5.5rem] shrink-0 text-right font-mono text-xs tabular-nums">{step.at}</span>
            </div>
            {step.failed && step.detail ? (
              <p className="mt-1 pl-7 text-[length:var(--vx-text-sm)] text-destructive">{step.detail}</p>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
