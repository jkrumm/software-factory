import { Skeleton } from '@/components/kit/skeleton'
import { cn } from '@/lib/utils'

/**
 * The screens at their final size while their data loads, built from the kit's `Skeleton`: the heights are the real
 * screens' at 1800 wide (a collapsed Needs-you card, a StatCard, a chart, the artifact's two columns), so nothing jumps
 * when the content arrives. Each is `aria-busy` and named for a screen reader.
 */

const busy = (label: string) => ({ 'aria-busy': true as const, 'aria-label': label })

/** The checkpoints below the "Since you were here" band: a kind with its cards (a Decision's is 98 px with its answer line), then one whose cards are a title and a line (72 px). */
export function NeedsSkeleton() {
  return (
    <div {...busy('Loading what needs you')} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-8">
      {[
        { cards: 3, height: 98 },
        { cards: 3, height: 72 },
      ].map(({ cards, height }, group) => (
        <div key={group} className="grid gap-3">
          <Skeleton height={20} width={96} />
          {Array.from({ length: cards }, (_, card) => (
            <Skeleton key={card} height={height} rounded="rounded-xl" />
          ))}
        </div>
      ))}
    </div>
  )
}

/** What an open card holds while its Decision, artifact or Errand loads. */
export function CardBodySkeleton() {
  return (
    <div {...busy('Loading this card')} className="grid gap-4">
      <div className="grid gap-2">
        <Skeleton height={12} width={72} />
        <Skeleton height={22} width="55%" />
        <Skeleton height={32} width={152} />
      </div>
      <Skeleton height={44} />
      <Skeleton height={96} />
    </div>
  )
}

/** The stat row and the trend chart: four StatCards, then the chart's frame. */
export function FlowSkeleton() {
  return (
    <div {...busy('Loading the flow')} className="flex flex-col">
      <div className="mb-4 grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} height={273} rounded="rounded-xl" className={cn(i > 0 && 'hidden lg:block')} />
        ))}
      </div>
      <Skeleton height={330} rounded="rounded-xl" />
    </div>
  )
}

/** The graph's canvas and the schedule's heading and panel under it. */
export function ChainSkeleton() {
  return (
    <div {...busy('Loading the chain')} className="flex min-h-[28rem] flex-1 flex-col gap-4">
      <Skeleton height={32} className="md:hidden" />
      <Skeleton height="100%" rounded="rounded-xl" className="min-h-[30rem] flex-1" />
      <div className="hidden gap-3 pt-4 lg:grid">
        <Skeleton height={20} width={96} />
        <Skeleton height={199} rounded="rounded-xl" />
      </div>
    </div>
  )
}

/** The target tiles and the first bands of cards (the first row of Quality is 290 px, the rest 272 and 273). */
export function ImproveSkeleton() {
  return (
    <div {...busy('Loading the key figures')} className="grid gap-10">
      <div className="grid gap-7">
        <Skeleton height={20} width={120} />
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {Array.from({ length: 5 }, (_, tile) => (
            <Skeleton key={tile} height={136} rounded="rounded-xl" className={cn(tile > 0 && 'hidden sm:block')} />
          ))}
        </div>
      </div>
      {[
        { title: 88, heights: [290, 272] },
        { title: 120, heights: [273] },
      ].map(({ title, heights }, band) => (
        <div key={band} className="grid gap-7">
          <Skeleton height={20} width={title} />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {heights.flatMap((height, row) =>
              Array.from({ length: 4 }, (_, card) => (
                <Skeleton
                  key={`${row}-${card}`}
                  height={height}
                  rounded="rounded-xl"
                  className={cn(card > 1 && 'hidden sm:block')}
                />
              )),
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

/** The Throughput page: the stat row, then the class table, the three charts and a table (a StatCard is 273 px, a chart card about 160). */
export function ThroughputSkeleton() {
  return (
    <div {...busy('Loading the throughput figures')} className="grid gap-8">
      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, card) => (
          <Skeleton key={card} height={300} rounded="rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4">
        <Skeleton height={20} width={120} />
        {Array.from({ length: 5 }, (_, row) => (
          <Skeleton key={row} height={36} rounded="rounded-md" />
        ))}
      </div>
    </div>
  )
}

/** The artifact page: its header band, the document column and the 24 rem comments panel with its composer slot. */
export function ArtifactSkeleton() {
  return (
    <div
      {...busy('Loading the artifact')}
      className="grid w-full lg:h-full lg:min-h-[40rem] lg:grid-cols-[minmax(0,1fr)_24rem]"
    >
      <div className="flex min-w-0 flex-col">
        <div className="flex flex-col gap-3 border-b px-4 pt-5 pb-4 md:px-8">
          <Skeleton height={18} width={260} />
          <Skeleton height={28} width="55%" />
          <Skeleton height={20} width={320} />
        </div>
        <div className="mx-auto flex w-full max-w-[48.25rem] flex-col gap-4 px-4 py-6 md:px-8 md:py-8">
          <Skeleton height={32} width="70%" />
          <Skeleton height={16} />
          <Skeleton height={16} />
          <Skeleton height={16} width="85%" />
          <Skeleton height={24} width="40%" className="mt-4" />
          <Skeleton height={16} />
          <Skeleton height={16} width="92%" />
          <Skeleton height={180} rounded="rounded-xl" />
        </div>
      </div>
      <div className="hidden flex-col gap-3 bg-card p-4 pb-12 lg:flex">
        <Skeleton height={20} width={120} className="bg-foreground/12" />
        <Skeleton height={12} width={200} className="bg-foreground/12" />
        {Array.from({ length: 4 }, (_, card) => (
          <Skeleton key={card} height={133} rounded="rounded-xl" className="bg-foreground/12" />
        ))}
        <Skeleton height={46} rounded="rounded-xl" className="mt-auto bg-foreground/12" />
      </div>
    </div>
  )
}

/** A project's page while its page loads: the tabs, the health band and the three columns of the first screen. */
export function ProjectSkeleton() {
  return (
    <div {...busy('Loading the project')} className="grid gap-8">
      <Skeleton height={32} width={420} />
      <div className="grid gap-3 min-[40rem]:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} height={68} rounded="rounded-xl" className={cn(i > 0 && 'hidden min-[40rem]:block')} />
        ))}
      </div>
      <div className="grid gap-8 xl:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} height={420} rounded="rounded-xl" className={cn(i > 0 && 'hidden xl:block')} />
        ))}
      </div>
    </div>
  )
}

/** One tab of a project while its own data loads. */
export function ProjectTabSkeleton() {
  return (
    <div {...busy('Loading this tab')} className="grid gap-4">
      <Skeleton height={20} width={160} />
      <Skeleton height={360} rounded="rounded-xl" />
    </div>
  )
}

/** The project list: a grid of project cards. */
export function ProjectIndexSkeleton() {
  return (
    <div {...busy('Loading the projects')} className="grid gap-3">
      <Skeleton height={32} rounded="rounded-lg" />
      <Skeleton height={940} rounded="rounded-xl" />
    </div>
  )
}
