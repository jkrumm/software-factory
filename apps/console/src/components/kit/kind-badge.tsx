import { BugIcon, FileTextIcon, type Icon, SirenIcon, SparkleIcon, WrenchIcon } from '@phosphor-icons/react'
import { Badge } from '@/components/ui/badge'

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
