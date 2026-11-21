import type { ComponentProps } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * One verdict button: the word on it, what it does to the lead in its tooltip and, for a screen reader, as its description.
 * The wrapper takes the hover so a disabled button still shows it; nothing is printed under the button.
 */
export function VerdictButton({
  id,
  consequence,
  children,
  ...props
}: { id: string; consequence: string } & Omit<ComponentProps<typeof Button>, 'id' | 'aria-describedby'>) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex" />}>
        <Button {...props} aria-describedby={id} className="w-full">
          {children}
        </Button>
        <span id={id} className="sr-only">
          {consequence}
        </span>
      </TooltipTrigger>
      <TooltipContent>{consequence}</TooltipContent>
    </Tooltip>
  )
}
