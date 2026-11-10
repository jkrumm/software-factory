import { BugIcon, FileTextIcon, type Icon, SirenIcon, SparkleIcon, WrenchIcon } from '@phosphor-icons/react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export const ISSUE_KINDS = ['feature', 'bug', 'incident', 'chore', 'docs'] as const

/** What an Issue is (`docs/language.md` Kind). */
export type IssueKind = (typeof ISSUE_KINDS)[number]

export const KIND_ICON: Record<IssueKind, Icon> = {
  feature: SparkleIcon,
  bug: BugIcon,
  incident: SirenIcon,
  chore: WrenchIcon,
  docs: FileTextIcon,
}

export interface KindBadgeProps {
  kind: IssueKind
  className?: string
}

/** The Issue's kind as an outline badge with its icon. */
export function KindBadge({ kind, className }: KindBadgeProps) {
  const KindIcon = KIND_ICON[kind]
  return (
    <Badge variant="outline" className={className}>
      <KindIcon aria-hidden="true" />
      {kind.charAt(0).toUpperCase()}
      {kind.slice(1)}
    </Badge>
  )
}

/** The Issue's kind as its icon alone: the name is its accessible name and its tooltip. */
export function KindIcon({ kind, className }: KindBadgeProps) {
  const Glyph = KIND_ICON[kind]
  const name = kind.charAt(0).toUpperCase() + kind.slice(1)
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      className={cn('inline-grid size-5 shrink-0 place-items-center text-foreground/80', className)}
    >
      <Glyph className="size-4" aria-hidden="true" />
    </span>
  )
}
