import type { DecisionView, SpecHead } from '@software-factory/contract'
import { DECISION_CLASS_WORDS } from '@software-factory/contract'
import { type ReactNode, useState } from 'react'
import { Fold, InfoHint, Lozenge } from '@/components/kit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { DECISION_CLASS_LABEL, optionIndex, silenceWords } from '@/lib/needs'
import { cn } from '@/lib/utils'
import { ExhibitFigure } from './exhibit'

const LABEL = 'text-xs font-medium tracking-wide text-muted-foreground uppercase'

export interface DecisionCaseProps {
  data: DecisionView
  /** false once it is answered: the options stay, the buttons go */
  open: boolean
  disabled: boolean
  error: string | null
  now: number
  /** the Build and Decided of the Spec the question belongs to, once read */
  spec: SpecHead | null
  /** what waits behind this answer: the Issues and rows it holds, as words, and what happens with no answer */
  behind: readonly string[]
  /** the option he chose, with his note */
  onAnswer: (answer: string, note: string) => void
}

const Prose = ({ children }: { children: ReactNode }) => (
  <p className="text-sm [overflow-wrap:anywhere] whitespace-pre-wrap">{children}</p>
)

/**
 * A Decision as a case: the question, why it is the owner's, the exhibit that shows the change, and the options as buttons
 * that each say what they lead to. What the lead checked, the Spec's Build and Decided, what each choice costs later and what
 * waits behind the answer are folds, closed: the card above them is what he reads and answers from. A Decision asked before
 * the form had a class, an exhibit or a leads-to shows the old fields in their place.
 */
export function DecisionCase({ data, open, disabled, error, now, spec, behind, onAnswer }: DecisionCaseProps) {
  const [note, setNote] = useState('')
  const [own, setOwn] = useState('')
  const recommended = optionIndex(data.options, data.recommendation)
  const silent = data.defaultAt && data.noAnswer.default ? optionIndex(data.options, data.noAnswer.default) : -1
  return (
    <div className="grid gap-5" data-decision-case>
      <div data-above-folds className="grid gap-5">
        <div className="grid gap-2">
          <h3 className="font-heading text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">
            {data.question}
          </h3>
          {data.class ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <span title={DECISION_CLASS_WORDS[data.class]} className="inline-flex items-center gap-1">
                <Lozenge tone="accent">{DECISION_CLASS_LABEL[data.class]}</Lozenge>
                <InfoHint word="decision" />
              </span>
              {data.whyYours ? <span className="[overflow-wrap:anywhere]">{data.whyYours}</span> : null}
            </p>
          ) : null}
        </div>
        {data.exhibit ? <ExhibitFigure exhibit={data.exhibit} /> : null}
        <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3">
          {data.options.map((option, index) => {
            const isRecommended = index === recommended
            return (
              <li
                key={option.label}
                data-recommended={isRecommended}
                className={cn(
                  'flex flex-col gap-2.5 rounded-xl p-4',
                  isRecommended ? 'bg-primary/8 ring-1 ring-primary/40' : 'bg-muted/40',
                )}
              >
                {isRecommended || !option.reversible || index === silent ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {isRecommended ? <Lozenge tone="accent">Recommended</Lozenge> : null}
                    {!option.reversible ? <Lozenge state="paused">Cannot be undone</Lozenge> : null}
                    {index === silent && data.defaultAt ? (
                      <span className="text-xs text-muted-foreground">{silenceWords(data.defaultAt, now)}</span>
                    ) : null}
                  </div>
                ) : null}
                {open ? (
                  <Button
                    className="h-auto justify-start py-2 text-left whitespace-normal"
                    variant={isRecommended ? 'default' : 'outline'}
                    disabled={disabled}
                    title={`Changing it later: ${option.cost}`}
                    onClick={() => onAnswer(option.label, note.trim())}
                  >
                    {option.label}
                  </Button>
                ) : (
                  <p className="text-base font-semibold [overflow-wrap:anywhere]">{option.label}</p>
                )}
                <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  {option.leadsTo ?? option.cost}
                </p>
              </li>
            )
          })}
        </ul>
        {open ? (
          <Input
            aria-label="A note for the lead, sent with your choice"
            placeholder="A note for the lead (optional)"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        ) : null}
      </div>
      <div data-folds className="grid gap-1">
        <Fold title="What the lead checked">
          <Prose>{data.checked}</Prose>
        </Fold>
        {data.spec ? (
          <Fold title="The Spec: Build and Decided">
            {spec?.build || spec?.decided ? (
              <div className="grid gap-3">
                {spec.build ? (
                  <section className="grid gap-1">
                    <h4 className={LABEL}>Build</h4>
                    <Prose>{spec.build}</Prose>
                  </section>
                ) : null}
                {spec.decided ? (
                  <section className="grid gap-1">
                    <h4 className={LABEL}>Decided</h4>
                    <Prose>{spec.decided}</Prose>
                  </section>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">The Spec has no Build or Decided section to show.</p>
            )}
          </Fold>
        ) : null}
        <Fold title="What each choice costs later">
          <ul className="grid gap-1.5 text-sm">
            {data.options.map((option) => (
              <li key={option.label} className="[overflow-wrap:anywhere]">
                <span className="font-semibold">{option.label}</span>: {option.cost}
              </li>
            ))}
          </ul>
        </Fold>
        <Fold title="What waits behind this answer">
          <div className="grid gap-1.5 text-sm">
            {behind.map((line) => (
              <p key={line} className="[overflow-wrap:anywhere]">
                {line}
              </p>
            ))}
          </div>
        </Fold>
        {open ? (
          <Fold title="Answer in your own words">
            <form
              className="grid gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (own.trim()) onAnswer(own.trim(), note.trim())
              }}
            >
              <Textarea
                aria-label="Your own answer"
                placeholder="The lead reads your words as the answer and goes on"
                value={own}
                onChange={(event) => setOwn(event.target.value)}
              />
              <Button
                className="justify-self-start"
                type="submit"
                variant="secondary"
                disabled={disabled || !own.trim()}
              >
                Send answer
              </Button>
            </form>
          </Fold>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
