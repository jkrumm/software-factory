import { type Icon, TrayIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface EmptyStateProps {
  /** The one sentence. */
  title: string
  /** A quieter line under it. */
  children?: ReactNode
  icon?: Icon
  /** A control under the text, such as a retry button. */
  action?: ReactNode
  className?: string
}

/** One sentence and an icon tile; no dashed box. */
export function EmptyState({ title, children, icon: StateIcon = TrayIcon, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-6 py-12 text-center', className)}>
      <span className="grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground">
        <StateIcon className="size-5" aria-hidden="true" />
      </span>
      <p className="text-[length:var(--vx-text-md)] font-medium">{title}</p>
      {children ? (
        <p className="max-w-prose text-[length:var(--vx-text-sm)] text-muted-foreground">{children}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}
