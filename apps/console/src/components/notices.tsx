import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ageWords } from '@/lib/age'
import { useConnection } from '@/lib/connection'
import { updateNow, useUpdatePhase } from '@/lib/update'

/**
 * The two things the Console says above the screen, and only when they are true: a new version that has not taken for two
 * minutes (one button), and a screen whose own data is older than it polls for. The strip's readings are the Live
 * popover's business; both lines hold no height when there is nothing to say.
 */
export function Notices() {
  const phase = useUpdatePhase()
  const { stale } = useConnection()
  const [pressed, setPressed] = useState(false)
  const screen = stale.filter((read) => !read.strip)
  const oldest = screen[0]
  return (
    <>
      {phase === 'stuck' ? (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-3 border-b bg-muted px-4 py-1.5 text-sm md:px-8"
          data-testid="update-notice"
        >
          <span className="min-w-0 flex-1">A new version of the Console is ready but has not taken over.</span>
          <Button
            size="sm"
            variant="outline"
            disabled={pressed}
            onClick={() => {
              setPressed(true)
              void updateNow()
            }}
          >
            Update now
          </Button>
        </div>
      ) : null}
      {oldest ? (
        <p
          role="status"
          className="shrink-0 border-b bg-muted px-4 py-1 text-xs text-muted-foreground md:px-8"
          data-testid="stale-notice"
        >
          This screen shows data from {ageWords(oldest.ageMs)} ({oldest.label}).
        </p>
      ) : null}
    </>
  )
}
