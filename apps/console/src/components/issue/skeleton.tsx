import { Skeleton } from '@/components/kit/skeleton'

/** The page at its final size: the header and its facts, then the tabs and the main column beside the aside. */
export function IssueSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the Issue" className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Skeleton height={20} width={280} />
        <Skeleton height={28} width="60%" />
        <Skeleton height={20} width="40%" />
        <Skeleton height={20} width={200} />
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4 pt-1 sm:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, cell) => (
            <div key={cell} className="grid gap-2">
              <Skeleton height={12} width="40%" />
              <Skeleton height={16} width="70%" />
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-6">
          <Skeleton height={32} width={380} className="max-w-full" />
          <Skeleton height={20} width="30%" />
          <Skeleton height={30} />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, card) => (
              <Skeleton
                key={card}
                height={244}
                rounded="rounded-xl"
                className={card > 1 ? 'hidden sm:block' : undefined}
              />
            ))}
          </div>
          <Skeleton height={160} />
        </div>
        <div className="flex flex-col gap-12">
          <Skeleton height={432} />
          <Skeleton height={90} />
        </div>
      </div>
    </div>
  )
}
