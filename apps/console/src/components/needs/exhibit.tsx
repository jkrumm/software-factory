import { render } from 'pele'
import type { Exhibit } from '@software-factory/contract'
import { cn } from '@/lib/utils'

/**
 * A Mermaid figure drawn by Pele, the renderer `apps/console/scripts/diagram.ts` uses for an artifact; its variables follow the
 * tokens (the `.pele` rule in `styles/`), so the theme re-colours it. The source comes from a lead and Pele escapes its labels;
 * the drawing is still refused when it holds anything that runs, and the source is shown instead.
 */
const RUNS = /<script|<foreignObject|<iframe|<object|<embed|\son[a-z]+\s*=|javascript:|data:text\/html/i

function drawn(mermaid: string): string | null {
  try {
    const svg = render(mermaid).svg.replace(/^<svg xmlns="[^"]*"/, '<svg')
    return RUNS.test(svg) ? null : svg
  } catch {
    return null
  }
}

const PANEL = 'grid content-start gap-2 rounded-xl bg-muted/40 p-4'
const LABEL = 'text-xs font-medium tracking-wide text-muted-foreground uppercase'

function Lines({ label, lines }: { label: string; lines: readonly string[] }) {
  return (
    <div className={PANEL}>
      <h4 className={LABEL}>{label}</h4>
      <ul className="grid gap-1 text-sm">
        {lines.map((line) => (
          <li key={line} className="[overflow-wrap:anywhere]">
            {line}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The change shown, not narrated: before and after, one picture per option, a diagram, a table or numbers. The same figure
 * is on the card, in the Spec's comparison and in the kit.
 */
export function ExhibitFigure({ exhibit, className }: { exhibit: Exhibit; className?: string }) {
  switch (exhibit.kind) {
    case 'before_after':
      return (
        <div data-exhibit="before_after" className={cn('grid gap-3 sm:grid-cols-2', className)}>
          <Lines label="Today" lines={exhibit.today} />
          <Lines label="After" lines={exhibit.after} />
        </div>
      )
    case 'pictures':
      return (
        <div
          data-exhibit="pictures"
          className={cn('grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3', className)}
        >
          {exhibit.pictures.map((picture) => (
            <figure key={picture.option} className="grid gap-1.5">
              <img
                src={picture.image}
                alt={picture.option}
                loading="lazy"
                className="aspect-[4/3] w-full rounded-xl bg-muted/40 object-cover object-top"
              />
              <figcaption className="text-sm font-medium">{picture.option}</figcaption>
            </figure>
          ))}
        </div>
      )
    case 'diagram': {
      const svg = drawn(exhibit.mermaid)
      return (
        <figure data-exhibit="diagram" className={cn('grid gap-1.5', className)}>
          {svg === null ? (
            <pre className="max-h-64 overflow-auto rounded-xl bg-muted/40 p-4 text-xs whitespace-pre-wrap">
              {exhibit.mermaid}
            </pre>
          ) : (
            <div
              role="img"
              aria-label={exhibit.caption}
              className="pele overflow-x-auto rounded-xl bg-muted/40 p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
              // Pele's own drawing, refused above when it holds anything that runs
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          )}
          <figcaption className="text-sm text-muted-foreground">{exhibit.caption}</figcaption>
        </figure>
      )
    }
    case 'table':
      return (
        <div data-exhibit="table" className={cn('overflow-x-auto rounded-xl bg-muted/40', className)}>
          <table className="w-full min-w-max text-left text-sm">
            <thead>
              <tr className="text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-medium">
                  <span className="sr-only">Option</span>
                </th>
                {exhibit.criteria.map((criterion) => (
                  <th key={criterion} scope="col" className="px-4 py-2 text-xs font-medium tracking-wide uppercase">
                    {criterion}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {exhibit.rows.map((row) => (
                <tr key={row.option} className="border-t border-border/40">
                  <th scope="row" className="px-4 py-2 font-semibold">
                    {row.option}
                  </th>
                  {row.cells.map((cell, index) => (
                    <td key={exhibit.criteria[index] ?? index} className="px-4 py-2 [overflow-wrap:anywhere]">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'numbers':
      return (
        <dl
          data-exhibit="numbers"
          className={cn('grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3', className)}
        >
          {exhibit.figures.map((figure) => (
            <div key={figure.label} className={PANEL}>
              <dt className={LABEL}>{figure.label}</dt>
              <dd className="flex items-baseline gap-1.5">
                <span className="font-heading text-2xl font-semibold tabular-nums">{figure.value}</span>
                <span className="text-sm text-muted-foreground">{figure.unit}</span>
              </dd>
            </div>
          ))}
        </dl>
      )
  }
}
