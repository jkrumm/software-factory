import { Skeleton } from '@/components/kit/skeleton'

/** The page at its final size: header, then the main column and the aside. */
export function IssueSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the Issue" className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Skeleton height={20} width={280} />
        <Skeleton height={28} width="60%" />
        <Skeleton height={36} width="45%" />
        <Skeleton height={44} className="mt-2" />
      </div>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-6">
          <Skeleton height={32} />
          <Skeleton height={120} />
          <Skeleton height={220} />
        </div>
        <div className="flex flex-col gap-6">
          <Skeleton height={320} />
          <Skeleton height={140} />
        </div>
      </div>
    </div>
  )
}
