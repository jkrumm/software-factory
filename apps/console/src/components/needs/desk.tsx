import type { NeedItem } from '@software-factory/contract'
import { CheckIcon, CopyIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { Section } from '@/components/kit'
import { Button } from '@/components/ui/button'
import { finishErrand } from '@/lib/api'
import { agoWords, deskGroups } from '@/lib/needs'
import { plainExcerpt } from '@/lib/plain'
import { useSettle } from '@/lib/settle'

const SETTLED = 'Already settled elsewhere'

/** The command to copy: one block, and a button that puts it on the clipboard and says so. */
function Command({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-2">
      <code className="min-w-0 flex-1 font-mono text-sm [overflow-wrap:anywhere] whitespace-pre-wrap">{command}</code>
      <Button type="button" variant="outline" size="sm" onClick={copy} aria-label="Copy the command">
        {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

/** One Errand at the desk: what to do, the command to copy, and the two ways to close it. */
function DeskItem({ item, onSent }: { item: NeedItem; onSent: (message: string) => void }) {
  const keys = [['needs'], ['errands']]
  const done = useSettle<void>({
    send: () => finishErrand(item.id, ''),
    keys,
    onSent: () => onSent('Marked done'),
    onConflict: () => onSent(SETTLED),
  })
  const needless = useSettle<void>({
    send: () => finishErrand(item.id, '', 'not_needed'),
    keys,
    onSent: () => onSent('Marked not needed'),
    onConflict: () => onSent(SETTLED),
  })
  const error = done.error ?? needless.error
  const summary = plainExcerpt(item.summary)
  return (
    <article className="grid gap-3 rounded-xl border bg-card p-4" aria-label={item.title}>
      <div className="grid gap-1">
        <h3 className="text-base font-medium [overflow-wrap:anywhere]">{item.title}</h3>
        {summary && summary !== item.title ? (
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere] whitespace-pre-wrap">{summary}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {[item.repo ?? item.source, `raised ${agoWords(item.ageMs)}`].filter(Boolean).join(' · ')}
        </p>
      </div>
      {item.tried ? <p className="text-sm text-destructive [overflow-wrap:anywhere]">{item.tried}</p> : null}
      {item.command ? <Command command={item.command} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={done.disabled || needless.disabled} onClick={() => done.send()}>
          Done
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={done.disabled || needless.disabled}
          onClick={() => needless.send()}
        >
          Not needed
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </article>
  )
}

/**
 * Back at desk: the open Errands grouped by what the owner must physically do (the MacBook, the iPhone, a portal), each
 * with its command to copy and the buttons to close it. The same Errands the list shows, laid out to be worked through.
 */
export function Desk({ items, onSent }: { items: readonly NeedItem[]; onSent: (message: string) => void }) {
  const groups = deskGroups(items)
  return (
    <div className="grid min-w-0 gap-8">
      {groups.map((group) => (
        <Section key={group.host} title={`${group.label} (${group.items.length})`}>
          <div className="grid min-w-0 gap-3">
            {group.items.map((item) => (
              <DeskItem key={item.id} item={item} onSent={onSent} />
            ))}
          </div>
        </Section>
      ))}
    </div>
  )
}
