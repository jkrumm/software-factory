import { Badge } from '@/components/ui/badge'
import { useConnection } from '@/lib/connection'
import { cn } from '@/lib/utils'

export function ConnectionChip() {
  const { label, offline, live } = useConnection()
  return (
    <Badge variant="outline" className="gap-1.5" role="status" aria-live="polite">
      <span
        aria-hidden="true"
        className={cn('size-2 rounded-full', offline ? 'bg-destructive' : live ? 'bg-good' : 'bg-warn')}
      />
      {label}
    </Badge>
  )
}
